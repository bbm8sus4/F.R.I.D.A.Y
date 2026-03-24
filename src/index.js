// ===== AI Bot — Oracle AI / External Brain =====
// จิตสำนึกดิจิทัลที่จำทุกอย่าง จับ pattern พฤติกรรม แจ้งเตือนเชิงรุก
// Bot name is configured via env.BOT_NAME (defaults to "Friday")

// === Lib imports ===
import { URGENT_PATTERNS, MEMBER_COMMANDS, MEMBER_CALLBACKS } from './lib/constants.js';
import { sendTelegram, sendTelegramWithKeyboard, sendReplyKeyboard, sendMemberReplyKeyboard } from './lib/telegram.js';
import { getUserRole, detectBossMention, parseCommand } from './lib/auth.js';
import { storeMessage } from './lib/context.js';

// === Handler imports ===
import { handleApiRequest } from './handlers/api.js';
import { handleMention, handleMemberChat } from './handlers/mention.js';
import { handleReadhtmlCommand, handleReadpdfCommand, handleReadimgCommand, handleFileCallback, handleFileAsk, handleReadvoiceCommand, handleReadlinkCommand, handleReadlinkCallback, handleReadlinkAsk } from './handlers/read.js';
import { handleSendCommand, handleSendCallback, handleSendReply } from './handlers/send.js';
import { handleRecapCommand, handleRecapCallback, handleRecapReply } from './handlers/recap.js';
import { handleDeleteCommand, handleDeleteCallback } from './handlers/delete.js';
import { handleDashboardCommand, handleTaskCommand, handleTasksCommand, handleDoneCommand, handleCancelCommand, handleTaskCallback } from './handlers/tasks.js';
import { handleRememberCommand, handleMemoriesCommand, handleForgetCommand, handleCooldownCommand, handleHeatupCommand } from './handlers/memory.js';
import { handleAllowCommand, handleRevokeCommand, handleUsersCommand } from './handlers/members.js';
import { handleSummaryCommand, handleSummaryCallback } from './handlers/summary.js';
import { handleCompanyCommand, handleCompanyCallback, handleCompanyReply } from './handlers/company.js';

// === Cron imports ===
import { proactiveAlert } from './cron/proactive-alert.js';
import { proactiveInsightAlert } from './cron/proactive-insight.js';
import { handleProactiveAlertCallback } from './cron/alert-callback.js';
import { summarizeAndCleanup } from './cron/summarize-cleanup.js';

// In-memory throttle for urgent real-time alerts (per-group, 30 min cooldown)
const urgentThrottleMap = new Map();

