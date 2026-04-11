/**
 * @module telegram-handler
 * @description Telegram bot integration for Clara.
 *
 * Handles:
 * - Sending messages to the owner via Telegram (with HTML fallback)
 * - Sending files/documents via Telegram
 * - Webhook setup and message routing
 * - Inline keyboard handling
 * - Chat ID auto-detection
 * - File downloads from Telegram servers
 * - Voice note handling
 * - File vault integration (save received documents)
 * - Expense auto-detection from images/PDFs
 * - Chat conversation history for context
 *
 * All functions receive a shared `ctx` context object.
 */

const crypto = require("crypto");

// ─── Chat conversation history ──────────────────────────────────────────────
const chatHistory = [];
const MAX_CHAT_HISTORY = 20;

function addChatHistory(role, text) {
  chatHistory.push({ role, text: text.slice(0, 500), time: new Date().toISOString() });
  if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.splice(0, chatHistory.length - MAX_CHAT_HISTORY);
}

function getChatContext(ctx) {
  if (!chatHistory.length) return "";
  return "\n=== RECENT CHAT HISTORY ===\n" +
    chatHistory.map(m => `[${m.role === "owner" ? ctx.OWNER_NAME : "Clara"}] ${m.text}`).join("\n") +
    "\n=== END CHAT HISTORY ===\n";
}

// ─── Send a text message via Telegram ──────────────────────────────────────
async function sendTelegram(ctx, chatId, message) {
  if (!ctx.TELEGRAM_ENABLED || !chatId) { ctx.addLog(`⚠️ Telegram skipped (not configured): ${message.slice(0, 60)}`, "warning"); return; }
  try {
    const text = message.length > 4096 ? message.slice(0, 4090) + "\n[…]" : message;
    const res = await fetch(`https://api.telegram.org/bot${ctx.TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    const data = await res.json();
    if (data.ok) ctx.addLog(`💬 Telegram sent`, "success");
    else {
      // Retry without HTML parse mode if it fails (formatting issues)
      const res2 = await fetch(`https://api.telegram.org/bot${ctx.TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      const data2 = await res2.json();
      if (data2.ok) ctx.addLog(`💬 Telegram sent (plain)`, "success");
      else ctx.addLog(`⚠️ Telegram failed: ${JSON.stringify(data2.description || data2)}`, "warning");
    }
  } catch (e) { ctx.addLog(`❌ Telegram error: ${e.message}`, "error"); }
}

// ─── Alert the owner via Telegram ─────────────────────────────────────────
async function alertOwner(ctx, message) {
  if (ctx.TELEGRAM_ENABLED && ctx.TELEGRAM_CHAT_ID) await sendTelegram(ctx, ctx.TELEGRAM_CHAT_ID, message).catch(e => ctx.addLog(`⚠️ Telegram alert failed: ${e.message}`, "warning"));
}

