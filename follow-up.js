/**
 * @module follow-up
 * @description Automated follow-up scheduling for Clara.
 *
 * Handles:
 * - Creating auto-follow-up rules ("follow up if no reply in 3 days")
 * - Checking pending follow-ups against thread activity
 * - Generating context-aware follow-up emails via Claude
 * - Persistent storage of follow-up queue
 *
 * All functions receive a shared `ctx` context object.
 */

const fs = require("fs");
const path = require("path");
const cryptoStore = require("./crypto-store");

let followUps = [];
let FOLLOWUPS_FILE = null;

function init(ctx) {
  const dataDir = fs.existsSync("/var/data") ? "/var/data" : ".";
  FOLLOWUPS_FILE = path.join(dataDir, "follow_ups.json");
  try {
    followUps = cryptoStore.readEncrypted(FOLLOWUPS_FILE, []);
  } catch (e) {
    console.warn(`[FOLLOW-UP] Could not load follow-ups: ${e.message}`);
    followUps = [];
  }
  // Purge expired/completed follow-ups
  const now = Date.now();
  const before = followUps.length;
  followUps = followUps.filter(f => f.status === "pending" && new Date(f.checkAfter).getTime() > now - 30 * 24 * 60 * 60 * 1000);
  if (followUps.length !== before) save();
  ctx.addLog(`📬 ${followUps.length} pending follow-up(s) loaded`, "info");
}

function save() {
  if (!FOLLOWUPS_FILE) return;
  try {
    cryptoStore.atomicWriteEncryptedSync(FOLLOWUPS_FILE, followUps);
  } catch (e) { console.error(`[FOLLOW-UP] Save failed: ${e.message}`); }
}

/**
 * Schedule a follow-up: if no reply from `email` within `delayDays`, send a reminder.
 */
function schedule({ email, name, subject, threadId, delayDays = 3, context = "", ownerEmail }) {
  if (!email) throw new Error("Follow-up requires email");

  // Don't create duplicates for the same email + thread
  const existing = followUps.find(f => f.email === email.toLowerCase() && f.threadId === threadId && f.status === "pending");
  if (existing) return existing;

  const id = `fu_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
  const followUp = {
    id,
    email: email.toLowerCase(),
    name: name || email.split("@")[0],
    subject: subject || "",
    threadId: threadId || null,
    context: (context || "").slice(0, 2000),
    delayDays,
    checkAfter: new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
    status: "pending", // pending → sent | cancelled | replied
    ownerEmail: ownerEmail || null,
    attempts: 0,
    maxAttempts: 2, // follow up max 2 times then give up
  };
  followUps.push(followUp);
  if (followUps.length > 500) followUps.shift(); // cap
  save();
  return followUp;
}

/**
 * Cancel a follow-up (e.g. because the person replied).
 */
function cancel(email, threadId) {
  let cancelled = 0;
  for (const f of followUps) {
    if (f.status !== "pending") continue;
    if (f.email === email.toLowerCase() || (threadId && f.threadId === threadId)) {
      f.status = "cancelled";
      f.cancelledAt = new Date().toISOString();
      cancelled++;
    }
  }
  if (cancelled) save();
  return cancelled;
}

/**
 * Mark follow-ups as replied for this email (called when we detect an inbound reply).
 */
function markReplied(email) {
  return cancel(email, null);
}

/**
 * Check all pending follow-ups and return those that are due.
 * Does NOT send emails — the caller (server.js) handles sending.
 */
async function checkDue(ctx) {
  const now = Date.now();
  const due = [];

  for (const f of followUps) {
    if (f.status !== "pending") continue;
    if (new Date(f.checkAfter).getTime() > now) continue;
    if (f.attempts >= f.maxAttempts) {
      f.status = "exhausted";
      ctx.addLog(`📬 Follow-up exhausted (${f.maxAttempts} attempts): ${f.name} (${f.email})`, "info");
      continue;
    }

    // Check if they've replied since the follow-up was created
    const profile = ctx.profiles[f.email];
    if (profile?.lastContact) {
      const lastContactTime = new Date(profile.lastContact).getTime();
      if (lastContactTime > new Date(f.createdAt).getTime()) {
        // They've been in touch since we created the follow-up — auto-cancel
        f.status = "replied";
        f.cancelledAt = new Date().toISOString();
        ctx.addLog(`📬 Follow-up auto-cancelled (activity detected): ${f.name}`, "info");
        continue;
      }
    }

    due.push(f);
  }

  save();
  return due;
}

/**
 * Generate a follow-up email body using Claude with thread context.
 */
async function generateFollowUpEmail(ctx, followUp) {
  const profile = ctx.profiles[followUp.email];
  const profileHint = profile ? `Known: ${profile.name}, ${profile.company || "unknown company"}, ${profile.role || "unknown role"}. Language: ${profile.language || "English"}.` : "";
  const lang = profile?.language || "English";

  const body = await ctx.askClaude(
    `${ctx.SNIPPET_DRAFT}\n\n` +
    `You are writing a polite follow-up email to ${followUp.name} (${followUp.email}). ${profileHint}\n\n` +
    `Original subject: "${followUp.subject}"\n` +
    `Context: ${ctx.wrapUntrusted(followUp.context.slice(0, 1000))}\n\n` +
    `This is attempt ${followUp.attempts + 1}. ` +
    (followUp.attempts === 0
      ? `Write a warm, natural follow-up. Don't say "just following up" — be specific about what you're waiting for.`
      : `This is a second follow-up. Be slightly more direct but still professional. Mention you understand they may be busy.`) +
    `\n\nOpening: Dear ${followUp.name.split(/\s+/)[0]},\nClosing: ${ctx.CLARA_SIGNATURE}\nWrite in ${lang}. Email body only.`,
    400, 1, ctx.MODEL_FAST
  );

  return body;
}

/**
 * Mark a follow-up as sent (called after the email goes out).
 */
function markSent(followUpId) {
  const f = followUps.find(fu => fu.id === followUpId);
  if (!f) return;
  f.attempts++;
  if (f.attempts >= f.maxAttempts) {
    f.status = "exhausted";
  } else {
    // Schedule next follow-up attempt
    f.checkAfter = new Date(Date.now() + f.delayDays * 24 * 60 * 60 * 1000).toISOString();
  }
  f.lastSentAt = new Date().toISOString();
  save();
}

function list() {
  return followUps.filter(f => f.status === "pending");
}

function listAll() {
  return followUps;
}

module.exports = {
  init,
  schedule,
  cancel,
  markReplied,
  checkDue,
  generateFollowUpEmail,
  markSent,
  list,
  listAll,
};
