import { sendTelegram, sendTelegramWithKeyboard, sendTyping, trackBotMessage, getReplyKeyboardMarkup } from "../lib/telegram.js";
import { askGemini } from "../lib/gemini.js";
import { getSmartContext } from "../lib/context.js";
import { stripHtmlTags } from "../lib/html-utils.js";

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
        LIMIT 10
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
    const targetChatId = parts[0];
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
  const action = parts[1]; // "g"
  const targetChatId = parts.slice(2).join(":"); // handle negative chat IDs

  const REPLY_KB = getReplyKeyboardMarkup(env);

  if (action === "a") {
    // Approve: extract message from preview and send to group
    const fullText = callbackQuery.message.text || "";
    // Preview format: "📝 ข้อความที่จะส่งไปยัง "GroupName":\n\n{message}"
    const messageToSend = fullText.replace(/^[^\n]*\n\n/, "");
    // Send directly and check response (sendTelegram doesn't throw on API errors)
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
    // Remove inline buttons from preview
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id,
        reply_markup: { inline_keyboard: [] },
      }),
    });
    // Send confirmation + restore reply keyboard
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: callbackQuery.message.chat.id,
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
    // Reject: remove inline buttons from preview
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id,
        reply_markup: { inline_keyboard: [] },
      }),
    });
    // Send confirmation + restore reply keyboard
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: callbackQuery.message.chat.id,
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

  if (action === "g") {
    const row = await env.DB.prepare(
      `SELECT chat_title FROM messages WHERE chat_id = ? AND chat_title IS NOT NULL ORDER BY created_at DESC LIMIT 1`
    ).bind(targetChatId).first();
    const groupName = row?.chat_title || `Group ${targetChatId}`;

    const chatId = callbackQuery.message.chat.id;

    // Store target in DB so we don't need to embed ugly tag in message
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pending_sends (user_id INTEGER PRIMARY KEY, target_chat_id TEXT, created_at TEXT DEFAULT (datetime('now')))`).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO pending_sends (user_id, target_chat_id) VALUES (?, ?)`).bind(chatId, targetChatId).run();

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

    // Get group name for display
    const row = await env.DB.prepare(
      `SELECT chat_title FROM messages WHERE chat_id = ? AND chat_title IS NOT NULL ORDER BY created_at DESC LIMIT 1`
    ).bind(targetChatId).first();
    const groupName = row?.chat_title || `Group ${targetChatId}`;

    // Get smart context from DM
    const context = await getSmartContext(env.DB, message.chat.id, true, msgText);

    // Ask AI to draft the message
    const aiPrompt = `บอสต้องการให้เขียนข้อความเพื่อส่งไปยังกลุ่ม (chat_id: ${targetChatId})\nคำสั่ง: ${msgText}\nกรุณาเขียนเฉพาะเนื้อหาข้อความที่จะส่งเท่านั้น ไม่ต้องใส่คำอธิบาย หมายเหตุ หรือ action tags ใดๆ`;
    const aiResponse = await askGemini(env, aiPrompt, context, null);

    // Strip action tags, grounding links, and HTML tags → clean plain text
    const cleanMessage = stripHtmlTags(
      aiResponse
        .replace(/\[SEND:[^\]]+\]/g, '')
        .replace(/\[REMEMBER:\w+:[^\]]+\]/g, '')
        .replace(/\[FORGET:\d+\]/g, '')
        // Strip Gemini grounding citation links (• <a href="vertexaisearch...">domain</a>)
        .replace(/[•*\-]?\s*<a\s+href="https?:\/\/vertexaisearch\.cloud\.google\.com\/[^"]*">[^<]*<\/a>/g, '')
    ).replace(/\n*\s*🔗?\s*แหล่งข้อมูล:?\s*$/, '').replace(/\n{3,}/g, '\n\n').trim();

    // Escape &<> for safe HTML preview (sendTelegramWithKeyboard uses parse_mode: HTML)
    const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const previewText = `📝 ข้อความที่จะส่งไปยัง "${esc(groupName)}":\n\n${esc(cleanMessage)}`;
    const buttons = [
      [
        { text: "✅ อนุมัติส่ง", callback_data: `send:a:${targetChatId}` },
        { text: "❌ ยกเลิก", callback_data: `send:r:${targetChatId}` },
      ],
    ];
    await sendTelegramWithKeyboard(env, message.chat.id, previewText, message.message_id, buttons);
  } catch (err) {
    await sendTelegram(env, message.chat.id, "ส่งไม่สำเร็จ: " + err.message, message.message_id);
  }
}
