/**
 * @module crm-engine
 * @description CRM and contact profile management for Clara.
 *
 * Handles:
 * - Profile loading, saving, and enrichment via Claude
 * - Sentiment scoring (warmth, engagement, interest)
 * - Investment data extraction and storage
 * - Deal pipeline management and stage advancement
 * - Contact resolution (name → email via Gmail history)
 * - CRM blocklist for system/vendor addresses
 * - Profile cleanup, deduplication, and merging
 * - Conversation state machine (DORMANT → ACTIVE → GONE_COLD)
 * - Web enrichment for new business contacts
 *
 * All functions receive a shared `ctx` context object.
 */

// ─── CRM blocklist ────────────────────────────────────────────────────────────
const CRM_BLOCKED_PATTERNS = [
  /noreply|no-reply|no\.reply|donotreply|do-not-reply|do\.not\.reply/i,
  /^mailer-daemon@/i, /^postmaster@/i, /^bounce/i, /^notifications?@/i,
  /^alerts?@/i, /^news(letter)?@/i, /^info@/i, /^support@/i, /^help@/i,
  /^feedback@/i, /^team@/i, /^hello@/i, /^billing@/i, /^invoice/i,
  /^updates?@/i, /^admin@/i, /^service@/i, /^automated/i, /^system@/i,
];

const CRM_BLOCKED_DOMAINS = new Set([
  "google.com", "googlemail.com", "accounts.google.com", "calendar-notification.google.com",
  "calendar.google.com", "drive-shares-dm-noreply.google.com", "docs.google.com",
  "twilio.com", "sendgrid.net", "sendgrid.com",
  "github.com", "gitlab.com", "bitbucket.org",
  "notion.so", "slack.com", "linear.app", "figma.com", "vercel.com",
  "render.com", "heroku.com", "netlify.com", "fly.io",
  "stripe.com", "paypal.com", "wise.com", "revolut.com",
  "zoom.us", "calendly.com",
  "mailchimp.com", "hubspot.com", "intercom.io", "zendesk.com",
  "atlassian.com", "jira.com", "confluence.com",
  "docusign.net", "docusign.com", "hellosign.com",
  "amazonses.com", "amazonaws.com",
  "boardy.ai", "boardyai.com",
  "facebookmail.com", "linkedin.com", "twitter.com", "x.com", "instagram.com",
]);

function isCrmBlocked(email) {
  if (!email) return true;
  const lower = email.toLowerCase();
  const domain = lower.split("@")[1] || "";
  for (const blocked of CRM_BLOCKED_DOMAINS) {
    if (domain === blocked || domain.endsWith("." + blocked)) return true;
  }
  for (const pattern of CRM_BLOCKED_PATTERNS) {
    if (pattern.test(lower)) return true;
  }
  return false;
}

// ─── Conversation State Machine ──────────────────────────────────────────────
const CONVERSATION_STATES = [
  "DORMANT", "OUTREACH_SENT", "ENGAGED", "COLD", "WARM",
  "MEETING_SET", "MET", "ACTIVE", "COOLING", "RE_ENGAGED", "GONE_COLD"
];

const STATE_TRANSITIONS = {
  outreach_sent:    { DORMANT: "OUTREACH_SENT", _default: null },
  reply_received:   { OUTREACH_SENT: "ENGAGED", COOLING: "RE_ENGAGED", GONE_COLD: "RE_ENGAGED", COLD: "RE_ENGAGED", _default: null },
  meeting_booked:   { ENGAGED: "MEETING_SET", WARM: "MEETING_SET", RE_ENGAGED: "MEETING_SET", ACTIVE: "MEETING_SET", _default: "MEETING_SET" },
  meeting_completed:{ MEETING_SET: "MET", _default: "MET" },
  interaction:      { ENGAGED: "WARM", RE_ENGAGED: "ACTIVE", MET: "ACTIVE", WARM: "WARM", ACTIVE: "ACTIVE", OUTREACH_SENT: "ENGAGED", COOLING: "RE_ENGAGED", GONE_COLD: "RE_ENGAGED", _default: null },
};

function advanceConversationState(ctx, email, event) {
  if (!email || ctx.isOwner(email) || email.toLowerCase() === ctx.CLARA_EMAIL.toLowerCase()) return;
  const key = email.toLowerCase();
  const profile = ctx.profiles[key];
  if (!profile) return;
  const current = profile.conversationState?.state || "DORMANT";
  const transitions = STATE_TRANSITIONS[event];
  if (!transitions) return;
  const next = transitions[current] ?? transitions._default;
  if (!next || next === current) return;
  profile.conversationState = {
    state: next,
    since: new Date().toISOString(),
    previousState: current,
  };
  ctx.profiles[key] = profile;
  ctx.saveProfiles();
  ctx.addLog(`🔄 ${profile.name || key}: ${current} → ${next} (${event})`, "info");
}

