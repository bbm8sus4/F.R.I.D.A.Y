import { sendTelegram, sendTelegramWithKeyboard, sendTyping, trackBotMessage, getReplyKeyboardMarkup } from "../lib/telegram.js";
import { askGemini } from "../lib/gemini.js";
import { getTargetGroupContext } from "../lib/context.js";
import { stripHtmlTags } from "../lib/html-utils.js";

const MAX_REVISIONS = 5;

// ===== Helper functions =====

function cleanAiResponse(text) {
  return stripHtmlTags(
    text
      .replace(/\[SEND:[^\]]+\]/g, '')
      .replace(/\[REMEMBER:\w+:[^\]]+\]/g, '')
      .replace(/\[FORGET:\d+\]/g, '')
      .replace(/[•*\-]?\s*<a\s+href="https?:\/\/vertexaisearch\.cloud\.google\.com\/[^"]*">[^<]*<\/a>/g, '')
  ).replace(/\n*\s*🔗?\s*แหล่งข้อมูล:?\s*$/, '').replace(/\n{3,}/g, '\n\n').trim();
}

function buildSendPrompt({ instruction, groupName, companyName, participants, previousDraft, editFeedback, botName }) {
  let prompt = `บอสต้องการให้เขียนข้อความเพื่อส่งไปยังกลุ่ม "${groupName}"`;
  if (companyName) prompt += ` (บริษัท: ${companyName})`;
  prompt += `\n\nคำสั่งจากบอส: ${instruction}`;

  if (participants.length > 0) {
    prompt += `\n\nสมาชิกในกลุ่ม: ${participants.join(", ")}`;
  }

  prompt += `\n\n=== กฎการเขียน ===
- เขียนในน้ำเสียงของ ${botName} (ผู้หญิง ใช้ค่ะ/คะ) — ในฐานะผู้ช่วยของบอสที่ส่งข้อความแทน
- ปรับ tone ให้เหมาะกับบริบทกลุ่ม (ดูจากบทสนทนาล่าสุด)
- เพิ่มรายละเอียดจากบริบทที่มี ถ้าทำให้ข้อความสมบูรณ์ขึ้น
- กระชับ ตรงประเด็น ไม่ยืดเยื้อ
- เขียนเฉพาะเนื้อหาข้อความที่จะส่งเท่านั้น ไม่ต้องใส่คำอธิบาย หมายเหตุ หรือ action tags ใดๆ`;

  if (previousDraft && editFeedback) {
    prompt += `\n\n=== แก้ไข Draft ===
Draft เดิม:
${previousDraft}

คำสั่งแก้ไขจากบอส: ${editFeedback}

กรุณาแก้ไข draft ตามคำสั่ง แล้วส่งเฉพาะข้อความที่แก้ไขแล้วเท่านั้น`;
  }

  return prompt;
}

function escHtml(t) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildPreviewText(groupName, cleanMessage, revisionCount) {
  let text = `📝 ข้อความที่จะส่งไปยัง "${escHtml(groupName)}":\n\n${escHtml(cleanMessage)}`;
  if (revisionCount > 0) {
    text += `\n\n<i>(แก้ไขครั้งที่ ${revisionCount}/${MAX_REVISIONS})</i>`;
  }
  return text;
}

function buildPreviewButtons(targetChatId) {
  return [
    [
      { text: "✅ อนุมัติส่ง", callback_data: `send:a:${targetChatId}` },
      { text: "✏️ แก้ไข", callback_data: `send:e:${targetChatId}` },
      { text: "❌ ยกเลิก", callback_data: `send:r:${targetChatId}` },
    ],
  ];
}

// ===== Main handlers =====

export async function handleSendCommand(env, message, args) {
  try {
    // Interactive mode: no args → show group list
    if (!args.trim()) {
      const { results } = await env.DB.prepare(`
        SELECT chat_id, chat_title, MAX(created_at) as last_msg
        FROM messages
        WHERE chat_id != ? AND chat_title IS NOT NULL
        GROUP BY chat_id
        ORDER BY last_msg DESC
        LIMIT 100
      `).bind(message.chat.id).all();

      if (!results.length) {
        await sendTelegram(env, message.chat.id, "ไม่พบกลุ่มที่เคยมีข้อความค่ะ", message.message_id);
        return;
      }

      const buttons = results.map(r => [{
        text: r.chat_title || `Group ${r.chat_id}`,
        callback_data: `send:g:${r.chat_id}`
      }]);

      await sendTelegramWithKeyboard(env, message.chat.id,
        "📨 เลือกกลุ่มที่ต้องการส่งข้อความค่ะนาย:", message.message_id, buttons);
      return;
    }

    // Direct mode: /send <chat_id> <message> (backward compat)
    const parts = args.trim().split(/\s+/);
    if (parts.length < 2) {
      await sendTelegram(env, message.chat.id, "Usage: /send <chat_id> <message>", message.message_id);
      return;
    }
    const targetChatId = Number(parts[0]);
    if (!Number.isSafeInteger(targetChatId)) {
      await sendTelegram(env, message.chat.id, "chat_id ไม่ถูกต้องค่ะ", message.message_id);
      return;
    }
    const msg = parts.slice(1).join(" ");
    await sendTelegram(env, targetChatId, msg, null);
    await sendTelegram(env, message.chat.id, "Sent ✓", message.message_id);
  } catch (err) {
    console.error("handleSendCommand error:", err);
    await sendTelegram(env, message.chat.id, "ส่งไม่สำเร็จ: " + err.message, message.message_id);
  }
}