// ─── Download a file from Telegram by file_id ─────────────────────────────
async function downloadTelegramFile(ctx, fileId) {
  const fileInfo = await fetch(`https://api.telegram.org/bot${ctx.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`).then(r => r.json());
  if (!fileInfo.ok || !fileInfo.result?.file_path) throw new Error("Could not get file path from Telegram");
  const fileUrl = `https://api.telegram.org/file/bot${ctx.TELEGRAM_TOKEN}/${fileInfo.result.file_path}`;
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ─── Generic inbound message handler (from Telegram or other channels) ────
async function handleInboundMessage(ctx, body, replyFn) {
  addChatHistory("owner", body);

  try {
    const rawTasks = await ctx.parseInstructions(body, `Message from ${ctx.OWNER_NAME}`);
    if (!rawTasks?.length) {
      const msgLang = ctx.sanitiseLang(await ctx.detectLanguage(body));
      const smallTalkCheck = await ctx.askClaude(
        `Is this message casual small talk, a greeting, or a personal/conversational exchange (e.g. "hi", "how are you", "what day is it", "good morning", "thank you", "you're amazing")? ` +
        `Or is it a task, question about work, or request for information?\nMessage: ${ctx.wrapUntrusted(body)}\nReply with SMALLTALK or TASK.`,
        10, 1, ctx.MODEL_FAST
      );
      const isSmallTalk = smallTalkCheck.trim().startsWith("SMALLTALK");
      const threadSummary = Object.entries(ctx.activeThreads)
        .filter(([, t]) => t.stage !== "done" && t.stage !== "cancelled" && t.thirdPartyFirstName)
        .map(([, t]) => `- ${t.thirdPartyFirstName} (${t.thirdPartyEmail}), stage=${t.stage}`)
        .join("\n") || "No active threads.";
      const recentLogs = ctx.logs.slice(0, 20).map(l => `[${new Date(l.time).toLocaleTimeString("en-GB")}] ${l.message}`).join("\n");
      let calendarInfo = "";
      try {
        const now = new Date();
        const end = new Date(now.getTime() + 48 * 60 * 60 * 1000);
        const events = await ctx.fetchCalendarEvents({ timeMin: now.toISOString(), timeMax: end.toISOString(), maxResults: 10, includeAll: false });
        calendarInfo = events.length ? ctx.formatCalendarEvents(events) : "No upcoming meetings in next 48h.";
      } catch { calendarInfo = "(calendar unavailable)"; }

      let answer;
      if (isSmallTalk) {
        answer = await ctx.askClaude(
          `${ctx.withRules(ctx.SNIPPET_OWNER_REPLY)}\n\n` +
          getChatContext(ctx) +
          `${ctx.OWNER_NAME} sent you this message: ${ctx.wrapUntrusted(body)}\n\n` +
          `This is casual conversation. Respond warmly and naturally — like a real person texting back. ` +
          `You can be charming, witty, or affectionate as fits your character. Keep it short (1-3 sentences). ` +
          `No sign-off or signature. Write in ${msgLang}.`,
          200, 1, ctx.MODEL_HAIKU
        );
      } else {
        answer = await ctx.askClaude(
          `${ctx.withRules(ctx.SNIPPET_OWNER_REPLY)}\n\n${ctx.MSG_STYLE}\n\n` +
          getChatContext(ctx) +
          `${ctx.OWNER_NAME}'s latest message: ${ctx.wrapUntrusted(body)}\n\n` +
          `=== ACTIVE THREADS ===\n${threadSummary}\n\n` +
          `=== UPCOMING CALENDAR ===\n${calendarInfo}\n\n` +
          `=== RECENT ACTIVITY ===\n${recentLogs}\n\n` +
          `Answer his question using the data above. Use the chat history to understand context — ` +
          `if he says "it", "that", "where", etc., refer to what was discussed in the previous messages. ` +
          `NEVER show technical errors, IDs, or system details. If something went wrong, explain it simply. ` +
          `Write in ${msgLang}.`,
          400, 1, ctx.MODEL_FAST
        );
      }
      addChatHistory("clara", answer);
      await replyFn(answer);
      return;
    }

    const { tasks } = await ctx.resolveRecipientEmails(rawTasks, body);
    const results   = [];
    for (const task of tasks) {
      try {
        const result = await ctx.executeTask(task, {
          fromAddress: ctx.OWNER_DEFAULT, subject: `Message from ${ctx.OWNER_NAME}`,
          body, messageId: `msg_${Date.now()}`, gmailThreadId: `msg_${Date.now()}`,
          ownerLang: ctx.sanitiseLang(await ctx.detectLanguage(body)),
        });
        results.push(result);
      } catch (e) { results.push({ ok: false, detail: e.message }); }
    }

    const doneItems  = results.filter(r => r.ok).map(r => r.detail);
    const failItems  = results.filter(r => !r.ok).map(r => r.detail);
    const msgLang2 = ctx.sanitiseLang(await ctx.detectLanguage(body));
    const summary = await ctx.askClaude(
      `${ctx.SNIPPET_IDENTITY}\n${ctx.MSG_STYLE}\n\n` +
      getChatContext(ctx) +
      `You just completed these tasks for ${ctx.OWNER_NAME}:\n` +
      (doneItems.length ? `Done: ${doneItems.join(", ")}\n` : "") +
      (failItems.length ? `Problems: ${failItems.join(", ")}\n` : "") +
      `Write a 1-2 line confirmation in ${msgLang2}. No greeting, no sign-off. ` +
      `NEVER mention technical details like thread IDs or error codes. ` +
      `If something failed, explain it in plain language (e.g. "I couldn't find their email" not "invalid thread ID").`,
      200, 1, ctx.MODEL_FAST
    );
    const reply = summary || (doneItems.length ? `Done — ${doneItems.join(", ")}` : "Sorry, I couldn't complete that. Can you give me more details?");
    addChatHistory("clara", reply);
    await replyFn(reply);
  } catch (e) {
    ctx.addLog(`❌ Message handler error: ${e.message}`, "error");
    const errorReply = "Sorry, I ran into an issue processing that. Could you rephrase or give me more details?";
    addChatHistory("clara", errorReply);
    await replyFn(errorReply);
  }
}

// ─── Register the Telegram webhook route on the Express app ────────────────
function registerWebhook(app, ctx) {
  const TELEGRAM_WEBHOOK_PATH = ctx.TELEGRAM_ENABLED
    ? `/telegram/inbound/${crypto.createHash('sha256').update(ctx.TELEGRAM_TOKEN).digest('hex').slice(0, 16)}`
    : "/telegram/inbound";

  app.post(TELEGRAM_WEBHOOK_PATH, async (req, res) => {
    res.sendStatus(200);
    try {
      const msg = req.body?.message;
      if (!msg) return;
      const chatId = String(msg.chat?.id || "");
      const from   = msg.from?.first_name || "Unknown";
      if (!chatId) return;

      if (!ctx.TELEGRAM_CHAT_ID) {
        ctx.TELEGRAM_CHAT_ID = chatId;
        ctx.addLog(`📱 Telegram chat ID auto-detected: ${chatId} (from ${from})`, "success");
        console.log(`[SECURE] TELEGRAM_CHAT_ID=${chatId} — save this in Render env vars for persistence across deploys`);
      }

      if (chatId !== ctx.TELEGRAM_CHAT_ID) {
        ctx.addLog(`⚠️ Telegram from unknown chat ${chatId} (${from}) — ignored`, "warning");
        await sendTelegram(ctx, chatId, `Sorry, I only take instructions from ${ctx.OWNER_NAME}.`);
        return;
      }

      // Handle file/document messages
      const doc = msg.document || null;
      const photo = msg.photo?.length ? msg.photo[msg.photo.length - 1] : null;
      if (doc || photo) {
        const fileId   = doc ? doc.file_id : photo.file_id;
        const fileName = doc ? (doc.file_name || "document") : `photo_${Date.now()}.jpg`;
        const mimeType = doc ? (doc.mime_type || "application/octet-stream") : "image/jpeg";
        const caption  = msg.caption || "";
        ctx.addLog(`📎 Telegram file from ${ctx.OWNER_NAME}: "${fileName}"${caption ? ` — "${caption.slice(0, 60)}"` : ""}`, "info");

        try {
          const buffer = await downloadTelegramFile(ctx, fileId);
          const entry = ctx.vaultSave(fileName, buffer, { mimeType, source: "telegram", caption });
          addChatHistory("owner", `[Sent file: ${fileName}]${caption ? " " + caption : ""}`);

          // Extract text from PDFs
          if (mimeType === "application/pdf" && ctx.pdfParse) {
            try {
              const pdfData = await ctx.pdfParse(buffer);
              if (pdfData.text) {
                entry.textContent = pdfData.text.slice(0, 10000);
                ctx.saveVaultIndex();
                ctx.addLog(`📄 Extracted ${pdfData.text.length} chars from PDF "${fileName}"`, "info");
              }
            } catch (e) { ctx.addLog(`⚠️ PDF text extraction failed: ${e.message}`, "warning"); }
          } else if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
            ctx.addLog(`📄 Word document "${fileName}" received — text extraction not supported yet`, "info");
          }

          const isContentQuestion = caption && /\b(summarize|summarise|summary|what does|what's in|read|content|analyze|analyse|review|tell me about|what is this|explain)\b/i.test(caption);
          const isTextReadable = /^text\/(plain|csv|html|xml|markdown)|application\/(json|xml|csv)/.test(mimeType);
          const isPdfOrDocx = /pdf|msword|wordprocessingml|opendocument/.test(mimeType);

          if (isContentQuestion && isTextReadable) {
            const fileText = buffer.toString("utf-8").slice(0, 8000);
            const answer = await ctx.askClaude(
              `${ctx.MSG_STYLE}\n\n${ctx.OWNER_NAME} sent a file called "${fileName}" and asked: "${caption}"\n\nFile contents:\n${ctx.wrapUntrusted(fileText)}\n\nAnswer his question based on the file contents.`,
              600, 1, ctx.MODEL_FAST
            );
            addChatHistory("clara", answer);
            await sendTelegram(ctx, chatId, answer);
          } else if (isContentQuestion && isPdfOrDocx && entry.textContent) {
            const answer = await ctx.askClaude(
              `${ctx.MSG_STYLE}\n\n${ctx.OWNER_NAME} sent a PDF called "${fileName}" and asked: "${caption}"\n\nExtracted text from the PDF:\n${ctx.wrapUntrusted(entry.textContent.slice(0, 8000))}\n\nAnswer his question based on the document contents.`,
              600, 1, ctx.MODEL_FAST
            );
            addChatHistory("clara", answer);
            await sendTelegram(ctx, chatId, answer);
          } else if (isContentQuestion && isPdfOrDocx) {
            const reply = `Saved "${fileName}" to your vault. I can't read ${mimeType.includes("pdf") ? "PDFs" : "Word documents"} yet — but I've got the file whenever you need to send it to someone.`;
            addChatHistory("clara", reply);
            await sendTelegram(ctx, chatId, reply);
          } else if (caption && caption.length > 3) {
            const augmented = `${caption}\n\n[FILE ATTACHED: "${fileName}" saved in vault as ${entry.id}]`;
            await handleInboundMessage(ctx, augmented, (m) => sendTelegram(ctx, chatId, m));
          } else {
            // Expense auto-detection for images/PDFs
            const isImage = mimeType.startsWith("image/") || !!photo;
            const isPdf = mimeType === "application/pdf";
            const looksLikeSendInstruction = caption && /\b(send|forward|share|give|email)\b/i.test(caption);

            if ((isImage || isPdf) && !looksLikeSendInstruction) {
              try {
                let expenseCheck;
                // Use Claude vision for images — far more accurate than text-only
                if (isImage) {
                  const b64 = buffer.toString("base64");
                  const mediaMime = mimeType.startsWith("image/") ? mimeType : "image/jpeg";
                  expenseCheck = await ctx.askClaudeVision(
                    [
                      { type: "image", source: { type: "base64", media_type: mediaMime, data: b64 } },
                      { type: "text", text: `Is this image an invoice, receipt, or expense document? If YES, extract: vendor name, amount (number only), currency (e.g. EUR, USD, GBP), description, date (ISO format).\nReply with JSON: {"isExpense":true,"vendor":"...","amount":123.45,"currency":"EUR","description":"...","date":"2026-01-15"}\nIf NOT an expense, reply with: NOT_EXPENSE` },
                    ],
                    200, ctx.MODEL_FAST
                  );
                } else {
                  const expenseContext = entry.textContent
                    ? `Extracted text from document:\n${ctx.wrapUntrusted(entry.textContent.slice(0, 3000))}`
                    : `File: "${fileName}" (${mimeType})${caption ? `, caption: "${caption}"` : ""}`;
                  expenseCheck = await ctx.askClaude(
                    `Is this document/image likely an invoice, receipt, or expense document? ${expenseContext}\n\nIf YES, extract: vendor name, amount (number only), currency (e.g. EUR, USD, GBP), description, date (ISO format).\nReply with JSON: {"isExpense":true,"vendor":"...","amount":123.45,"currency":"EUR","description":"...","date":"2026-01-15"}\nIf NOT an expense, reply with: NOT_EXPENSE`,
                    200, 1, ctx.MODEL_FAST
                  );
                }
                if (expenseCheck.trim() !== "NOT_EXPENSE" && expenseCheck.includes("isExpense")) {
                  try {
                    const exp = ctx.parseJSON(expenseCheck);
                    if (exp.isExpense && exp.vendor && exp.amount) {
                      const expense = {
                        id: `exp_${Date.now()}`,
                        vendor: exp.vendor,
                        amount: exp.amount,
                        currency: exp.currency || "EUR",
                        description: exp.description || "",
                        date: exp.date || new Date().toISOString().slice(0, 10),
                        source: "telegram_auto",
                        fileId: entry.id,
                        addedAt: new Date().toISOString(),
                      };
                      ctx.expenses.push(expense);
                      ctx.saveExpenses();
                      const expReply = `Logged expense: ${exp.currency || "EUR"} ${exp.amount} from ${exp.vendor}. Saved "${fileName}" to your vault.`;
                      addChatHistory("clara", expReply);
                      await sendTelegram(ctx, chatId, expReply);
                      ctx.addLog(`💰 Auto-detected expense: ${exp.currency || "EUR"} ${exp.amount} from ${exp.vendor}`, "success");
                      return;
                    }
                  } catch { /* not valid expense JSON */ }
                }
              } catch (e) { ctx.addLog(`⚠️ Expense detection error: ${e.message}`, "warning"); }
            }

            const reply = `Got it — saved "${fileName}". Just tell me who to send it to whenever you need.`;
            addChatHistory("clara", reply);
            await sendTelegram(ctx, chatId, reply);
          }
        } catch (e) {
          ctx.addLog(`❌ Telegram file download failed: ${e.message}`, "error");
          const reply = `I couldn't download the file — ${e.message}. Could you try sending it again?`;
          addChatHistory("clara", reply);
          await sendTelegram(ctx, chatId, reply);
        }
        return;
      }

      // Handle voice notes — transcribe via Google Cloud Speech-to-Text or store for later
      const voice = msg.voice || msg.audio || null;
      if (voice) {
        ctx.addLog(`🎤 Voice note from ${ctx.OWNER_NAME} (${voice.duration}s)`, "info");
        addChatHistory("owner", "[Voice note]");

        try {
          const buffer = await downloadTelegramFile(ctx, voice.file_id);
          const entry = ctx.vaultSave(`voice_${Date.now()}.ogg`, buffer, { mimeType: "audio/ogg", source: "telegram", caption: "Voice note" });

          // Attempt transcription via Google Cloud Speech-to-Text (requires API enabled)
          let transcript = null;
          try {
            const speech = ctx.getGoogleSpeech?.();
            if (speech) {
              const [response] = await speech.recognize({
                config: { encoding: "OGG_OPUS", sampleRateHertz: 48000, languageCode: "en-US", alternativeLanguageCodes: ["it-IT", "fr-FR", "de-DE", "es-ES"] },
                audio: { content: buffer.toString("base64") },
              });
              transcript = (response.results || []).map(r => r.alternatives?.[0]?.transcript || "").join(" ").trim();
            }
          } catch (e) {
            ctx.addLog(`⚠️ Speech-to-text failed: ${e.message}`, "warning");
          }

          if (transcript) {
            ctx.addLog(`🎤 Transcribed voice: "${transcript.slice(0, 80)}"`, "success");
            entry.transcript = transcript;
            ctx.saveVaultIndex();
            await handleInboundMessage(ctx, transcript, (m) => sendTelegram(ctx, chatId, m));
          } else {
            const reply = "Got your voice note and saved it. I can't transcribe audio yet — could you type that out for me?";
            addChatHistory("clara", reply);
            await sendTelegram(ctx, chatId, reply);
          }
        } catch (e) {
          ctx.addLog(`❌ Voice note processing failed: ${e.message}`, "error");
          const reply = "I couldn't process the voice note. Could you type your message instead?";
          addChatHistory("clara", reply);
          await sendTelegram(ctx, chatId, reply);
        }
        return;
      }

      // Handle text messages
      const text = (msg.text || "").trim();
      if (!text) return;
      ctx.addLog(`💬 Telegram from ${ctx.OWNER_NAME}: "${text.slice(0, 80)}"`, "info");

      if (text === "/start") {
        await sendTelegram(ctx, chatId, `Hello! ${ctx.CLARA_NAME} here. Send me anything — tasks, questions, files, or just say hi.`);
        return;
      }
      if (text === "/vault" || text.toLowerCase() === "vault" || text.toLowerCase() === "my files") {
        if (!ctx.vaultIndex.length) { await sendTelegram(ctx, chatId, "No files saved yet. Send me a document and I'll keep it for you."); return; }
        const list = ctx.vaultIndex.slice(-10).map(f => `• ${f.originalName} (${(f.size/1024).toFixed(0)} KB, ${new Date(f.savedAt).toLocaleDateString("en-GB")})`).join("\n");
        await sendTelegram(ctx, chatId, `Your files (last 10):\n\n${list}\n\nTell me to send any of these to someone by name.`);
        return;
      }

      await handleInboundMessage(ctx, text, (m) => sendTelegram(ctx, chatId, m));
    } catch (e) {
      ctx.addLog(`❌ Telegram webhook error: ${e.message}`, "error");
      if (ctx.TELEGRAM_CHAT_ID) await sendTelegram(ctx, ctx.TELEGRAM_CHAT_ID, `Sorry, I hit a problem: ${e.message}`).catch(() => {});
    }
  });

  return TELEGRAM_WEBHOOK_PATH;
}

// ─── Register the Telegram webhook with Telegram servers on startup ────────
async function registerWebhookWithTelegram(ctx, PORT, TELEGRAM_WEBHOOK_PATH) {
  if (!ctx.TELEGRAM_ENABLED) return;
  const baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://localhost:${PORT}`;
  const webhookUrl = `${baseUrl}${TELEGRAM_WEBHOOK_PATH}`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${ctx.TELEGRAM_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl, allowed_updates: ["message"] }),
    });
    const data = await res.json();
    if (data.ok) ctx.addLog(`📱 Telegram webhook registered: ${webhookUrl}`, "success");
    else ctx.addLog(`⚠️ Telegram webhook failed: ${data.description}`, "warning");
  } catch (e) { ctx.addLog(`⚠️ Telegram webhook setup failed: ${e.message}`, "warning"); }
}

module.exports = {
  sendTelegram,
  alertOwner,
  downloadTelegramFile,
  handleInboundMessage,
  registerWebhook,
  registerWebhookWithTelegram,
  addChatHistory,
  getChatContext,
};