// ─── Deal Pipeline ────────────────────────────────────────────────────────────
const PIPELINE_STAGE_PROB = {
  cold_lead: 5, warm_lead: 15, engaged: 25, meeting_scheduled: 35,
  meeting_done: 50, proposal_sent: 65, negotiating: 75,
  committed: 90, funded: 100, inactive: 0,
};
const PIPELINE_STAGE_ORDER = Object.keys(PIPELINE_STAGE_PROB);

function advancePipeline(ctx, email, reason) {
  const key = email.toLowerCase();
  const profile = ctx.profiles[key];
  if (!profile) return;

  if (!profile.pipeline) {
    profile.pipeline = {
      stage: "cold_lead", value: null, currency: "EUR",
      probability: PIPELINE_STAGE_PROB.cold_lead, expectedClose: null,
      notes: "", lastAdvanced: new Date().toISOString(),
    };
  }

  const p = profile.pipeline;
  const currentIdx = PIPELINE_STAGE_ORDER.indexOf(p.stage);
  let newStage = null;

  if (reason === "first_email" && currentIdx < PIPELINE_STAGE_ORDER.indexOf("warm_lead")) {
    newStage = "warm_lead";
  } else if (reason === "meeting_scheduled" && currentIdx < PIPELINE_STAGE_ORDER.indexOf("meeting_scheduled")) {
    newStage = "meeting_scheduled";
  } else if (reason === "meeting_done" && currentIdx < PIPELINE_STAGE_ORDER.indexOf("meeting_done")) {
    newStage = "meeting_done";
  }

  if (newStage) {
    p.stage = newStage;
    p.probability = PIPELINE_STAGE_PROB[newStage];
    p.lastAdvanced = new Date().toISOString();
    ctx.profiles[key] = profile;
    ctx.saveProfiles();
    ctx.addLog(`📊 Pipeline advanced: ${profile.name} → ${newStage} (${reason})`, "info");
  }
}

