/**
 * @module gmail-adapter
 * @description Gmail / Google OAuth integration for Clara.
 *
 * Handles:
 * - OAuth2 client setup and token management for both Gmail (Clara's account)
 *   and Calendar (Owner's account)
 * - Sending emails with attachments, threading, CC, MIME encoding
 * - Fetching threads and messages from Gmail
 * - Email searching and attachment retrieval
 * - Auth-error detection and re-authorization flow
 *
 * All functions receive a shared `ctx` context object that provides access to
 * state, config, constants, and helper functions from the main server.
 */

const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");
const cryptoStore = require("./crypto-store");

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
];

let oauth2Client = null;
let calendarOAuth2Client = null;
let gmail = null;
let calendar = null;

/**
 * Initialize Google OAuth clients and API instances.
 * Called once at startup from server.js.
 */
function init(ctx) {
  // Gmail OAuth — Clara's account
  oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || "https://your-app.onrender.com/auth/callback"
  );
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  }

  // Calendar OAuth — Owner's account
  // Falls back to Clara's token if not yet configured
  calendarOAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || "https://your-app.onrender.com/auth/callback"
  );
  if (process.env.GOOGLE_CALENDAR_REFRESH_TOKEN) {
    calendarOAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN });
  } else if (process.env.GOOGLE_REFRESH_TOKEN) {
    calendarOAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    ctx.addLog("⚠️ GOOGLE_CALENDAR_REFRESH_TOKEN not set — using Clara's token for calendar (organizer will show as Clara)", "warning");
  }

  // Monitor token events — auto-persist new refresh tokens to survive restarts
  oauth2Client.on("tokens", (tokens) => {
    if (tokens.refresh_token) {
      console.log("[AUTH] New Gmail refresh token issued — persisting to token file");
      ctx.addLog("🔑 New Gmail refresh token issued — auto-persisted", "warning");
      _persistToken("GOOGLE_REFRESH_TOKEN", tokens.refresh_token, ctx);
      oauth2Client.setCredentials({ refresh_token: tokens.refresh_token });
    }
  });
  calendarOAuth2Client.on("tokens", (tokens) => {
    if (tokens.refresh_token) {
      console.log("[AUTH] New Calendar refresh token issued — persisting to token file");
      ctx.addLog("🔑 New Calendar refresh token issued — auto-persisted", "warning");
      _persistToken("GOOGLE_CALENDAR_REFRESH_TOKEN", tokens.refresh_token, ctx);
      calendarOAuth2Client.setCredentials({ refresh_token: tokens.refresh_token });
    }
  });

  gmail = google.gmail({ version: "v1", auth: oauth2Client });
  calendar = google.calendar({ version: "v3", auth: calendarOAuth2Client });
}

/** Wrap Gmail/Calendar calls to catch auth errors and surface them clearly. */
async function withAuthCheck(fn, ctx) {
  try {
    return await fn();
  } catch (e) {
    if (e.code === 401 || e.code === 403 || (e.message && e.message.includes("invalid_grant"))) {
      ctx.config.isAuthorized = false;
      ctx.addLog("🔐 Google auth error — token may have expired. Visit /auth/login to reauthorize.", "error");
    }
    throw e;
  }
}