export default {
  // ===== Webhook Handler =====
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API routes for Mini App
    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, url, env);
    }

    if (request.method !== "POST") {
      return new Response(`${env.BOT_NAME || "Friday"} is watching.`, { status: 200 });
    }

    try {
      const update = await request.json();

      // Handle callback queries (inline keyboard buttons) — role-based
      const callbackQuery = update.callback_query;
      if (callbackQuery) {
        const cbRole = await getUserRole(env, callbackQuery.from.id);
        const cbPrefix = callbackQuery.data?.split(":")[0] + ":";
        if (!cbRole) {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              callback_query_id: callbackQuery.id,
              text: "คุณไม่มีสิทธิ์ใช้ฟังก์ชันนี้ค่ะ",
              show_alert: true,
            }),
          });
          return new Response("OK", { status: 200 });
        }
        if (cbRole === "member" && !MEMBER_CALLBACKS.has(cbPrefix)) {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              callback_query_id: callbackQuery.id,
              text: "ฟังก์ชันนี้สำหรับผู้ดูแลระบบเท่านั้นค่ะ",
              show_alert: true,
            }),
          });
          return new Response("OK", { status: 200 });
        }
        if (callbackQuery.data?.startsWith("rl:")) {
          ctx.waitUntil(handleReadlinkCallback(env, callbackQuery));
          return new Response("OK", { status: 200 });
        }
        if (callbackQuery.data?.startsWith("fc:")) {
          ctx.waitUntil(handleFileCallback(env, callbackQuery));
          return new Response("OK", { status: 200 });
        }
        if (callbackQuery.data?.startsWith("del:")) {
          ctx.waitUntil(handleDeleteCallback(env, callbackQuery));
          return new Response("OK", { status: 200 });
        }
        if (callbackQuery.data?.startsWith("send:")) {
          ctx.waitUntil(handleSendCallback(env, callbackQuery));
          return new Response("OK", { status: 200 });
        }
        if (callbackQuery.data?.startsWith("pa:")) {
          ctx.waitUntil(handleProactiveAlertCallback(env, callbackQuery));
          return new Response("OK", { status: 200 });
        }
        if (callbackQuery.data?.startsWith("recap:")) {
          ctx.waitUntil(handleRecapCallback(env, callbackQuery));
          return new Response("OK", { status: 200 });
        }
        if (callbackQuery.data?.startsWith("tk:")) {
          ctx.waitUntil(handleTaskCallback(env, callbackQuery));
          return new Response("OK", { status: 200 });
        }
        if (callbackQuery.data?.startsWith("co:")) {
          ctx.waitUntil(handleCompanyCallback(env, callbackQuery));
          return new Response("OK", { status: 200 });
        }
        if (callbackQuery.data?.startsWith("sm:")) {
          ctx.waitUntil(handleSummaryCallback(env, callbackQuery));
          return new Response("OK", { status: 200 });
        }
      }

      const message = update.message || update.edited_message;
      if (!message) return new Response("OK", { status: 200 });

      // Handle group → supergroup migration: อัพเดท chat_id ใน DB
      if (message.migrate_to_chat_id) {
        const oldId = message.chat.id;
        const newId = message.migrate_to_chat_id;
        ctx.waitUntil(Promise.all([
          env.DB.prepare(`UPDATE messages SET chat_id = ? WHERE chat_id = ?`).bind(newId, oldId).run(),
          env.DB.prepare(`UPDATE bot_messages SET chat_id = ? WHERE chat_id = ?`).bind(newId, oldId).run(),
          env.DB.prepare(`UPDATE alerts SET chat_id = ? WHERE chat_id = ?`).bind(newId, oldId).run().catch(() => {}),
          env.DB.prepare(`UPDATE group_registry SET chat_id = ? WHERE chat_id = ?`).bind(newId, oldId).run().catch(() => {}),
        ]));
        return new Response("OK", { status: 200 });
      }

      // ข้ามถ้าไม่มี from (channel post)
      if (!message.from) return new Response("OK", { status: 200 });

      let text = message.text || message.caption || "";
      const hasPdf = message.document?.mime_type === "application/pdf";
      const hasHtml = message.document?.mime_type === "text/html";
      const hasPhoto = !!(message.photo?.length > 0 || message.document?.mime_type?.startsWith("image/"));
      const hasMedia = hasPhoto || hasPdf || hasHtml;

      // แนะนำตัวเมื่อถูกเชิญเข้ากลุ่ม
      if (message.new_chat_members) {
        const botJoined = message.new_chat_members.some(
          (m) => m.is_bot && m.username === (env.BOT_USERNAME || "")
        );
        if (botJoined) {
          const intro = `Hello. ${env.BOT_NAME || "Friday"}: Private AI Assistant.`;
          ctx.waitUntil(sendTelegram(env, message.chat.id, intro, null));
          return new Response("OK", { status: 200 });
        }
      }

      if (!text && !hasMedia) return new Response("OK", { status: 200 });

      const botUsername = env.BOT_USERNAME || "";
      const bossId = Number(env.BOSS_USER_ID);
      const isBoss = message.from.id === bossId;
      const isDM = message.chat.type === "private";

      // เก็บทุกข้อความ (ยกเว้นจาก bot เอง)
      if (!message.from.is_bot) {
        ctx.waitUntil(storeMessage(env.DB, message, text, hasMedia));
      }

      // แจ้งเตือนบอสเมื่อมีคนแท็ก/reply/เอ่ยถึงในกลุ่ม
      const mentionType = detectBossMention(message, bossId, env.BOSS_USERNAME, env);
      if (!isDM && !isBoss && mentionType) {
        console.log("Boss mention detected:", mentionType, "from:", message.from?.first_name, "text:", (text || "").substring(0, 50), "entities:", JSON.stringify(message.entities || message.caption_entities || []).substring(0, 200), "is_topic:", message.is_topic_message, "reply_to:", message.reply_to_message?.from?.id);
        const headers = {
          tag:      "📢 มีคนแท็กนายค่ะ!",
          reply:    "💬 มีคน Reply ข้อความนายค่ะ!",
          nickname: "🗣 มีคนเอ่ยถึงนายค่ะ!",
        };
        const header = headers[mentionType] || "📢 มีคนแท็กนายค่ะ!";
        const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const who = esc(message.from.first_name || message.from.username || "ไม่ทราบชื่อ");
        const group = esc(message.chat.title || "กลุ่มไม่ทราบชื่อ");
        const alert = `${header}\n\n👤 ${who}\n💬 กลุ่ม: ${group}\n📝 "${esc(text)}"`;

        const mentionChatId = message.chat.id;
        ctx.waitUntil(sendTelegramWithKeyboard(env, bossId, alert, null, [
          [
            { text: "📋 วิเคราะห์สั้น", callback_data: `pa:s:${mentionChatId}:0` },
            { text: "📝 วิเคราะห์ละเอียด", callback_data: `pa:d:${mentionChatId}:0` },
          ],
          [
            { text: "✅ จัดการแล้ว", callback_data: `pa:h:${mentionChatId}:0` },
            { text: "❌ ไม่สำคัญ", callback_data: `pa:x:${mentionChatId}:0` },
          ],
        ]));
      }

      // Urgent real-time alert — keyword scan (ไม่ต้องรอ cron)
      if (!isDM && !isBoss && !message.from.is_bot && text) {
        const urgentMatch = URGENT_PATTERNS.find(p => p.pattern.test(text));
        if (urgentMatch) {
          const now = Date.now();
          const lastSent = urgentThrottleMap.get(message.chat.id) || 0;
          if (now - lastSent > 30 * 60 * 1000) { // throttle 30 min per group
            urgentThrottleMap.set(message.chat.id, now);
            ctx.waitUntil((async () => {
              const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
              const who = esc(message.from.first_name || message.from.username || "ไม่ทราบชื่อ");
              const group = esc(message.chat.title || "กลุ่มไม่ทราบชื่อ");
              const urgentHeaders = {
                urgent:   "🔴 ด่วน! มีเรื่องเร่งด่วนค่ะ",
                system:   "🔴 ระบบมีปัญหาค่ะ!",
                data:     "🔴 ข้อมูลอาจเสียหายค่ะ!",
                customer: "🔴 ลูกค้ามีปัญหาค่ะ!",
              };
              const urgentHeader = urgentHeaders[urgentMatch.type] || "🔴 URGENT Alert";
              const urgentMsg = `<b>${urgentHeader}</b>\n\n👤 ${who}: ${esc(text.substring(0, 300))}\n\n📁 กลุ่ม: ${group}`;
              // Store in alerts table
              const alertHash = `urgent-${message.chat.id}-${message.message_id}`;
              try {
                await env.DB.prepare(
                  `INSERT INTO alerts (alert_hash, chat_id, chat_title, urgency, category, who, summary, topic_fingerprint, status)
                   VALUES (?, ?, ?, 'critical', 'problem', ?, ?, ?, 'new')`
                ).bind(
                  alertHash,
                  message.chat.id,
                  message.chat.title || null,
                  message.from.username || message.from.first_name || null,
                  text.substring(0, 500),
                  `urgent ${(message.chat.title || '').substring(0, 30)}`,
                ).run();
              } catch (e) { console.error("Urgent alert DB error:", e); }
              await sendTelegramWithKeyboard(env, bossId, urgentMsg, null, [
                [
                  { text: "📋 วิเคราะห์สั้น", callback_data: `pa:s:${message.chat.id}` },
                  { text: "📝 วิเคราะห์ละเอียด", callback_data: `pa:d:${message.chat.id}` },
                ],
                [
                  { text: "✅ จัดการแล้ว", callback_data: `pa:h:${message.chat.id}:0` },
                  { text: "❌ ไม่สำคัญ", callback_data: `pa:x:${message.chat.id}:0` },
                ],
              ]);
            })());
          }
        }
      }

      // Role-based access: boss = full, member = limited, null = rejected
      const role = isBoss ? "boss" : await getUserRole(env, message.from.id);
      if (!role) {
        if (isDM) {
          ctx.waitUntil(sendTelegram(env, message.chat.id, `ขออภัยค่ะ ${env.BOT_NAME || "Friday"} เป็น AI ผู้ช่วยส่วนตัว ไม่อนุญาตให้ใช้งานค่ะ\nหากต้องการใช้งาน กรุณาติดต่อผู้ดูแลระบบค่ะ`, null));
        }
        return new Response("OK", { status: 200 });
      }

      // Reply keyboard shortcuts (DM only)
      if (isDM) {
        const bossShortcutMap = {
          "🧠 Memories": "/memories",
          "🗑 Delete": "/delete",
          "📨 Send": "/send",
          "📋 Recap": "/recap",
          "📝 Tasks": "/tasks",
          "📋 Summary": "/summary",
        };
        const memberShortcutMap = {
          "📝 Tasks": "/tasks",
          "📖 Read Link": "/readlink",
          "📋 Recap": "/recap",
          "🗑 Delete": "/delete",
          "📋 Summary": "/summary",
        };
        const shortcutMap = role === "boss" ? bossShortcutMap : memberShortcutMap;
        if (shortcutMap[text]) text = shortcutMap[text];
      }

      // Commands — role-based access
      const parsed = parseCommand(text);
      if (parsed) {
        // Strip bot mention from args (e.g. "/readhtml @Bot_name" → args = "")
        if (botUsername) {
          parsed.args = parsed.args.replace(new RegExp(`@${botUsername}\\b\\s*`, "i"), "").trim();
        }

        // Member access check
        if (role === "member" && !MEMBER_COMMANDS.has(parsed.cmd)) {
          ctx.waitUntil(sendTelegram(env, message.chat.id, "ฟีเจอร์นี้สำหรับผู้ดูแลระบบเท่านั้นค่ะ", message.message_id));
          return new Response("OK", { status: 200 });
        }

        const handlers = {
          "/send": () => handleSendCommand(env, message, parsed.args),
          "/remember": () => handleRememberCommand(env, message, parsed.args),
          "/memories": () => handleMemoriesCommand(env, message),
          "/forget": () => handleForgetCommand(env, message, parsed.args),
          "/cooldown": () => handleCooldownCommand(env, message, parsed.args),
          "/heatup": () => handleHeatupCommand(env, message, parsed.args),
          "/readvoice": () => handleReadvoiceCommand(env, message, parsed.args),
          "/readlink": () => handleReadlinkCommand(env, message, parsed.args),
          "/readhtml": () => handleReadhtmlCommand(env, message, parsed.args),
          "/readpdf": () => handleReadpdfCommand(env, message, parsed.args),
          "/readimg": () => handleReadimgCommand(env, message, parsed.args),
          "/summary": () => handleSummaryCommand(env, message, parsed.args),
          "/recap": () => handleRecapCommand(env, message),
          "/delete": () => handleDeleteCommand(env, message),
          "/dashboard": () => handleDashboardCommand(env, message),
          "/task": () => handleTaskCommand(env, message, parsed.args),
          "/tasks": () => handleTasksCommand(env, message),
          "/done": () => handleDoneCommand(env, message, parsed.args),
          "/cancel": () => handleCancelCommand(env, message, parsed.args),
          "/menu": () => role === "boss" ? sendReplyKeyboard(env, message.chat.id) : sendMemberReplyKeyboard(env, message.chat.id, message.from.first_name),
          "/start": () => role === "boss" ? sendReplyKeyboard(env, message.chat.id) : sendMemberReplyKeyboard(env, message.chat.id, message.from.first_name),
          "/allow": () => handleAllowCommand(env, message, parsed.args),
          "/revoke": () => handleRevokeCommand(env, message, parsed.args),
          "/users": () => handleUsersCommand(env, message),
          "/company": () => handleCompanyCommand(env, message),
        };

        const handler = handlers[parsed.cmd];
        if (handler) {
          ctx.waitUntil(handler());
          return new Response("OK", { status: 200 });
        }
      }

      // Auto-detect HTML/PDF files (no command needed) — boss + member
      if (role && !parsed && (hasPdf || hasHtml)) {
        if (hasHtml) {
          ctx.waitUntil(handleReadhtmlCommand(env, message, ""));
        } else if (hasPdf) {
          ctx.waitUntil(handleReadpdfCommand(env, message, ""));
        }
        return new Response("OK", { status: 200 });
      }

      // Handle reply-to-bot interactions
      const isReplyToBot = message.reply_to_message?.from?.username === botUsername;
      if (role && isReplyToBot && message.reply_to_message?.text) {
        // rl: and fc: replies — open to boss + member
        const rlMatch = message.reply_to_message.text.match(/\[rl:(\d+)\]/);
        if (rlMatch) {
          ctx.waitUntil(handleReadlinkAsk(env, message, Number(rlMatch[1]), text));
          return new Response("OK", { status: 200 });
        }

        const fcMatch = message.reply_to_message.text.match(/\[fc:(\d+)\]/);
        if (fcMatch) {
          ctx.waitUntil(handleFileAsk(env, message, Number(fcMatch[1]), text));
          return new Response("OK", { status: 200 });
        }

        // recap: replies — open to boss + member
        if (message.reply_to_message.text.startsWith('📋 พิมพ์คำสั่ง')) {
          try {
            const pending = await env.DB.prepare(
              `SELECT target_chat_id FROM pending_recaps WHERE user_id = ?`
            ).bind(message.chat.id).first();
            if (pending) {
              await env.DB.prepare(`DELETE FROM pending_recaps WHERE user_id = ?`).bind(message.chat.id).run();
              ctx.waitUntil(handleRecapReply(env, message, pending.target_chat_id, text));
              return new Response("OK", { status: 200 });
            }
          } catch (e) { /* table might not exist yet */ }
        }

        // send: replies — boss only
        if (role === "boss") {
          if (message.reply_to_message.text.startsWith('📨 สั่ง AI')) {
            try {
              const pending = await env.DB.prepare(
                `SELECT target_chat_id FROM pending_sends WHERE user_id = ?`
              ).bind(message.chat.id).first();
              if (pending) {
                await env.DB.prepare(`DELETE FROM pending_sends WHERE user_id = ?`).bind(message.chat.id).run();
                ctx.waitUntil(handleSendReply(env, message, pending.target_chat_id, text));
                return new Response("OK", { status: 200 });
              }
            } catch (e) { /* table might not exist yet */ }
          }
          const sendMatch = message.reply_to_message.text.match(/\[send:(-?\d+)\]/);
          if (sendMatch) {
            ctx.waitUntil(handleSendReply(env, message, sendMatch[1], text));
            return new Response("OK", { status: 200 });
          }

          // company: add reply — boss only
          if (message.reply_to_message.text.startsWith('🏢 พิมพ์ชื่อบริษัท')) {
            ctx.waitUntil(handleCompanyReply(env, message, text));
            return new Response("OK", { status: 200 });
          }
        }
      }

      // ตอบเมื่อ mention หรือ DM — แยก boss vs member
      const isMentioned = text.includes(`@${botUsername}`) || isDM || isReplyToBot;
      if (isMentioned) {
        if (role === "boss") {
          ctx.waitUntil(handleMention(env, message, botUsername, text, hasMedia, isDM));
        } else if (role === "member") {
          ctx.waitUntil(handleMemberChat(env, message, botUsername, text, hasMedia));
        }
      }

      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("Worker error:", err);
      return new Response("OK", { status: 200 });
    }
  },

  // ===== Cron Trigger — Proactive Alert + Cleanup ทุก 3 ชม. =====
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([proactiveAlert(env), proactiveInsightAlert(env), summarizeAndCleanup(env)]));
  },
};