// ─── Profile enrichment ───────────────────────────────────────────────────────
async function enrichProfile(ctx, email, { name, direction, subject, body }) {
  if (!email || ctx.isOwner(email) || email.toLowerCase() === ctx.CLARA_EMAIL.toLowerCase()) return;
  if (isCrmBlocked(email)) return;
  if (ctx.crmDeleted.has(email.toLowerCase())) return;
  const key = email.toLowerCase();
  const existing = ctx.profiles[key] || { email: key, name: name || key.split("@")[0], interactions: [], openItems: [], totalEmails: 0 };

  // Skip full enrichment if updated recently
  if (existing.lastContact) {
    const hoursSince = (Date.now() - new Date(existing.lastContact).getTime()) / 3600000;
    if (hoursSince < 4) {
      existing.totalEmails = (existing.totalEmails || 0) + 1;
      existing.lastContact = new Date().toISOString();
      existing.interactions = [...(existing.interactions || []).slice(-9), { date: new Date().toISOString(), direction, summary: subject }];
      ctx.profiles[key] = existing;
      ctx.saveProfiles();
      return;
    }
  }

  let update = {};
  try {
    const raw = await ctx.askClaude(
      `${ctx.SNIPPET_IDENTITY}\nYou are analysing an email to build a CRM profile for ${ctx.OWNER_NAME}'s PA Clara.\n\n` +
      `Contact email: ${key}\nKnown name: ${existing.name || "unknown"}\n` +
      `Email direction: ${direction} (sent = Clara/${ctx.OWNER_NAME} sent to this person; received = this person wrote to Clara)\n` +
      `Subject: ${ctx.wrapUntrusted(subject)}\n` +
      `Body (excerpt): ${ctx.wrapUntrusted(ctx.truncate(body, 1200))}\n\n` +
      `Return ONLY valid JSON with these fields (use null if unknown):\n` +
      `{\n` +
      `  "name": "full name if found (e.g. John Michael Smith)",\n` +
      `  "firstName": "first name only (e.g. Salvatore)",\n` +
      `  "company": "company or organisation",\n` +
      `  "role": "job title or role",\n` +
      `  "phone": "phone number if found in signature or body, with country code, or null",\n` +
      `  "relationship": "one of: investor, advisor, lawyer, accountant, banker, partner, vendor, client, friend, family, journalist, government, other",\n` +
      `  "language": "primary language they write in",\n` +
      `  "summary": "one sentence summary of this specific email",\n` +
      `  "openItems": ["any action items or follow-ups still pending from this email, or empty array"],\n` +
      `  "warmth": "1-10 integer: how warm/friendly is the relationship tone in this email (1=cold/formal, 10=very warm/personal)",\n` +
      `  "engagement": "1-10 integer: how engaged/responsive is this person (1=minimal effort, 10=highly engaged/detailed)",\n` +
      `  "interest": "1-10 integer: how interested are they in working with ${ctx.OWNER_NAME} (1=no interest, 10=very eager)",\n` +
      `  "sentimentTrend": "one of: warming, cooling, stable, new — based on the tone relative to what you'd expect",\n` +
      `  "investmentData": {\n` +
      `    "aum": "assets under management if mentioned, or null",\n` +
      `    "fundSize": "fund size if mentioned, or null",\n` +
      `    "ticketSize": "typical investment/ticket size if mentioned, or null",\n` +
      `    "sectors": ["array of sectors/industries if mentioned, or empty array"],\n` +
      `    "geographies": ["array of geographies/regions if mentioned, or empty array"],\n` +
      `    "strategy": "investment strategy description if mentioned, or null"\n` +
      `  }\n` +
      `}`, 768
    );
    update = ctx.parseJSON(raw);
  } catch (e) {
    ctx.addLog(`⚠️ Profile enrichment failed for ${key}: ${e.message}`, "warning");
    update = { summary: subject };
  }

  // Safe field extraction
  const safeName         = typeof update.name         === "string" ? update.name.slice(0, 200)         : null;
  const safeFirstName    = typeof update.firstName    === "string" ? update.firstName.slice(0, 100)    : null;
  const safeCompany      = typeof update.company      === "string" ? update.company.slice(0, 200)      : null;
  const safeRole         = typeof update.role         === "string" ? update.role.slice(0, 200)         : null;
  const safePhone        = typeof update.phone        === "string" ? update.phone.slice(0, 50)         : null;
  const safeRelationship = typeof update.relationship === "string" ? update.relationship.slice(0, 50)  : null;
  const safeLang         = typeof update.language     === "string" ? ctx.sanitiseLang(update.language) : null;
  const safeSummary      = typeof update.summary      === "string" ? update.summary.slice(0, 500)      : subject;
  const safeOpenItems    = Array.isArray(update.openItems)
    ? update.openItems.filter(x => typeof x === "string").map(x => x.slice(0, 200)).slice(0, 10)
    : null;

  const safeWarmth        = typeof update.warmth === "number" ? Math.max(1, Math.min(10, Math.round(update.warmth))) : null;
  const safeEngagement    = typeof update.engagement === "number" ? Math.max(1, Math.min(10, Math.round(update.engagement))) : null;
  const safeInterest      = typeof update.interest === "number" ? Math.max(1, Math.min(10, Math.round(update.interest))) : null;
  const safeSentimentTrend = ["warming", "cooling", "stable", "new"].includes(update.sentimentTrend) ? update.sentimentTrend : null;

  const rawInv = update.investmentData && typeof update.investmentData === "object" ? update.investmentData : {};
  const safeInvestmentData = {};
  if (typeof rawInv.aum === "string" && rawInv.aum)           safeInvestmentData.aum        = rawInv.aum.slice(0, 200);
  if (typeof rawInv.fundSize === "string" && rawInv.fundSize)  safeInvestmentData.fundSize   = rawInv.fundSize.slice(0, 200);
  if (typeof rawInv.ticketSize === "string" && rawInv.ticketSize) safeInvestmentData.ticketSize = rawInv.ticketSize.slice(0, 200);
  if (Array.isArray(rawInv.sectors) && rawInv.sectors.length)  safeInvestmentData.sectors    = rawInv.sectors.filter(x => typeof x === "string").map(x => x.slice(0, 100)).slice(0, 20);
  if (Array.isArray(rawInv.geographies) && rawInv.geographies.length) safeInvestmentData.geographies = rawInv.geographies.filter(x => typeof x === "string").map(x => x.slice(0, 100)).slice(0, 20);
  if (typeof rawInv.strategy === "string" && rawInv.strategy)  safeInvestmentData.strategy   = rawInv.strategy.slice(0, 500);

  const interaction = { date: new Date().toISOString(), direction, summary: safeSummary };

  const updated = {
    ...existing,
    email: key,
    name:         safeName         || existing.name         || name || key.split("@")[0],
    firstName:    safeFirstName    || ctx.firstNameOnly(safeName || existing.name || name || key.split("@")[0]),
    company:      safeCompany      || existing.company      || null,
    role:         safeRole         || existing.role         || null,
    phone:        safePhone        || existing.phone        || null,
    relationship: safeRelationship || existing.relationship || "other",
    language:     safeLang         || existing.language     || "English",
    interactions: [...(existing.interactions || []).slice(-9), interaction],
    openItems:    safeOpenItems    ?? (existing.openItems   || []),
    notes:        existing.notes   || null,
    lastContact:  new Date().toISOString(),
    totalEmails:  (existing.totalEmails || 0) + 1,
    lastOwnerEmail: existing.lastOwnerEmail || ctx.OWNER_DEFAULT,
    aliases:      existing.aliases || [],
    warmth:          safeWarmth         ?? existing.warmth         ?? null,
    engagement:      safeEngagement     ?? existing.engagement     ?? null,
    interest:        safeInterest       ?? existing.interest       ?? null,
    sentimentTrend:  safeSentimentTrend ?? existing.sentimentTrend ?? null,
    sentimentHistory: (() => {
      const hist = [...(existing.sentimentHistory || [])];
      if (safeWarmth || safeEngagement || safeInterest) {
        hist.push({ date: new Date().toISOString(), warmth: safeWarmth, engagement: safeEngagement, interest: safeInterest });
      }
      return hist.slice(-10);
    })(),
    investmentData: Object.keys(safeInvestmentData).length
      ? { ...(existing.investmentData || {}), ...safeInvestmentData }
      : (existing.investmentData || null),
    pipeline:     existing.pipeline || null,
  };

  // Web enrichment for new business contacts (fire-and-forget)
  const isNewContact = !existing.company && !existing.role && (existing.totalEmails || 0) === 0;
  if (isNewContact && updated.relationship !== "friend" && updated.relationship !== "family") {
    // Fire-and-forget with explicit .catch to prevent unhandled rejection
    _webEnrichContact(ctx, key, updated).catch(e =>
      ctx.addLog(`⚠️ Web enrichment failed for ${key}: ${e.message}`, "warning")
    );
  }

  ctx.profiles[key] = updated;
  ctx.saveProfiles();

  // Auto-advance deal pipeline
  if ((existing.totalEmails || 0) === 0) advancePipeline(ctx, key, "first_email");
  for (const t of Object.values(ctx.activeThreads)) {
    if (t.thirdPartyEmail?.toLowerCase() !== key) continue;
    if ((t.stage === "waiting_for_confirmation" || t.stage === "done") && !t.calendarEventId) advancePipeline(ctx, key, "meeting_scheduled");
    if (t.stage === "done" && t.calendarEventId) advancePipeline(ctx, key, "meeting_done");
  }

  if (direction === "received") advanceConversationState(ctx, key, "reply_received");
  else if (direction === "sent") advanceConversationState(ctx, key, "interaction");

  ctx.addLog(`📇 Profile updated: ${updated.name} (${key})`, "info");
}