// ─── MIME helpers ──────────────────────────────────────────────────────────────
function encodeSubject(s) {
  return /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`;
}

/** Strip CRLF from any value going into a MIME header — prevents header injection. */
function sanitiseHeader(s) {
  return String(s || "").replace(/[\r\n\t]/g, " ").trim();
}

// ─── Email body/header extraction ─────────────────────────────────────────────
const decodeBase64 = str => Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
const getHeader = (headers, name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
const extractEmail = str => { const m = str.match(/<([^>]+)>/); return (m ? m[1] : str).toLowerCase().trim(); };
const cleanSubject = s => s.replace(/^(re|fwd?|fw):\s*/gi, "").trim();

function extractFirstName(str) {
  if (!str) return "";
  const m = str.match(/^"?([^"<]+)"?\s*</);
  const namePart = m ? m[1].trim() : str.trim();
  return namePart.split(/\s+/)[0] || str.trim();
}

function getNameForEmail(rawHeader, email) {
  for (const part of rawHeader.split(/,(?=\s*[^,]*<)/))
    if (part.toLowerCase().includes(email.toLowerCase())) return extractFirstName(part.trim());
  return email.split("@")[0].split(".")[0];
}

function getTextBody(payload) {
  if (!payload) return "";
  function find(node, mime) {
    if (node.mimeType === mime && node.body?.data) return decodeBase64(node.body.data);
    for (const p of node.parts || []) { const r = find(p, mime); if (r) return r; }
    return null;
  }
  const plain = find(payload, "text/plain");
  if (plain) return plain;
  const html = find(payload, "text/html");
  if (html) return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
                       .replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
  return "";
}

function getAttachmentSummary(payload) {
  const names = [];
  function walk(node) {
    if (node.filename) names.push(node.filename);
    for (const p of node.parts || []) walk(p);
  }
  walk(payload);
  return names;
}

function getAttachmentParts(payload) {
  const parts = [];
  function walk(node) {
    if (node.filename && node.body?.attachmentId) {
      parts.push({ filename: node.filename, mimeType: node.mimeType || "application/octet-stream", attachmentId: node.body.attachmentId, size: node.body.size || 0 });
    }
    for (const p of node.parts || []) walk(p);
  }
  walk(payload);
  return parts;
}

async function fetchAttachmentData(messageId, attachmentId) {
  const res = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
  const b64 = (res.data.data || "").replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

// ─── Send email ───────────────────────────────────────────────────────────────
async function sendEmail(ctx, { to, subject, body, threadId, inReplyTo, references, attachment, attachments, cc = null, fromOwner = null, ignoreHours = false }) {
  const { CLARA_NAME, CLARA_EMAIL, OWNER_NAME, OWNER_DEFAULT, OWNER_EMAILS, isWithinActiveHours, isOwner, enrichProfile, auditDecision, profiles, saveProfiles, addLog, learnContact } = ctx;

  const allAttachments = attachments
    ? attachments.map(a => ({ filename: a.filename, contentType: a.mimeType || a.contentType, buffer: a.content || a.buffer }))
    : attachment
      ? [{ filename: attachment.filename, contentType: attachment.contentType, buffer: attachment.buffer }]
      : [];

  const safeTo      = sanitiseHeader(to);
  const safeCc      = cc ? sanitiseHeader(cc) : null;
  const safeSubject = encodeSubject(sanitiseHeader(subject));

  const toAddr = extractEmail((safeTo || "").split(",")[0]);
  const toOwner = isOwner(toAddr);
  if (!ignoreHours && !toOwner && toAddr !== CLARA_EMAIL.toLowerCase() && !isWithinActiveHours()) {
    addLog(`🌙 Outbound suppressed (outside hours): ${toAddr} — "${subject}"`, "info");
    return null;
  }

  let raw;
  if (allAttachments.length) {
    const boundary = `clara_${Date.now()}`;
    const parts = [`--${boundary}`, `Content-Type: text/plain; charset=utf-8`, `Content-Transfer-Encoding: quoted-printable`, ``, body];
    for (const att of allAttachments) {
      const safeFilenameHeader = sanitiseHeader(att.filename);
      const safeContentType    = sanitiseHeader(att.contentType);
      parts.push(
        `--${boundary}`,
        `Content-Type: ${safeContentType}; name="${safeFilenameHeader}"`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${safeFilenameHeader}"`,
        ``,
        (att.buffer.toString("base64").match(/.{1,76}/g) || []).join("\r\n")
      );
    }
    parts.push(`--${boundary}--`);
    const headers = [`From: "${CLARA_NAME} | PA to ${OWNER_NAME}" <${CLARA_EMAIL}>`, `To: ${safeTo}`, `Subject: ${safeSubject}`, `MIME-Version: 1.0`, `Content-Type: multipart/mixed; boundary="${boundary}"`];
    if (safeCc?.trim()) headers.push(`Cc: ${safeCc}`);
    if (inReplyTo?.trim()) headers.push(`In-Reply-To: ${sanitiseHeader(inReplyTo)}`);
    if (references?.trim()) headers.push(`References: ${sanitiseHeader(references)}`);
    raw = Buffer.from(headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } else {
    const headers = [`From: "${CLARA_NAME} | PA to ${OWNER_NAME}" <${CLARA_EMAIL}>`, `To: ${safeTo}`, `Subject: ${safeSubject}`, "Content-Type: text/plain; charset=utf-8", "MIME-Version: 1.0"];
    if (safeCc?.trim()) headers.push(`Cc: ${safeCc}`);
    if (inReplyTo?.trim()) headers.push(`In-Reply-To: ${sanitiseHeader(inReplyTo)}`);
    if (references?.trim()) headers.push(`References: ${sanitiseHeader(references)}`);
    raw = Buffer.from(headers.join("\r\n") + "\r\n\r\n" + body).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  const sent = await gmail.users.messages.send({ userId: "me", requestBody: { raw, threadId } });
  addLog(`📤 Sent to ${to}: "${subject}"`, "success");

  auditDecision({
    action: 'email_sent',
    target: toAddr,
    detail: `Email to ${to} — subject: "${subject}"`,
    reasoning: toOwner ? 'Owner notification / internal relay' : 'Outreach or third-party reply',
    source: 'email_poll',
  });

  if (!toOwner && toAddr !== CLARA_EMAIL.toLowerCase()) {
    if (fromOwner && isOwner(fromOwner) && profiles[toAddr]) {
      profiles[toAddr].lastOwnerEmail = fromOwner;
      saveProfiles();
    }
    enrichProfile(toAddr, { name: to.split("<")[0].trim() || toAddr, direction: "sent", subject, body })
      .catch(e => addLog(`⚠️ Profile enrichment failed (outbound): ${e.message}`, "warning"));
  }
  return sent.data;
}

