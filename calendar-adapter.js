/**
 * @module calendar-adapter
 * @description Google Calendar integration for Clara.
 *
 * Handles:
 * - Creating, updating, and cancelling calendar events
 * - Conflict detection before booking
 * - RSVP tracking and change notifications
 * - Free slot discovery in the owner's calendar
 * - Calendar event formatting for summaries
 * - Meeting description generation (Google Meet, phone, in-person)
 * - Booking confirmed meetings end-to-end
 *
 * Uses the calendar OAuth client from gmail-adapter (owner's account).
 * All functions receive a shared `ctx` context object.
 */

// ─── RSVP labels ──────────────────────────────────────────────────────────────
const RSVP_LABELS = { accepted: "✓ accepted", declined: "✗ declined", tentative: "? tentative", needsAction: "awaiting reply" };

function meetingDescription(ctx, t) {
  const name = t.calendarDisplayName || t.thirdPartyFirstName;
  if (t.isPhoneCall) return `${ctx.OWNER_NAME} (${ctx.OWNER_PHONE}) to call ${name}${t.phoneNumber ? " at " + t.phoneNumber : ""}`;
  if (t.isInPerson)  return `In-person meeting between ${ctx.OWNER_NAME} and ${name}${t.location ? " at " + t.location : ""}.`;
  return `Google Meet between ${ctx.OWNER_NAME} and ${name}.`;
}

function meetingExtraInfo(ctx, t, calendarLink) {
  if (t.isInPerson)  return t.location ? `\n\nLocation: ${t.location}` : "";
  if (!t.isPhoneCall && calendarLink) return `\n\nGoogle Meet link: ${calendarLink}`;
  if (t.isPhoneCall) return `\n\n${ctx.OWNER_NAME} (${ctx.OWNER_PHONE}) will call ${t.calendarDisplayName || t.thirdPartyFirstName}.`;
  return "";
}

async function parseTime(ctx, timeStr) {
  const raw = await ctx.askClaude(
    `Parse this meeting time into ISO 8601, assuming Europe/Rome timezone.\n${ctx.wrapUntrusted(timeStr)}\nToday: ${new Date().toISOString().split("T")[0]}\nDefault duration: 30 minutes unless specified.\nReturn ONLY valid JSON: {"start":"2026-03-15T10:00:00","end":"2026-03-15T10:30:00"}`,
    80, 1, ctx.MODEL_HAIKU
  );
  const parsed = ctx.parseJSON(raw);
  if (!parsed?.start || !parsed?.end) throw new Error(`Could not parse time: "${timeStr}"`);
  if (isNaN(Date.parse(parsed.start)) || isNaN(Date.parse(parsed.end))) throw new Error(`Invalid date values from time: "${timeStr}"`);
  return parsed;
}