function getProfileContext(ctx, email) {
  const key = email?.toLowerCase();
  if (!key || !ctx.profiles[key]) return null;
  const p = ctx.profiles[key];
  const recentInteractions = (p.interactions || []).slice(-5)
    .map(i => `  • [${new Date(i.date).toLocaleDateString("en-GB")}] ${i.direction === "sent" ? "→" : "←"} ${i.summary}`)
    .join("\n");
  return `=== KNOWN CONTACT: ${p.name} ===\nCompany: ${p.company || "unknown"}\nRole: ${p.role || "unknown"}\nPhone: ${p.phone || "unknown"}\nRelationship: ${p.relationship || "other"}\nLanguage: ${p.language || "English"}\nTotal emails: ${p.totalEmails || 0}\nLast contact: ${p.lastContact ? new Date(p.lastContact).toLocaleDateString("en-GB") : "unknown"}\nOpen items: ${(p.openItems || []).length ? (p.openItems || []).join("; ") : "none"}\nRecent interactions:\n${recentInteractions || "  (none)"}`;
}

// ─── Email resolver ───────────────────────────────────────────────────────────
async function resolveEmailForName(ctx, name, contextHint = "", embeddedEmails = []) {
  const key = name.toLowerCase().trim();
  const gmail = ctx.getGmail();

  if (embeddedEmails.length) {
    const pick = await ctx.askClaude(
      `${ctx.OWNER_NAME}'s PA is looking for the email address of a contact named "${name}".` +
      (contextHint ? ` Context from the message: ${ctx.wrapUntrusted(contextHint.slice(0, 800))}` : "") +
      `\n\nEmail addresses found embedded in the forwarded message:\n${embeddedEmails.join(", ")}` +
      `\n\nWhich of these addresses most likely belongs to "${name}"? Reply with ONLY the email address, or NOT_FOUND if none match.`,
      64, 1, ctx.MODEL_HAIKU
    );
    const candidate = pick.trim().toLowerCase();
    if (candidate !== "not_found" && candidate.includes("@")) {
      ctx.learnContact(name, candidate);
      ctx.addLog(`✅ Resolved from forwarded body: ${name} → ${candidate}`, "success");
      return candidate;
    }
  }

  if (ctx.contacts[key]) {
    ctx.addLog(`📇 Contact found: ${name} → ${ctx.contacts[key].email}`);
    return ctx.contacts[key].email;
  }

  ctx.addLog(`🔍 Resolving email for "${name}" via Gmail history...`);
  const candidates = new Set();

  try {
    const queries = [`in:sent to:"${name}"`, `in:anywhere from:"${name}"`, `in:anywhere "${name}"`];
    for (const q of queries) {
      try {
        const res = await gmail.users.messages.list({ userId: "me", q, maxResults: 10 });
        for (const m of res.data.messages || []) {
          const msg = await gmail.users.messages.get({ userId: "me", id: m.id, format: "metadata", metadataHeaders: ["From", "To", "Cc"] });
          for (const h of msg.data.payload.headers) {
            const found = (h.value || "").match(/[\w.+\-]+@[\w.\-]+\.\w+/g) || [];
            for (const addr of found) {
              const lower = addr.toLowerCase();
              if (!ctx.isOwner(lower) && lower !== ctx.CLARA_EMAIL.toLowerCase()) candidates.add(lower);
            }
          }
        }
      } catch { /* non-fatal */ }
    }
  } catch (e) { ctx.addLog(`⚠️ Gmail search failed for "${name}": ${e.message}`, "warning"); }

  if (!candidates.size) {
    ctx.addLog(`⚠️ No email candidates found for "${name}"`, "warning");
    return null;
  }

  const list = [...candidates].slice(0, 20).join(", ");
  const pick = await ctx.askClaude(
    `${ctx.OWNER_NAME}'s PA is looking for the email address of a contact named "${name}".` +
    (contextHint ? ` Context: ${ctx.wrapUntrusted(contextHint)}` : "") +
    `\n\nCandidate addresses found in Gmail history:\n${list}` +
    `\n\nWhich address most likely belongs to "${name}"? Reply with ONLY the email address, or NOT_FOUND if none match.`,
    64, 1, ctx.MODEL_HAIKU
  );

  const resolved = pick.trim().toLowerCase();
  if (resolved === "not_found" || !resolved.includes("@")) {
    ctx.addLog(`⚠️ Claude could not identify email for "${name}" from candidates`, "warning");
    return null;
  }

  ctx.learnContact(name, resolved);
  ctx.addLog(`✅ Resolved and learnt: ${name} → ${resolved}`, "success");
  return resolved;
}