export async function handleSendCallback(env, callbackQuery) {
  const parts = callbackQuery.data.split(":");
  const action = parts[1];
  const rawChatId = parts.slice(2).join(":");
  const targetChatId = Number(rawChatId);

  const REPLY_KB = getReplyKeyboardMarkup(env);

  if (action !== "a" && action !== "r" && action !== "e" && !Number.isSafeInteger(targetChatId)) {
    return; // invalid callback data
  }
  const chatId = callbackQuery.message.chat.id;

  if (action === "a") {
    // Approve: read draft from DB, send to group
    let messageToSend;
    try {
      const pending = await env.DB.prepare(
        `SELECT draft_text FROM pending_sends WHERE user_id = ?`
      ).bind(chatId).first();
      messageToSend = pending?.draft_text;
    } catch (e) { /* fallback below */ }

    // Fallback: parse from preview message text (legacy compat)
    if (!messageToSend) {
      const fullText = callbackQuery.message.text || "";
      messageToSend = fullText.replace(/^[^\n]*\n\n/, "").replace(/\n\n\(แก้ไขครั้งที่ \d+\/\d+\)$/, "");
    }

    const sendRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: targetChatId, text: messageToSend }),
    });
    let sendOk = false;
    if (sendRes.ok) {
      try {
        const sendResult = await sendRes.json();
        if (sendResult.ok) {
          sendOk = true;
          await trackBotMessage(env, targetChatId, sendResult.result.message_id, messageToSend);
        }
      } catch (e) { /* ignore */ }
    } else {
      console.error("send approve error:", await sendRes.text());
    }

    // Cleanup pending_sends
    try {
      await env.DB.prepare(`DELETE FROM pending_sends WHERE user_id = ?`).bind(chatId).run();
    } catch (e) { /* ignore */ }

    // Remove inline buttons from preview
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: callbackQuery.message.message_id,
        reply_markup: { inline_keyboard: [] },
      }),
    });
    // Send confirmation + restore reply keyboard
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: sendOk ? "✅ ส่งแล้วค่ะนาย" : "❌ ส่งไม่สำเร็จ",
        reply_markup: REPLY_KB,
      }),
    });
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQuery.id }),
    });
    return;
  }

  if (action === "r") {
    // Reject: cleanup pending_sends + remove inline buttons
    try {
      await env.DB.prepare(`DELETE FROM pending_sends WHERE user_id = ?`).bind(chatId).run();
    } catch (e) { /* ignore */ }

    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: callbackQuery.message.message_id,
        reply_markup: { inline_keyboard: [] },
      }),
    });
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "❌ ยกเลิกแล้วค่ะนาย",
        reply_markup: REPLY_KB,
      }),
    });
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQuery.id }),
    });
    return;
  }

  if (action === "e") {
    // Edit: check revision count, ask for feedback
    let revisionCount = 0;
    try {
      const pending = await env.DB.prepare(
        `SELECT revision_count FROM pending_sends WHERE user_id = ?`
      ).bind(chatId).first();
      revisionCount = pending?.revision_count || 0;
    } catch (e) { /* ignore */ }

    if (revisionCount >= MAX_REVISIONS) {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callbackQuery.id,
          text: `แก้ไขได้สูงสุด ${MAX_REVISIONS} ครั้งค่ะ`,
          show_alert: true,
        }),
      });
      return;
    }

    // Remove inline buttons from current preview
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: callbackQuery.message.message_id,
        reply_markup: { inline_keyboard: [] },
      }),
    });

    // Ask for edit feedback with force_reply
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `✏️ แก้ไขข้อความ — พิมพ์สิ่งที่ต้องการแก้ไขค่ะนาย (ครั้งที่ ${revisionCount + 1}/${MAX_REVISIONS})`,
        reply_markup: { force_reply: true, selective: true },
      }),
    });

    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQuery.id }),
    });
    return;
  }

  if (action === "g") {
    // Group selection: store target in DB, prompt for instruction
    const row = await env.DB.prepare(
      `SELECT chat_title FROM messages WHERE chat_id = ? AND chat_title IS NOT NULL ORDER BY created_at DESC LIMIT 1`
    ).bind(targetChatId).first();
    const groupName = row?.chat_title || `Group ${targetChatId}`;

    await env.DB.prepare(
      `INSERT OR REPLACE INTO pending_sends (user_id, target_chat_id, revision_count, updated_at) VALUES (?, ?, 0, datetime('now'))`
    ).bind(chatId, targetChatId).run();

    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `📨 สั่ง AI ว่าต้องการส่งอะไรไปยัง "${groupName}" (reply ข้อความนี้ค่ะนาย)`,
        reply_markup: { force_reply: true, selective: true },
      }),
    });

    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQuery.id }),
    });
  }
}

