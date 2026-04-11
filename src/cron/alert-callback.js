import { sendTelegram, sendTelegramWithKeyboard, sendTyping } from '../lib/telegram.js';
import { escapeHtml, sanitizeHtml } from '../lib/html-utils.js';
import { getSmartContext } from '../lib/context.js';
import { askGemini } from '../lib/gemini.js';
import { parseAndExecuteActions } from '../lib/actions.js';

export function parseSuggestions(text) {
  const strategies = [
    // Strategy 1: Original — quoted text with " or "
    /([1-4])\.\s+(.+?):\s*["\u201C]([\s\S]+?)["\u201D]/g,
    // Strategy 2: Bold HTML label — <b>label</b>: text
    /([1-4])\.\s+<b>(.+?)<\/b>:\s*([\s\S]+?)(?=\n[1-4]\.|$)/g,
    // Strategy 3: **bold** label — **label**: text
    /([1-4])\.\s+\*\*(.+?)\*\*:\s*([\s\S]+?)(?=\n[1-4]\.|$)/g,
    // Strategy 4: Simple colon — N. label: text (no quotes needed)
    /([1-4])\.\s+([^:\n]+?):\s+"?(.+?)"?\s*(?=\n[1-4]\.|$)/g,
  ];

  for (const regex of strategies) {
    const suggestions = [];
    let match;
    regex.lastIndex = 0;
    while ((match = regex.exec(text)) !== null) {
      suggestions.push({
        num: match[1],
        label: match[2].trim().replace(/\s*\(.*?\)\s*$/, ''),
        text: match[3].trim().replace(/^[""\u201C]+|[""\u201D]+$/g, '')
      });
    }
    if (suggestions.length >= 2) return suggestions;
  }
  return null;
}

// ===== Proactive Alert Callback Handler (pa:*) =====