async function resolveRecipientEmails(ctx, tasks, contextBody, embeddedEmails = []) {
  const toResolve = [];
  for (const task of tasks) {
    for (const r of task.recipients || []) {
      if (!r.email && r.name) toResolve.push(r);
    }
  }
  if (toResolve.length) {
    await Promise.all(toResolve.map(async r => {
      const resolved = await resolveEmailForName(ctx, r.name, contextBody, embeddedEmails);
      if (resolved) { r.email = resolved; r._resolved = true; }
    }));
  }
  const stillMissing = tasks
    .filter(t => t.type === "SEND_EMAIL" || t.type === "VDR" || t.type === "BOOK_MEETING" || t.type === "BOOK_PHONE_CALL")
    .flatMap(t => (t.recipients || []).filter(r => !r.email).map(r => r.name || "unknown"));
  return { tasks, stillMissing: [...new Set(stillMissing)] };
}

// ─── Bootstrap CRM from Gmail history ─────────────────────────────────────────
let bootstrapRunning = false;
async function bootstrapProfiles(ctx) {
  if (bootstrapRunning) return { ok: false, error: "Bootstrap already running" };
  bootstrapRunning = true;
  ctx.addLog("🔄 Starting CRM bootstrap scan…", "info");
  let processed = 0, errors = 0;
  try {
    const gmail = ctx.getGmail();
    const sixMonthsAgo = Math.floor((Date.now() - 180 * 24 * 60 * 60 * 1000) / 1000);
    const queries = [`from:${ctx.CLARA_EMAIL} after:${sixMonthsAgo}`, `to:${ctx.CLARA_EMAIL} after:${sixMonthsAgo}`];
    const messageIds = new Set();
    for (const q of queries) {
      let pageToken = null;
      do {
        const params = { userId: "me", q, maxResults: 100 };
        if (pageToken) params.pageToken = pageToken;
        const res = await gmail.users.messages.list(params);
        for (const m of res.data.messages || []) messageIds.add(m.id);
        pageToken = res.data.nextPageToken || null;
      } while (pageToken);
    }
    ctx.addLog(`📨 Bootstrap: found ${messageIds.size} emails to process`, "info");
    const idsToProcess = [...messageIds].slice(-500);
    if (messageIds.size > 500) ctx.addLog(`⚠️ Bootstrap capped at 500 most recent emails (found ${messageIds.size})`, "warning");

    for (const id of idsToProcess) {
      try {
        const msg = await gmail.users.messages.get({ userId: "me", id, format: "full" });
        const headers = msg.data.payload.headers;
        const get = n => headers.find(h => h.name.toLowerCase() === n)?.value || "";
        const fromRaw = get("from");
        const toRaw   = get("to");
        const subject = get("subject") || "(no subject)";
        const fromAddr = ctx.extractEmail(fromRaw);
        const body    = ctx.getTextBody(msg.data.payload);

        const isFromClara = fromAddr === ctx.CLARA_EMAIL.toLowerCase();
        if (isFromClara) {
          const toAddrs = (toRaw.match(/[\w.+\-]+@[\w.\-]+\.\w+/g) || [])
            .filter(e => !ctx.isOwner(e) && e.toLowerCase() !== ctx.CLARA_EMAIL.toLowerCase());
          for (const addr of toAddrs) {
            const name = ctx.getNameForEmail(toRaw, addr);
            await enrichProfile(ctx, addr, { name, direction: "sent", subject, body });
            processed++;
          }
        } else if (!ctx.isOwner(fromAddr)) {
          const name = ctx.getNameForEmail(fromRaw, fromAddr);
          await enrichProfile(ctx, fromAddr, { name, direction: "received", subject, body });
          processed++;
        }
      } catch (e) {
        errors++;
        if (errors <= 5) ctx.addLog(`⚠️ Bootstrap error on ${id}: ${e.message}`, "warning");
      }
      await new Promise(r => setTimeout(r, 300));
    }
    ctx.addLog(`✅ Bootstrap complete — ${processed} interactions, ${Object.keys(ctx.profiles).length} profiles built`, "success");
    return { ok: true, processed, profiles: Object.keys(ctx.profiles).length };
  } catch (e) {
    ctx.addLog(`❌ Bootstrap failed: ${e.message}`, "error");
    return { ok: false, error: e.message };
  } finally {
    bootstrapRunning = false;
  }
}