async function createCalendarEvent(ctx, { summary, startDateTime, endDateTime, attendees, description, isPhoneCall, isInPerson, isGoogleMeet, location }) {
  const calendar = ctx.getCalendar();

  // Atomic conflict check — immediately before insert to minimize race window
  const checkMin = new Date(new Date(startDateTime).getTime() - 5 * 60 * 1000).toISOString();
  const checkMax = new Date(new Date(endDateTime).getTime() + 5 * 60 * 1000).toISOString();
  const conflicting = await fetchCalendarEvents(ctx, { timeMin: checkMin, timeMax: checkMax, maxResults: 10, includeAll: false });
  if (conflicting.length) {
    const conflictList = conflicting.map(e => {
      const s = e.start?.dateTime || e.start?.date || "";
      const fmt = s.includes("T") ? new Date(s).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" }) : s;
      return `"${e.summary || "(no title)"}" at ${fmt}`;
    }).join(", ");
    ctx.addLog(`⚠️ Conflict at booking time for ${summary}: ${conflictList}`, "warning");
    // Notify owner but proceed (they can reschedule)
    if (ctx.alertOwner) await ctx.alertOwner(`⚠️ Calendar conflict: booking "${summary}" at ${startDateTime} clashes with ${conflictList}`).catch(e => ctx.addLog(`⚠️ Alert failed: ${e.message}`, "warning"));
  }

  const useMeet = isGoogleMeet === true || (!isPhoneCall && !isInPerson);
  const event = { summary, description, start: { dateTime: startDateTime, timeZone: "Europe/Rome" }, end: { dateTime: endDateTime, timeZone: "Europe/Rome" }, attendees: attendees.map(email => ({ email })), reminders: { useDefault: true } };
  if (isInPerson && location) event.location = location;
  if (useMeet) event.conferenceData = { createRequest: { requestId: `clara-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } } };
  const res = await calendar.events.insert({ calendarId: "primary", requestBody: event, conferenceDataVersion: useMeet ? 1 : 0, sendUpdates: "all" });
  ctx.addLog(`📅 Calendar event created: ${summary}`, "success");
  ctx.auditDecision({
    action: 'calendar_event_created',
    target: res.data.id,
    detail: `Created: "${summary}" at ${startDateTime} — attendees: ${attendees.join(', ')}`,
    reasoning: 'Meeting confirmed by both parties',
    source: 'email_poll',
  });
  return res.data;
}

async function updateCalendarEvent(ctx, { eventId, startDateTime, endDateTime }) {
  const calendar = ctx.getCalendar();
  const res = await calendar.events.patch({ calendarId: "primary", eventId, sendUpdates: "all", requestBody: { start: { dateTime: startDateTime, timeZone: "Europe/Rome" }, end: { dateTime: endDateTime, timeZone: "Europe/Rome" } } });
  ctx.addLog(`📅 Calendar event updated`, "success");
  ctx.auditDecision({
    action: 'calendar_event_updated',
    target: eventId,
    detail: `Rescheduled to ${startDateTime}`,
    reasoning: 'Reschedule request',
    source: 'email_poll',
  });
  return res.data;
}

async function cancelCalendarEvent(ctx, { eventId }) {
  const calendar = ctx.getCalendar();
  await calendar.events.delete({ calendarId: "primary", eventId, sendUpdates: "all" });
  ctx.addLog(`🗑️ Calendar event cancelled`, "success");
  ctx.auditDecision({
    action: 'calendar_event_cancelled',
    target: eventId,
    detail: 'Calendar event deleted',
    reasoning: 'Cancellation request',
    source: 'email_poll',
  });
}

async function findCalendarEventId(ctx, email, displayName) {
  const calendar = ctx.getCalendar();
  const now = new Date();
  const timeMin = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()).toISOString();
  const timeMax = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()).toISOString();
  const res = await calendar.events.list({ calendarId: "primary", timeMin, timeMax, q: displayName ? `${ctx.OWNER_NAME.split(" ")[0]} // ${displayName}` : email, maxResults: 20, singleEvents: true, orderBy: "startTime" });
  const events = (res.data.items || []).filter(e => e.status !== "cancelled");
  return events.find(e => (e.attendees || []).some(a => a.email.toLowerCase() === email.toLowerCase()))?.id
      || events.find(e => e.summary?.toLowerCase().includes((displayName || "").toLowerCase()))?.id
      || null;
}

async function fetchCalendarEvents(ctx, { timeMin, timeMax, query = null, maxResults = 50, includeAll = false }) {
  const calendar = ctx.getCalendar();
  const params = { calendarId: "primary", timeMin, timeMax, maxResults, singleEvents: true, orderBy: "startTime" };
  if (query) params.q = query;
  const res = await calendar.events.list(params);
  const items = res.data.items || [];
  return includeAll ? items : items.filter(e => e.status !== "cancelled");
}

function formatAttendeeRSVP(ctx, attendees) {
  return (attendees || [])
    .filter(a => !ctx.isOwner(a.email) && a.email.toLowerCase() !== ctx.CLARA_EMAIL.toLowerCase())
    .map(a => `${a.displayName || a.email.split("@")[0]} (${RSVP_LABELS[a.responseStatus] || "unknown"})`)
    .join(", ");
}

function formatOwnerRSVP(ctx, attendees) {
  const ownerAttendee = (attendees || []).find(a => ctx.isOwner(a.email));
  if (!ownerAttendee) return "";
  const status = ownerAttendee.responseStatus || "needsAction";
  const label = RSVP_LABELS[status] || "unknown";
  return ` [${ctx.OWNER_NAME.split(" ")[0]}: ${label}]`;
}

function formatCalendarEvents(ctx, events) {
  if (!events.length) return "No events found.";
  return events.map(e => {
    const start = e.start?.dateTime || e.start?.date || "?";
    const startFmt = start.includes("T")
      ? new Date(start).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" })
      : start;
    const attendeeRsvp = formatAttendeeRSVP(ctx, e.attendees);
    const ownerRsvp = formatOwnerRSVP(ctx, e.attendees);
    const status = e.status === "cancelled" ? " [CANCELLED]" : "";
    return `• ${startFmt} — ${e.summary || "(no title)"}${attendeeRsvp ? " with " + attendeeRsvp : ""}${ownerRsvp}${status}`;
  }).join("\n");
}

async function findFreeSlots(ctx, durationMinutes = 60, daysAhead = 7) {
  try {
    const now  = new Date();
    const end  = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    const busy = await fetchCalendarEvents(ctx, { timeMin: now.toISOString(), timeMax: end.toISOString(), maxResults: 100, includeAll: false });

    const busyIntervals = busy.map(e => ({
      start: new Date(e.start?.dateTime || e.start?.date || now),
      end:   new Date(e.end?.dateTime   || e.end?.date   || now),
    })).sort((a, b) => a.start - b.start);

    const freeSlots = [];
    const cursor = new Date(now);
    cursor.setMinutes(Math.ceil(cursor.getMinutes() / 30) * 30, 0, 0);

    while (freeSlots.length < 5 && cursor < end) {
      const romeHour = parseInt(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", hour: "numeric", hour12: false }).format(cursor), 10);
      const romeDay  = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", weekday: "short" }).format(cursor);

      if (["Sat", "Sun"].includes(romeDay)) { cursor.setDate(cursor.getDate() + 1); cursor.setHours(9, 0, 0, 0); continue; }
      if (romeHour < 9)  { cursor.setHours(9, 0, 0, 0); continue; }
      if (romeHour >= 18) { cursor.setDate(cursor.getDate() + 1); cursor.setHours(9, 0, 0, 0); continue; }

      const slotEnd = new Date(cursor.getTime() + durationMinutes * 60 * 1000);
      const slotEndHour = parseInt(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", hour: "numeric", hour12: false }).format(slotEnd), 10);
      if (slotEndHour > 18) { cursor.setDate(cursor.getDate() + 1); cursor.setHours(9, 0, 0, 0); continue; }

      const clash = busyIntervals.some(b => cursor < b.end && slotEnd > b.start);
      if (!clash) {
        freeSlots.push({
          start: new Date(cursor),
          end:   new Date(slotEnd),
          label: cursor.toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" }) + " CET",
        });
        cursor.setTime(slotEnd.getTime());
      } else {
        cursor.setMinutes(cursor.getMinutes() + 30);
      }
    }
    return freeSlots.length
      ? freeSlots.map((s, i) => `${i + 1}. ${s.label}`).join("\n")
      : "No free slots found in the next working days — please check your calendar.";
  } catch (e) {
    ctx.addLog(`⚠️ findFreeSlots failed: ${e.message}`, "warning");
    return null;
  }
}

async function checkCalendarRSVPs(ctx) {
  try {
    const now = new Date();
    const lookAhead = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const events = await fetchCalendarEvents(ctx, { timeMin: now.toISOString(), timeMax: lookAhead.toISOString(), maxResults: 50, includeAll: false });
    const changes = [];
    for (const ev of events) {
      const attendees = (ev.attendees || []).filter(a => !ctx.isOwner(a.email) && a.email.toLowerCase() !== ctx.CLARA_EMAIL.toLowerCase());
      if (!attendees.length) continue;
      const prev = ctx.rsvpStatus[ev.id] || {};
      const curr = {};
      for (const a of attendees) {
        const email = a.email.toLowerCase();
        const status = a.responseStatus || "needsAction";
        curr[email] = status;
        const prevStatus = prev[email];
        if (prevStatus && prevStatus !== status) {
          const name = a.displayName || email.split("@")[0];
          const startFmt = new Date(ev.start?.dateTime || ev.start?.date).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" });
          changes.push({ name, email, from: prevStatus, to: status, event: ev.summary || "(no title)", time: startFmt, eventId: ev.id });
        }
      }
      ctx.rsvpStatus[ev.id] = curr;
    }
    const activeIds = new Set(events.map(e => e.id));
    for (const id of Object.keys(ctx.rsvpStatus)) {
      if (!activeIds.has(id)) delete ctx.rsvpStatus[id];
    }
    ctx.saveRsvpStatus();
    if (changes.length) {
      const lines = changes.map(c => {
        const label = RSVP_LABELS[c.to] || c.to;
        return `• ${c.name} — ${label} for "${c.event}" (${c.time})`;
      });
      const body = `${ctx.ownerGreeting()}\n\nCalendar RSVP update:\n\n${lines.join("\n")}\n\n${ctx.CLARA_SIGNATURE}`;
      await ctx.sendEmail({ to: ctx.OWNER_DEFAULT, subject: `📅 RSVP update — ${changes.length === 1 ? changes[0].name + " " + (RSVP_LABELS[changes[0].to] || changes[0].to) : changes.length + " responses"}`, body });
      ctx.addLog(`📅 RSVP changes detected: ${changes.map(c => `${c.name} → ${c.to}`).join(", ")}`, "info");
      const declines = changes.filter(c => c.to === "declined");
      if (declines.length && ctx.TELEGRAM_ENABLED && ctx.TELEGRAM_CHAT_ID) {
        await ctx.sendTelegram(ctx.TELEGRAM_CHAT_ID, `📅 ${declines.map(c => `${c.name} declined "${c.event}" (${c.time})`).join("; ")}`).catch(() => {});
      }
    }
  } catch (e) { ctx.addLog(`⚠️ RSVP check error: ${e.message}`, "warning"); }
}

async function bookConfirmedMeeting(ctx, t, confirmedTime) {
  const calDisplayName = t.calendarDisplayName || t.thirdPartyFirstName;
  const allAttendees   = t.thirdPartyEmails ? [ctx.OWNER_CALENDAR, ...t.thirdPartyEmails] : [ctx.OWNER_CALENDAR, t.thirdPartyEmail];
  let calendarLink = "", calendarEventId = "";
  try {
    const times  = await parseTime(ctx, confirmedTime);

    // Conflict detection
    try {
      const bufferMs = 15 * 60 * 1000;
      const checkMin = new Date(new Date(times.start).getTime() - bufferMs).toISOString();
      const checkMax = new Date(new Date(times.end).getTime()   + bufferMs).toISOString();
      const existing = await fetchCalendarEvents(ctx, { timeMin: checkMin, timeMax: checkMax, maxResults: 10, includeAll: false });
      if (existing.length) {
        const conflictList = existing.map(e => {
          const s = e.start?.dateTime || e.start?.date || "";
          const startFmt = s.includes("T") ? new Date(s).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" }) : s;
          return `"${e.summary || "(no title)"}" at ${startFmt}`;
        }).join(", ");
        ctx.addLog(`⚠️ Conflict detected when booking with ${calDisplayName}: ${conflictList}`, "warning");
        const gEmail = t.ownerEmail || ctx.OWNER_DEFAULT;
        await ctx.sendEmail({
          to: gEmail,
          subject: `⚠️ Calendar conflict — ${calDisplayName}`,
          body: `${ctx.ownerGreeting()}\n\nI'm about to confirm the meeting with ${calDisplayName} for ${confirmedTime}, but you already have: ${conflictList}.\n\nI'll go ahead and book it anyway — please let me know if you'd like me to reschedule one of them.\n\n${ctx.CLARA_SIGNATURE}`,
        });
        await ctx.alertOwner(`⚠️ Clara: Conflict when booking ${calDisplayName} at ${confirmedTime} — you already have ${existing[0].summary || "another meeting"}`);
      }
    } catch (e) { ctx.addLog(`⚠️ Conflict check failed: ${e.message}`, "warning"); }

    const params = { summary: `${ctx.OWNER_NAME.split(" ")[0]} // ${calDisplayName}`, startDateTime: times.start, endDateTime: times.end, attendees: allAttendees, description: meetingDescription(ctx, t), isPhoneCall: t.isPhoneCall, isInPerson: t.isInPerson, isGoogleMeet: t.isGoogleMeet, location: t.location };
    if (t.isReschedule) {
      let eventId = t.previousCalendarEventId || await findCalendarEventId(ctx, t.thirdPartyEmail, calDisplayName);
      if (eventId) {
        const updated = await updateCalendarEvent(ctx, { eventId, startDateTime: times.start, endDateTime: times.end });
        calendarLink = updated.hangoutLink || updated.htmlLink || ""; calendarEventId = eventId;
        ctx.addLog(`📅 Rescheduled: ${ctx.OWNER_NAME.split(" ")[0]} // ${calDisplayName}`, "success");
      } else {
        ctx.addLog(`⚠️ Event not found — creating new`, "warning");
        const ev = await createCalendarEvent(ctx, params);
        calendarLink = ev.hangoutLink || ev.htmlLink || ""; calendarEventId = ev.id || "";
      }
    } else {
      const ev = await createCalendarEvent(ctx, params);
      calendarLink = ev.hangoutLink || ev.htmlLink || ""; calendarEventId = ev.id || "";
      ctx.addLog(`📅 Booked: ${ctx.OWNER_NAME.split(" ")[0]} // ${calDisplayName}`, "success");
    }
  } catch (e) { ctx.addLog(`❌ Calendar booking failed: ${e.message}`, "error"); throw e; }

  ctx.learnContact(calDisplayName, t.thirdPartyEmail);
  return { calendarLink, calendarEventId, calDisplayName, allAttendees };
}

async function findEventForAction(ctx, recipientName, recipientEmail, timeHint, gmailThreadId) {
  const { findThread, askClaude, MODEL_HAIKU } = ctx;
  const calendar = ctx.getCalendar();

  const thread = findThread(gmailThreadId);
  if (thread?.cachedCalendarEvents?.length) {
    const cache = thread.cachedCalendarEvents;
    const cacheList = cache.map((e, i) => {
      const startFmt = e.start.includes("T")
        ? new Date(e.start).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" })
        : e.start;
      const attendees = (e.attendees || []).map(a => a.name || a.email).join(", ");
      return `[${i}] ${startFmt} — "${e.summary}"${attendees ? " with " + attendees : ""}`;
    }).join("\n");

    const pick = await askClaude(
      `${ctx.OWNER_NAME} wants to act on a calendar event. Identify which event matches.\n\nAvailable events:\n${cacheList}\n\n` +
      `Person: "${recipientName || ""}"\nEmail: "${recipientEmail || ""}"\nTime hint: "${timeHint || ""}"\n\n` +
      `Reply with ONLY the index number (e.g. "2"), or "NOT_FOUND" if no event clearly matches.`,
      16, 1, MODEL_HAIKU
    );
    const idx = parseInt(pick.trim());
    if (!isNaN(idx) && idx >= 0 && idx < cache.length && cache[idx]) {
      ctx.addLog(`📅 Event found in cache: [${idx}] "${cache[idx].summary}"`, "info");
      return cache[idx].id;
    }
  }

  // Fall back to live calendar search
  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getFullYear(), now.getMonth() + 3, now.getDate()).toISOString();
  const searchQ = recipientName || recipientEmail || timeHint || "";
  if (!searchQ) return null;
  try {
    const res = await calendar.events.list({ calendarId: "primary", timeMin, timeMax, q: searchQ, maxResults: 20, singleEvents: true, orderBy: "startTime" });
    const events = (res.data.items || []).filter(e => e.status !== "cancelled");
    if (!events.length) return null;
    if (events.length === 1) return events[0].id;
    const list = events.map((e, i) => {
      const startFmt = (e.start?.dateTime || e.start?.date || "").includes("T")
        ? new Date(e.start.dateTime).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" })
        : (e.start?.date || "");
      return `[${i}] ${startFmt} — "${e.summary || ""}"`;
    }).join("\n");
    const pick2 = await askClaude(
      `Which of these calendar events matches: person="${recipientName || ""}", time="${timeHint || ""}"?\n${list}\nReply with ONLY the index or NOT_FOUND.`,
      16, 1, MODEL_HAIKU
    );
    const idx2 = parseInt(pick2.trim());
    return (!isNaN(idx2) && events[idx2]) ? events[idx2].id : events[0].id;
  } catch { return null; }
}

module.exports = {
  RSVP_LABELS,
  meetingDescription,
  meetingExtraInfo,
  parseTime,
  createCalendarEvent,
  updateCalendarEvent,
  cancelCalendarEvent,
  findCalendarEventId,
  fetchCalendarEvents,
  formatAttendeeRSVP,
  formatOwnerRSVP,
  formatCalendarEvents,
  findFreeSlots,
  checkCalendarRSVPs,
  bookConfirmedMeeting,
  findEventForAction,
};