export async function handleProactiveAlertCallback(env, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  // Parse callback data: "pa:<mode>:<groupChatId>:<alertId>"
  const parts = callbackQuery.data.split(":");
  const mode = parts[1]; // s = short, d = detail, h = handled, x = dismissed
  const groupChatId = Number(parts[2]);
  const alertId = parts[3] ? Number(parts[3]) : 0;

  // Escape original text for HTML
  const originalText = (callbackQuery.message.text || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Helper: editMessageText
  const editPreview = async (html, keepButtons = false) => {
    const body = {
      chat_id: chatId,
      message_id: messageId,
      text: sanitizeHtml(html),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    };
    if (!keepButtons) body.reply_markup = { inline_keyboard: [] };
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error("pa editPreview failed:", await res.text());
    }
    return res.ok;
  };

  // Helper: update alert status in DB
  const updateAlertStatus = async (status, action) => {
    if (!alertId) return;
    try {
      await env.DB.prepare(
        `UPDATE alerts SET status = ?, boss_action = ? WHERE id = ?`
      ).bind(status, action, alertId).run();

      // Learning: adjust group priority_weight based on feedback
      if (status === 'handled' || status === 'analyzing') {
        await env.DB.prepare(
          `UPDATE group_registry SET priority_weight = MIN(3.0, priority_weight + 0.1) WHERE chat_id = ?`
        ).bind(groupChatId).run();
      } else if (status === 'dismissed') {
        await env.DB.prepare(
          `UPDATE group_registry SET priority_weight = MAX(0.2, priority_weight - 0.15) WHERE chat_id = ?`
        ).bind(groupChatId).run();
      }
    } catch (e) { console.error("Alert status update error:", e); }
  };

  // Handle "จัดการแล้ว" button
  if (mode === "h") {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQuery.id, text: "✅ จัดการแล้ว" }),
    });
    await updateAlertStatus("handled", "handled");
    await editPreview(`${originalText}\n\n✅ <b>จัดการแล้ว</b>`);
    return;
  }

  // Handle "ไม่สำคัญ" button
  if (mode === "x") {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQuery.id, text: "❌ ปัดทิ้ง" }),
    });
    await updateAlertStatus("dismissed", "dismissed");
    await editPreview(`${originalText}\n\n❌ <b>ไม่สำคัญ — ปัดทิ้งแล้ว</b>`);
    return;
  }

  const modeLabels = { s: "วิเคราะห์สั้น", d: "วิเคราะห์ละเอียด" };

  // Answer callback query (toast)
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQuery.id,
      text: "⏳ กำลังวิเคราะห์...",
    }),
  });

  // Update alert status to analyzing
  await updateAlertStatus("analyzing", modeLabels[mode]);

  // Update preview: กำลังวิเคราะห์ + ลบปุ่ม
  const editOk = await editPreview(`${originalText}\n\n⏳ <b>กำลัง${modeLabels[mode] || "วิเคราะห์"}...</b>`);
  if (!editOk) return;

  try {
    // Fetch recent messages จากกลุ่มนั้น
    const { results: recentMsgs } = await env.DB
      .prepare(
        `SELECT username, first_name, message_text, chat_title,
                datetime(created_at, '+7 hours') as created_at
         FROM messages
         WHERE chat_id = ? AND created_at > datetime('now', '-6 hours')
         ORDER BY created_at ASC LIMIT 200`
      )
      .bind(groupChatId)
      .all();

    if (recentMsgs.length === 0) {
      await editPreview(`${originalText}\n\n❌ <b>ไม่พบข้อความล่าสุดในกลุ่มนี้</b>`);
      return;
    }

    const groupTitle = recentMsgs[0].chat_title || "Unknown";
    let conversation = "";
    for (const msg of recentMsgs) {
      const name = msg.username ? `@${msg.username}` : msg.first_name || "Unknown";
      conversation += `[${msg.created_at}] ${name}: ${msg.message_text}\n`;
    }

    const alertText = callbackQuery.message.text || "";
    const bt = env.BOSS_TITLE || "นาย";
    const depthInstruction = mode === "s"
      ? `วิเคราะห์สั้นกระชับ 3-5 ประโยค พร้อมแนะนำคำตอบ/แนวทางสั้นๆ ที่${bt}สามารถตอบกลับได้ทันที`
      : `วิเคราะห์ละเอียดครบทุกมิติ รวมถึงบริบท สาเหตุ ผลกระทบ ความเสี่ยง และแนะนำคำตอบ/แนวทางที่เหมาะสมให้${bt}พร้อมเหตุผล`;

    const noIntro = "[คำสั่งสำคัญ: ห้ามขึ้นต้นด้วย 'รับทราบ' 'สรุปให้ดังนี้' หรือเกริ่นนำใดๆ — เริ่มเนื้อหาทันที]";
    const prompt = `${noIntro}
จาก Proactive Alert ที่แจ้งเตือนเรื่องนี้:
"${alertText}"

กลุ่ม: ${groupTitle}

${depthInstruction}

โครงสร้างคำตอบ:
1. วิเคราะห์สถานการณ์ — เกิดอะไรขึ้น ใครเกี่ยวข้อง
2. ประเมินความสำคัญ/ความเร่งด่วน
3. แนะนำคำตอบ — ข้อความที่${bt}สามารถตอบกลับในกลุ่มได้เลย (ให้ครบ 4 ตัวเลือกเสมอ โทนต่างกัน เช่น ทางการ/เป็นกันเอง/สั้นกระชับ/ถามกลับ)
4. แนวทางถัดไป — ควรทำอะไรต่อ

บทสนทนาล่าสุดในกลุ่ม:
${conversation}`;

    await sendTyping(env, chatId);
    const context = await getSmartContext(env.DB, groupChatId, false, "");
    const reply = await askGemini(env, prompt, context, null, { feature: 'alert_callback', chatId: groupChatId });
    const { cleanReply } = await parseAndExecuteActions(env, reply);
    if (cleanReply) {
      await sendTelegram(env, chatId, cleanReply, null, true);

      // Send copy buttons for suggested replies
      const suggestions = parseSuggestions(cleanReply);
      if (suggestions) {
        const numEmoji = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
        const buttons = suggestions.map((s, i) => [{
          text: `📋 ${numEmoji[i] || '▪️'} ${s.label}`,
          copy_text: { text: s.text.substring(0, 256) }
        }]);
        await sendTelegramWithKeyboard(env, chatId, '📋 กดเพื่อคัดลอกข้อความตอบกลับ:', null, buttons);
      }
    }
    await updateAlertStatus("handled", modeLabels[mode]);
    await editPreview(`${originalText}\n\n✅ <b>${modeLabels[mode] || "วิเคราะห์"}แล้ว</b>`);
  } catch (err) {
    console.error("handleProactiveAlertCallback error:", err.message, err.stack);
    await editPreview(`${originalText}\n\n❌ <b>เกิดข้อผิดพลาด</b> — ลองใหม่ภายหลังค่ะ`);
  }
}