function isBootstrapRunning() { return bootstrapRunning; }

// ─── CRM cleanup — purge junk, merge duplicates ──────────────────────────────
function cleanupProfiles(ctx) {
  let purged = 0, merged = 0;

  for (const key of Object.keys(ctx.profiles)) {
    if (isCrmBlocked(key) || ctx.isOwner(key) || key === ctx.CLARA_EMAIL.toLowerCase()) {
      delete ctx.profiles[key];
      purged++;
    }
  }

  // Auto-merge duplicates
  const nameMap = {};
  for (const [key, p] of Object.entries(ctx.profiles)) {
    const norm = (p.name || "").toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
    if (!norm || norm.length < 3) continue;
    if (!nameMap[norm]) nameMap[norm] = [];
    nameMap[norm].push(key);
  }
  for (const [, keys] of Object.entries(nameMap)) {
    if (keys.length < 2) continue;
    keys.sort((a, b) => (ctx.profiles[b]?.totalEmails || 0) - (ctx.profiles[a]?.totalEmails || 0));
    const primary = keys[0];
    for (const dup of keys.slice(1)) {
      const p2 = ctx.profiles[dup];
      if (!p2) continue;
      ctx.profiles[primary].interactions = [...(ctx.profiles[primary].interactions || []), ...(p2.interactions || [])]
        .sort((a, b) => new Date(a.date) - new Date(b.date)).slice(-10);
      ctx.profiles[primary].totalEmails = (ctx.profiles[primary].totalEmails || 0) + (p2.totalEmails || 0);
      ctx.profiles[primary].company  = ctx.profiles[primary].company  || p2.company;
      ctx.profiles[primary].role     = ctx.profiles[primary].role     || p2.role;
      ctx.profiles[primary].phone    = ctx.profiles[primary].phone    || p2.phone;
      ctx.profiles[primary].language = ctx.profiles[primary].language || p2.language;
      if (!ctx.profiles[primary].aliases) ctx.profiles[primary].aliases = [];
      if (!ctx.profiles[primary].aliases.includes(dup)) ctx.profiles[primary].aliases.push(dup);
      delete ctx.profiles[dup];
      merged++;
    }
  }

  // Thread deduplication
  let deduped = 0;
  const threadsByPerson = {};
  for (const [key, t] of Object.entries(ctx.activeThreads)) {
    const person = (t.thirdPartyEmail || "").toLowerCase();
    if (!person) continue;
    const bucket = `${person}|${t.stage}|${t.originalSubject || ""}`;
    if (!threadsByPerson[bucket]) threadsByPerson[bucket] = [];
    threadsByPerson[bucket].push(key);
  }
  for (const keys of Object.values(threadsByPerson)) {
    if (keys.length <= 1) continue;
    keys.sort((a, b) => {
      const ta = ctx.activeThreads[a]; const tb = ctx.activeThreads[b];
      const tsA = new Date(ta.lastContact || ta.confirmedTime || ta.chasedAt || 0).getTime();
      const tsB = new Date(tb.lastContact || tb.confirmedTime || tb.chasedAt || 0).getTime();
      return tsB - tsA;
    });
    for (let i = 1; i < keys.length; i++) {
      delete ctx.activeThreads[keys[i]];
      deduped++;
    }
  }
  if (deduped) ctx.addLog(`🧹 Thread dedup: removed ${deduped} duplicate thread(s)`, "info");

  // Purge garbage threads
  let purgedThreads = 0;
  for (const [key, t] of Object.entries(ctx.activeThreads)) {
    if (t.stage === "calendar_context" && !t.cachedCalendarEvents?.length) {
      delete ctx.activeThreads[key]; purgedThreads++; continue;
    }
    if (t.stage === "waiting_corrected_email") {
      const age = Date.now() - new Date(t.lastContact || t.sentAt || 0).getTime();
      if (age > 7 * 24 * 60 * 60 * 1000) { delete ctx.activeThreads[key]; purgedThreads++; continue; }
    }
    if (key.startsWith("brief_") && t.stage === "done") {
      delete ctx.activeThreads[key]; purgedThreads++; continue;
    }
  }
  if (purgedThreads) ctx.addLog(`🧹 Purged ${purgedThreads} garbage thread(s)`, "info");

  // Archive old threads
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let archivedThreads = 0;
  for (const [key, t] of Object.entries(ctx.activeThreads)) {
    if ((t.stage === "done" || t.stage === "cancelled")) {
      const ts = t.lastContact || t.confirmedTime || t.chasedAt;
      if (ts && new Date(ts).getTime() < thirtyDaysAgo) {
        delete ctx.activeThreads[key];
        archivedThreads++;
      }
    }
  }
  if (archivedThreads) ctx.addLog(`🗄️ Archived ${archivedThreads} old thread(s) (>30 days)`, "info");

  if (deduped || purgedThreads || archivedThreads) ctx.saveThreads();

  // Clear stale RSVP data
  const rsvpCount = Object.keys(ctx.rsvpStatus).length;
  if (rsvpCount > 200) { ctx.rsvpStatus = {}; ctx.saveRsvpStatus(); ctx.addLog(`🗄️ Reset RSVP cache (was ${rsvpCount} entries)`, "info"); }

  // Trim interactions
  let trimmed = 0;
  for (const [key, p] of Object.entries(ctx.profiles)) {
    if (p.interactions && p.interactions.length > 10) {
      ctx.profiles[key].interactions = p.interactions.slice(-10);
      ctx.profiles[key].interactions.forEach(i => { delete i.subject; });
      trimmed++;
    }
  }

  if (purged || merged || trimmed) {
    ctx.saveProfiles();
    if (purged) ctx.addLog(`🧹 CRM cleanup: purged ${purged} junk/vendor profile(s)`, "info");
    if (merged) ctx.addLog(`🔗 CRM cleanup: merged ${merged} duplicate profile(s)`, "info");
    if (trimmed) ctx.addLog(`📦 CRM cleanup: trimmed interactions on ${trimmed} profile(s) to save space`, "info");
  }

  // Dedup alerts
  const possibleDupes = [];
  const profileEntries = Object.entries(ctx.profiles);
  for (let i = 0; i < profileEntries.length; i++) {
    const [emailA, pA] = profileEntries[i];
    if (!pA.name || !pA.company) continue;
    const firstA = (pA.name || "").split(/\s+/)[0].toLowerCase();
    const compA = (pA.company || "").toLowerCase();
    for (let j = i + 1; j < profileEntries.length; j++) {
      const [emailB, pB] = profileEntries[j];
      if (!pB.name || !pB.company) continue;
      const compB = (pB.company || "").toLowerCase();
      if (compA !== compB || compA.length < 2) continue;
      const firstB = (pB.name || "").split(/\s+/)[0].toLowerCase();
      const domainA = emailA.split("@")[1] || "";
      const domainB = emailB.split("@")[1] || "";
      if (firstA === firstB && domainA !== domainB) {
        possibleDupes.push(`${pA.name} (${emailA}) and ${pB.name} (${emailB})`);
      }
      const lastA = (pA.name || "").split(/\s+/).slice(-1)[0]?.toLowerCase() || "";
      const lastB = (pB.name || "").split(/\s+/).slice(-1)[0]?.toLowerCase() || "";
      if (lastA === lastB && lastA.length > 1 && (firstA.length === 1 || firstB.length === 1) && firstA[0] === firstB[0]) {
        if (!possibleDupes.some(d => d.includes(emailA) && d.includes(emailB))) {
          possibleDupes.push(`${pA.name} (${emailA}) and ${pB.name} (${emailB})`);
        }
      }
    }
  }
  if (possibleDupes.length && ctx.TELEGRAM_ENABLED) {
    const dedupTimer = setTimeout(async () => {
      if (!ctx.TELEGRAM_CHAT_ID) return;
      const dedupMsg = `🔍 Possible duplicate contacts:\n${possibleDupes.slice(0, 5).map(d => `• ${d}`).join("\n")}\n\nSame person?`;
      await ctx.sendTelegram(ctx.TELEGRAM_CHAT_ID, dedupMsg).catch(() => {});
    }, 15000);
    if (dedupTimer.unref) dedupTimer.unref();
  }
}