/**
 * Persist a new OAuth refresh token to a JSON file on the persistent disk.
 * This survives Render redeploys. The token is also set in process.env for the current session.
 */
function _persistToken(key, value, ctx) {
  try {
    process.env[key] = value;
    const dataDir = fs.existsSync("/var/data") ? "/var/data" : ".";
    const tokenFile = path.join(dataDir, "oauth_tokens.json");
    let tokens = cryptoStore.readEncrypted(tokenFile, {});
    tokens[key] = value;
    tokens._updatedAt = new Date().toISOString();
    cryptoStore.atomicWriteEncryptedSync(tokenFile, tokens);
    ctx.addLog(`💾 Token ${key} persisted to ${tokenFile}`, "info");
  } catch (e) {
    ctx.addLog(`⚠️ Could not persist token ${key}: ${e.message}`, "warning");
  }
}

/**
 * Load persisted tokens from disk (called at startup before init).
 * Populates process.env with saved tokens that aren't already set.
 */
function loadPersistedTokens() {
  try {
    const dataDir = fs.existsSync("/var/data") ? "/var/data" : ".";
    const tokenFile = path.join(dataDir, "oauth_tokens.json");
    const tokens = cryptoStore.readEncrypted(tokenFile, null);
    if (!tokens) return;
    for (const [key, value] of Object.entries(tokens)) {
      if (key.startsWith("_")) continue;
      if (!process.env[key] && value) {
        process.env[key] = value;
        console.log(`[AUTH] Loaded persisted token: ${key}`);
      }
    }
  } catch (e) {
    console.warn(`[AUTH] Could not load persisted tokens: ${e.message}`);
  }
}

module.exports = {
  GOOGLE_SCOPES,
  init,
  loadPersistedTokens,
  withAuthCheck,
  sendEmail,
  encodeSubject,
  sanitiseHeader,
  decodeBase64,
  getHeader,
  extractEmail,
  cleanSubject,
  extractFirstName,
  getNameForEmail,
  getTextBody,
  getAttachmentSummary,
  getAttachmentParts,
  fetchAttachmentData,
  // Expose the underlying clients for direct use by routes/other modules
  getOAuth2Client: () => oauth2Client,
  getCalendarOAuth2Client: () => calendarOAuth2Client,
  getGmail: () => gmail,
  getCalendar: () => calendar,
};