export async function handleSendReply(env, message, targetChatId, msgText) {
  try {
    await sendTyping(env, message.chat.id);

    // Get target group context (rich, group-specific)
    const { context, groupName, companyName, participants } = await getTargetGroupContext(env.DB, targetChatId);

    // Build smart prompt
    const aiPrompt = buildSendPrompt({
      instruction: msgText,
      groupName,
      companyName,
      participants,
      botName: env.BOT_NAME || "Friday",
    });

    const aiResponse = await askGemini(env, aiPrompt, context, null);
    const cleanMessage = cleanAiResponse(aiResponse);

    // Store draft + instruction in pending_sends
    await env.DB.prepare(
      `UPDATE pending_sends SET instruction = ?, draft_text = ?, revision_count = 0, updated_at = datetime('now')
       WHERE user_id = ?`
    ).bind(msgText, cleanMessage, message.chat.id).run();

    // Show preview with 3 buttons
    const previewText = buildPreviewText(groupName, cleanMessage, 0);
    const buttons = buildPreviewButtons(targetChatId);
    await sendTelegramWithKeyboard(env, message.chat.id, previewText, message.message_id, buttons);
  } catch (err) {
    console.error("handleSendReply error:", err);
    await sendTelegram(env, message.chat.id, "ส่งไม่สำเร็จ: " + err.message, message.message_id);
  }
}

export async function handleSendEditReply(env, message, editFeedback) {
  try {
    await sendTyping(env, message.chat.id);

    // Get pending state from DB
    const pending = await env.DB.prepare(
      `SELECT target_chat_id, instruction, draft_text, revision_count FROM pending_sends WHERE user_id = ?`
    ).bind(message.chat.id).first();

    if (!pending) {
      await sendTelegram(env, message.chat.id, "ไม่พบ draft ที่ค้างอยู่ค่ะ กรุณาเริ่ม /send ใหม่", message.message_id);
      return;
    }

    if (pending.revision_count >= MAX_REVISIONS) {
      await sendTelegram(env, message.chat.id, `แก้ไขได้สูงสุด ${MAX_REVISIONS} ครั้งค่ะ กรุณาอนุมัติหรือยกเลิก`, message.message_id);
      return;
    }

    const targetChatId = pending.target_chat_id;

    // Get target group context again (fresh)
    const { context, groupName, companyName, participants } = await getTargetGroupContext(env.DB, targetChatId);

    // Build prompt with previous draft + edit feedback
    const aiPrompt = buildSendPrompt({
      instruction: pending.instruction,
      groupName,
      companyName,
      participants,
      previousDraft: pending.draft_text,
      editFeedback,
      botName: env.BOT_NAME || "Friday",
    });

    const aiResponse = await askGemini(env, aiPrompt, context, null);
    const cleanMessage = cleanAiResponse(aiResponse);

    const newRevisionCount = pending.revision_count + 1;

    // Update draft in DB
    await env.DB.prepare(
      `UPDATE pending_sends SET draft_text = ?, revision_count = ?, updated_at = datetime('now')
       WHERE user_id = ?`
    ).bind(cleanMessage, newRevisionCount, message.chat.id).run();

    // Show new preview with 3 buttons
    const previewText = buildPreviewText(groupName, cleanMessage, newRevisionCount);
    const buttons = buildPreviewButtons(targetChatId);
    await sendTelegramWithKeyboard(env, message.chat.id, previewText, message.message_id, buttons);
  } catch (err) {
    console.error("handleSendEditReply error:", err);
    await sendTelegram(env, message.chat.id, "แก้ไขไม่สำเร็จ: " + err.message, message.message_id);
  }
}
