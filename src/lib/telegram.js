import { sanitizeHtml, stripHtmlTags, splitMessage } from './html-utils.js';

export async function sendTyping(env, chatId) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

// ===== Text-to-Speech (Google Cloud TTS) =====

export async function textToSpeech(env, text) {
  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${env.GOOGLE_TTS_API_KEY}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text: text.substring(0, 5000) },
      voice: { languageCode: "th-TH", name: "th-TH-Standard-A" },
      audioConfig: { audioEncoding: "OGG_OPUS" },
    }),
  });
  if (!response.ok) {
    console.error("TTS error:", response.status, await response.text());
    return null;
  }
  const data = await response.json();
  return data.audioContent;
}

export async function sendVoice(env, chatId, audioBase64, replyToMessageId) {
  const binary = Uint8Array.from(atob(audioBase64), c => c.charCodeAt(0));
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("voice", new Blob([binary], { type: "audio/ogg" }), "voice.ogg");
  if (replyToMessageId) formData.append("reply_to_message_id", replyToMessageId);
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendVoice`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    console.error("sendVoice error:", await res.text());
  } else {
    try {
      const result = await res.clone().json();
      if (result.ok) await trackBotMessage(env, chatId, result.result.message_id, "[Voice]");
    } catch (e) { /* ignore */ }
  }
  return res.ok;
}

// Track bot's sent messages for /delete feature (groups only)
export async function trackBotMessage(env, chatId, messageId, textPreview) {
  if (chatId >= 0) return; // DM → ไม่ track
  try {
    await env.DB.prepare(
      `INSERT INTO bot_messages (chat_id, message_id, text_preview) VALUES (?, ?, ?)`
    ).bind(chatId, messageId, (textPreview || "").substring(0, 100)).run();
  } catch (e) { /* ignore */ }
}

export function getReplyKeyboardMarkup(env) {
  return {
    keyboard: [
      [{ text: "Tasks" }, { text: "Memories" }, { text: "Summary" }, { text: "Recap" }],
      [{ text: "Send" }, { text: "Company" }, { text: "Delete" }, ...(env.DASHBOARD_URL ? [{ text: "Dashboard", web_app: { url: env.DASHBOARD_URL } }] : [{ text: "Calendar" }])],
    ],
    resize_keyboard: true,
    is_persistent: true,
    selective: true,
  };
}

export async function sendTelegram(env, chatId, text, replyToMessageId, useHtml = false) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  // Sanitize HTML if enabled
  const sendText = useHtml ? sanitizeHtml(text) : text;
  const baseBody = {
    chat_id: chatId,
    reply_to_message_id: replyToMessageId,
    link_preview_options: { is_disabled: true },
  };
  if (useHtml) baseBody.parse_mode = "HTML";
  if (env._replyKeyboard) baseBody.reply_markup = env._replyKeyboard;

  // Helper: parse response and track bot message
  const trackRes = async (res, preview) => {
    if (res.ok) {
      try {
        const result = await res.clone().json();
        if (result.ok) await trackBotMessage(env, chatId, result.result.message_id, preview);
      } catch (e) { /* ignore */ }
    }
  };

  // ข้อความสั้น → ส่งปกติ
  if (sendText.length <= 4096) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBody, text: sendText }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Telegram sendMessage error:", err);
      // HTML fallback: ถ้า 400 (HTML parse error) → ส่งใหม่แบบ plain text
      if (useHtml && res.status === 400) {
        console.log("HTML send failed, retrying as plain text");
        const plainText = stripHtmlTags(text);
        const fallbackRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: plainText, reply_to_message_id: replyToMessageId }),
        });
        await trackRes(fallbackRes, plainText);
      }
    } else {
      await trackRes(res, text);
    }
    return;
  }

  // ข้อความยาว → ตัดเป็น chunks แล้วส่งทีละอัน
  const chunks = splitMessage(sendText, 4096, useHtml);
  for (let i = 0; i < chunks.length; i++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...baseBody,
        text: chunks[i],
        reply_to_message_id: i === 0 ? replyToMessageId : null,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`Telegram sendMessage error (chunk ${i + 1}/${chunks.length}):`, err);
      // HTML fallback per chunk
      if (useHtml && res.status === 400) {
        console.log(`HTML send failed (chunk ${i + 1}), retrying as plain text`);
        const plainChunk = stripHtmlTags(chunks[i]);
        const fallbackRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: plainChunk,
            reply_to_message_id: i === 0 ? replyToMessageId : null,
          }),
        });
        await trackRes(fallbackRes, plainChunk);
      }
    } else {
      await trackRes(res, chunks[i]);
    }
  }
}

export async function sendTelegramWithKeyboard(env, chatId, text, replyToMessageId, buttons) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: sanitizeHtml(text),
      parse_mode: "HTML",
      reply_to_message_id: replyToMessageId,
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: buttons },
    }),
  });
  if (!res.ok) {
    console.error("sendTelegramWithKeyboard error:", await res.text());
  } else {
    try {
      const result = await res.clone().json();
      if (result.ok) await trackBotMessage(env, chatId, result.result.message_id, text);
    } catch (e) { /* ignore */ }
  }
}

export async function sendReplyKeyboard(env, chatId, replyToMessageId) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: "เลือกคำสั่งได้เลยค่ะนาย:",
      reply_to_message_id: replyToMessageId || undefined,
      reply_markup: getReplyKeyboardMarkup(env),
    }),
  });
}

export async function sendMemberReplyKeyboard(env, chatId, firstName, replyToMessageId) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `สวัสดีค่ะ ${firstName || ""} 👋\n${env.BOT_NAME || "Friday"} พร้อมช่วยเหลือค่ะ`,
      reply_to_message_id: replyToMessageId || undefined,
      reply_markup: {
        keyboard: [
          [{ text: "Tasks" }, { text: "Read Link" }],
          [{ text: "Recap" }, { text: "Delete" }],
          [{ text: "Summary" }],
        ],
        resize_keyboard: true,
        is_persistent: true,
        selective: true,
      },
    }),
  });
}