// ─── Web enrichment helper (extracted for async safety) ─────────────────────
async function _webEnrichContact(ctx, key, updated) {
  const searchName = updated.name || key.split("@")[0];
  const searchDomain = key.split("@")[1] || "";
  const enrichRaw = await ctx.askClaudeWithWebSearch(
    `Find publicly available professional information about "${searchName}"` +
    (searchDomain ? ` who works at or is associated with ${searchDomain}` : "") +
    `. Return ONLY a JSON object with fields: company (string|null), role (string|null), linkedin (string|null), notes (1-sentence bio or null). No other text.`
  );
  const enrichData = (() => { try { return JSON.parse(enrichRaw.replace(/```json|```/g, "").trim()); } catch { return null; } })();
  if (enrichData) {
    const p = ctx.profiles[key] || updated;
    if (enrichData.company && !p.company) p.company = enrichData.company.slice(0, 200);
    if (enrichData.role    && !p.role)    p.role    = enrichData.role.slice(0, 200);
    if (enrichData.notes   && !p.notes)   p.notes   = enrichData.notes.slice(0, 500);
    ctx.profiles[key] = p;
    ctx.saveProfiles();
    ctx.addLog(`🔍 Web-enriched profile: ${searchName} — ${enrichData.company || ""} ${enrichData.role || ""}`.trim(), "info");
  }
}

module.exports = {
  isCrmBlocked,
  CONVERSATION_STATES,
  STATE_TRANSITIONS,
  advanceConversationState,
  PIPELINE_STAGE_PROB,
  PIPELINE_STAGE_ORDER,
  advancePipeline,
  enrichProfile,
  getProfileContext,
  resolveEmailForName,
  resolveRecipientEmails,
  bootstrapProfiles,
  isBootstrapRunning,
  cleanupProfiles,
};
