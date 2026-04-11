import { sendTelegram, sendTelegramWithKeyboard, sendTyping, trackBotMessage, getReplyKeyboardMarkup } from '../lib/telegram.js';
import { formatMessages, parseDateRange } from '../lib/context.js';
import { askGemini } from '../lib/gemini.js';
import { stripHtmlTags } from '../lib/html-utils.js';

export async function handleRecapCommand(env, message) {
  try {
    if (message.chat.type !== "private") {
      await sendTelegram(env, message.chat.id, "คำสั่ง /recap ใช้ได้เฉพาะใน DM เท่านั้นค่ะนาย", message.message_id);
      return;
    }

    const { results } = await env.DB.prepare(
      `SELECT chat_id, chat_title FROM group_registry
       WHERE is_active = 1 ORDER BY last_message_at DESC LIMIT 10`
    ).all();

    if (!results.length) {
      await sendTelegram(env, message.chat.id, "ไม่พบกลุ่มที่ active อยู่ค่ะนาย", message.message_id);
      return;
    }

    const buttons = results.map(r => [{
      text: r.chat_title || `Group ${r.chat_id}`,
      callback_data: `recap:g:${r.chat_id}`
    }]);

    await sendTelegramWithKeyboard(env, message.chat.id,
      "📋 เลือกกลุ่มที่ต้องการ Recap ค่ะนาย:", message.message_id, buttons);
  } catch (err) {
    console.error("handleRecapCommand error:", err);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาด: " + err.message, message.message_id);
  }
}

export async function handleRecapCallback(env, callbackQuery) {
  const parts = callbackQuery.data.split(":");
  const action = parts[1];
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  const answerCallback = () => fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQuery.id }),
  });

  if (action === "g") {
    try {
    // Group selected → show time range options
    const targetChatId = parts.slice(2).join(":");
    const row = await env.DB.prepare(
      `SELECT chat_title FROM group_registry WHERE chat_id = ?`
    ).bind(targetChatId).first();
    const groupName = row?.chat_title || `Group ${targetChatId}`;

    const buttons = [
      [
        { text: "📅 วันนี้", callback_data: `recap:d:${targetChatId}:1` },
        { text: "📅 3 วัน", callback_data: `recap:d:${targetChatId}:3` },
      ],
      [
        { text: "📅 7 วัน", callback_data: `recap:d:${targetChatId}:7` },
        { text: "✏️ กำหนดเอง", callback_data: `recap:c:${targetChatId}` },
      ],
    ];

    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: `📋 Recap "${groupName}" — เลือกช่วงเวลาค่ะนาย:`,
        reply_markup: { inline_keyboard: buttons },
      }),
    });

    await answerCallback();
    } catch (err) {
      console.error("handleRecapCallback g error:", err);
      await answerCallback();
    }
    return;
  }

  if (action === "d") {
    // Quick days selected → fetch messages + summarize
    const days = Math.min(Math.max(Number(parts[parts.length - 1]) || 7, 1), 30);
    const targetChatId = parts.slice(2, -1).join(":");
    const row = await env.DB.prepare(
      `SELECT chat_title FROM group_registry WHERE chat_id = ?`
    ).bind(targetChatId).first();
    const groupName = row?.chat_title || `Group ${targetChatId}`;

    // Precompute date cutoff in JS to avoid SQL interpolation
    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const cutoffDateOnly = cutoffDate.slice(0, 10);

    // Show loading state
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: `⏳ กำลังสรุป "${groupName}" ย้อนหลัง ${days} วัน...`,
        reply_markup: { inline_keyboard: [] },
      }),
    });

    await answerCallback();

    try {
      // Fetch messages
      const { results: messages } = await env.DB.prepare(
        `SELECT message_text, first_name, username, chat_title, created_at
         FROM messages WHERE chat_id = ? AND created_at > ?
         ORDER BY created_at ASC LIMIT 500`
      ).bind(targetChatId, cutoffDate).all();

      // Fetch summaries
      const { results: summaries } = await env.DB.prepare(
        `SELECT summary_text, summary_date FROM summaries
         WHERE chat_id = ? AND summary_date >= ?
         ORDER BY summary_date ASC`
      ).bind(targetChatId, cutoffDateOnly).all();

      if (!messages.length && !summaries.length) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: `📋 ไม่พบข้อมูลของ "${groupName}" ในช่วง ${days} วันที่ผ่านมาค่ะนาย`,
          }),
        });
        return;
      }

      const formattedMsgs = formatMessages(messages);
      const summaryTexts = summaries.map(s => `[สรุปวันที่ ${s.summary_date}]\n${s.summary_text}`).join("\n\n");

      const contextBlock = [
        summaryTexts ? `=== สรุปรายวัน ===\n${summaryTexts}` : "",
        formattedMsgs ? `=== ข้อความล่าสุด ===\n${formattedMsgs}` : "",
      ].filter(Boolean).join("\n\n");

      const aiPrompt = `สรุปบทสนทนาของกลุ่ม "${groupName}" ในช่วง ${days} วันที่ผ่านมาให้บอส
ให้สรุปเป็นภาษาไทย กระชับ ครอบคลุมประเด็นสำคัญ แบ่งหัวข้อชัดเจน
ถ้ามีเรื่องสำคัญที่ต้องติดตามให้ระบุด้วย
ห้ามใส่ action tags ใดๆ`;

      const aiResponse = await askGemini(env, aiPrompt, contextBlock, null, { feature: 'recap', chatId });
      const cleanResponse = stripHtmlTags(
        aiResponse
          .replace(/\[SEND:[^\]]+\]/g, '')
          .replace(/\[REMEMBER:\w+:[^\]]+\]/g, '')
          .replace(/\[FORGET:\d+\]/g, '')
          .replace(/[•*\-]?\s*<a\s+href="https?:\/\/vertexaisearch\.cloud\.google\.com\/[^"]*">[^<]*<\/a>/g, '')
      ).replace(/\n{3,}/g, '\n\n').trim();

      const recapText = `📋 Recap "${groupName}" (${days} วัน)\n\n${cleanResponse}`;

      const shareButton = [[{ text: "📤 ส่งสรุปไปกลุ่ม", callback_data: `recap:share:${targetChatId}:${days}` }]];

      // If too long for edit, send as new message
      if (recapText.length > 4000) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: `📋 Recap "${groupName}" (${days} วัน) — ส่งผลลัพธ์ด้านล่างค่ะ`,
          }),
        });
        await sendTelegram(env, chatId, cleanResponse, null);
        await sendTelegramWithKeyboard(env, chatId,
          "👆 ต้องการส่งสรุปนี้ไปกลุ่มไหมคะนาย?", null, shareButton);
      } else {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: recapText,
            reply_markup: { inline_keyboard: shareButton },
          }),
        });
      }
    } catch (err) {
      console.error("handleRecapCallback d error:", err);
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: `❌ เกิดข้อผิดพลาด: ${err.message}`,
        }),
      });
    }
    return;
  }

  if (action === "c") {
    try {
    // Custom mode → force reply
    const targetChatId = parts.slice(2).join(":");
    const row = await env.DB.prepare(
      `SELECT chat_title FROM group_registry WHERE chat_id = ?`
    ).bind(targetChatId).first();
    const groupName = row?.chat_title || `Group ${targetChatId}`;

    // Store target in DB
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS pending_recaps (user_id INTEGER PRIMARY KEY, target_chat_id TEXT, created_at TEXT DEFAULT (datetime('now')))`
    ).run();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO pending_recaps (user_id, target_chat_id) VALUES (?, ?)`
    ).bind(chatId, targetChatId).run();

    // Remove inline buttons from original message
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      }),
    });

    // Send force reply
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `📋 พิมพ์คำสั่ง recap สำหรับ "${groupName}" (reply ข้อความนี้ค่ะนาย)\nเช่น: "สรุปเรื่องงบประมาณ" หรือ "18-23 มีนาคม"`,
        reply_markup: { force_reply: true, selective: true },
      }),
    });

    await answerCallback();
    } catch (err) {
      console.error("handleRecapCallback c error:", err);
      await answerCallback();
    }
    return;
  }

  if (action === "share") {
    // Share recap to group: re-generate in group-appropriate tone
    await answerCallback();
    try {
      // Parse targetChatId and time range from callback data
      // Format: recap:share:{chatId}:{days} or recap:share:{chatId}:{startDate}:{endDate}
      const remaining = parts.slice(2);
      let targetChatId, days, dateRange;
      // Last part(s) are the time range; chatId may be negative (e.g. -100xxx)
      const lastPart = remaining[remaining.length - 1];
      const secondLast = remaining.length >= 2 ? remaining[remaining.length - 2] : null;
      if (secondLast && /^\d{4}-\d{2}-\d{2}$/.test(secondLast) && /^\d{4}-\d{2}-\d{2}$/.test(lastPart)) {
        // Date range format
        dateRange = { startDate: secondLast, endDate: lastPart };
        targetChatId = remaining.slice(0, -2).join(":");
      } else {
        days = Math.min(Math.max(Number(lastPart) || 7, 1), 30);
        targetChatId = remaining.slice(0, -1).join(":");
      }

      const row = await env.DB.prepare(
        `SELECT chat_title FROM group_registry WHERE chat_id = ?`
      ).bind(targetChatId).first();
      const groupName = row?.chat_title || `Group ${targetChatId}`;

      // Show loading state
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: `⏳ กำลังเตรียมสรุปสำหรับกลุ่ม "${groupName}"...`,
          reply_markup: { inline_keyboard: [] },
        }),
      });

      // Fetch messages
      const msgQuery = dateRange
        ? `SELECT message_text, first_name, username, chat_title, created_at
           FROM messages WHERE chat_id = ? AND date(created_at) >= ? AND date(created_at) <= ?
           ORDER BY created_at ASC LIMIT 500`
        : `SELECT message_text, first_name, username, chat_title, created_at
           FROM messages WHERE chat_id = ? AND created_at > ?
           ORDER BY created_at ASC LIMIT 500`;

      const msgParams = dateRange
        ? [targetChatId, dateRange.startDate, dateRange.endDate]
        : [targetChatId, new Date(Date.now() - days * 86400000).toISOString()];

      const { results: messages } = await env.DB.prepare(msgQuery).bind(...msgParams).all();

      // Fetch summaries
      const sumQuery = dateRange
        ? `SELECT summary_text, summary_date FROM summaries
           WHERE chat_id = ? AND summary_date >= ? AND summary_date <= ?
           ORDER BY summary_date ASC`
        : `SELECT summary_text, summary_date FROM summaries
           WHERE chat_id = ? AND summary_date >= ?
           ORDER BY summary_date ASC`;

      const sumParams = dateRange
        ? [targetChatId, dateRange.startDate, dateRange.endDate]
        : [targetChatId, new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)];

      const { results: summaries } = await env.DB.prepare(sumQuery).bind(...sumParams).all();

      if (!messages.length && !summaries.length) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: `📋 ไม่พบข้อมูลสำหรับสร้างสรุปค่ะนาย`,
          }),
        });
        return;
      }

      const formattedMsgs = formatMessages(messages);
      const summaryTexts = summaries.map(s => `[สรุปวันที่ ${s.summary_date}]\n${s.summary_text}`).join("\n\n");

      const contextBlock = [
        summaryTexts ? `=== สรุปรายวัน ===\n${summaryTexts}` : "",
        formattedMsgs ? `=== ข้อความล่าสุด ===\n${formattedMsgs}` : "",
      ].filter(Boolean).join("\n\n");

      const periodText = dateRange
        ? `ช่วง ${dateRange.startDate} ถึง ${dateRange.endDate}`
        : `${days} วันที่ผ่านมา`;

      const aiPrompt = `สรุปบทสนทนาของกลุ่ม "${groupName}" ในช่วง${periodText}
เขียนเป็นภาษาไทย สรุปสั้นกระชับเข้าใจง่ายสำหรับสมาชิกในกลุ่ม
แบ่งหัวข้อชัดเจน ระบุประเด็นสำคัญและสิ่งที่ต้องติดตาม
เขียนในโทนเป็นมิตร ใช้ภาษาที่เหมาะกับการสื่อสารในกลุ่ม
ห้ามใส่ action tags ใดๆ`;

      const aiResponse = await askGemini(env, aiPrompt, contextBlock, null, { feature: 'recap', chatId });
      const cleanResponse = stripHtmlTags(
        aiResponse
          .replace(/\[SEND:[^\]]+\]/g, '')
          .replace(/\[REMEMBER:\w+:[^\]]+\]/g, '')
          .replace(/\[FORGET:\d+\]/g, '')
          .replace(/[•*\-]?\s*<a\s+href="https?:\/\/vertexaisearch\.cloud\.google\.com\/[^"]*">[^<]*<\/a>/g, '')
      ).replace(/\n{3,}/g, '\n\n').trim();

      // Show preview with approve/reject buttons
      const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const previewText = `📝 ข้อความที่จะส่งไปยัง "${esc(groupName)}":\n\n${esc(cleanResponse)}`;
      const buttons = [
        [
          { text: "✅ อนุมัติส่ง", callback_data: `recap:approve:${targetChatId}` },
          { text: "❌ ยกเลิก", callback_data: `recap:reject:${targetChatId}` },
        ],
      ];
      await sendTelegramWithKeyboard(env, chatId, previewText, null, buttons);
    } catch (err) {
      console.error("handleRecapCallback share error:", err);
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: `❌ เกิดข้อผิดพลาด: ${err.message}`,
        }),
      });
    }
    return;
  }

  if (action === "approve") {
    // Approve: send recap to group
    const targetChatId = parts.slice(2).join(":");
    const fullText = callbackQuery.message.text || "";
    const messageToSend = fullText.replace(/^[^\n]*\n\n/, "");

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
      console.error("recap approve send error:", await sendRes.text());
    }

    // Remove inline buttons from preview
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      }),
    });

    const REPLY_KB = getReplyKeyboardMarkup(env);

    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: sendOk ? "✅ ส่งสรุปไปกลุ่มแล้วค่ะนาย" : "❌ ส่งไม่สำเร็จ",
        reply_markup: REPLY_KB,
      }),
    });

    await answerCallback();
    return;
  }

  if (action === "reject") {
    // Reject: cancel sending recap to group
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      }),
    });

    const REPLY_KB = getReplyKeyboardMarkup(env);

    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "❌ ยกเลิกแล้วค่ะนาย",
        reply_markup: REPLY_KB,
      }),
    });

    await answerCallback();
    return;
  }
}

export async function handleRecapReply(env, message, targetChatId, instruction) {
  try {
    await sendTyping(env, message.chat.id);

    const row = await env.DB.prepare(
      `SELECT chat_title FROM group_registry WHERE chat_id = ?`
    ).bind(targetChatId).first();
    const groupName = row?.chat_title || `Group ${targetChatId}`;

    // Try to parse date range from instruction
    const dateRange = parseDateRange(instruction);

    // Fetch messages
    const msgQuery = dateRange
      ? `SELECT message_text, first_name, username, chat_title, created_at
         FROM messages WHERE chat_id = ? AND date(created_at) >= ? AND date(created_at) <= ?
         ORDER BY created_at ASC LIMIT 500`
      : `SELECT message_text, first_name, username, chat_title, created_at
         FROM messages WHERE chat_id = ? AND created_at > datetime('now', '-7 days')
         ORDER BY created_at ASC LIMIT 500`;

    const msgParams = dateRange
      ? [targetChatId, dateRange.startDate, dateRange.endDate]
      : [targetChatId];

    const { results: messages } = await env.DB.prepare(msgQuery).bind(...msgParams).all();

    // Fetch summaries
    const sumQuery = dateRange
      ? `SELECT summary_text, summary_date FROM summaries
         WHERE chat_id = ? AND summary_date >= ? AND summary_date <= ?
         ORDER BY summary_date ASC`
      : `SELECT summary_text, summary_date FROM summaries
         WHERE chat_id = ? AND summary_date >= date('now', '-7 days')
         ORDER BY summary_date ASC`;

    const sumParams = dateRange
      ? [targetChatId, dateRange.startDate, dateRange.endDate]
      : [targetChatId];

    const { results: summaries } = await env.DB.prepare(sumQuery).bind(...sumParams).all();

    if (!messages.length && !summaries.length) {
      await sendTelegram(env, message.chat.id, `📋 ไม่พบข้อมูลของ "${groupName}" ในช่วงเวลาที่ระบุค่ะนาย`, message.message_id);
      return;
    }

    const formattedMsgs = formatMessages(messages);
    const summaryTexts = summaries.map(s => `[สรุปวันที่ ${s.summary_date}]\n${s.summary_text}`).join("\n\n");

    const contextBlock = [
      summaryTexts ? `=== สรุปรายวัน ===\n${summaryTexts}` : "",
      formattedMsgs ? `=== ข้อความล่าสุด ===\n${formattedMsgs}` : "",
    ].filter(Boolean).join("\n\n");

    const aiPrompt = `สรุปบทสนทนาของกลุ่ม "${groupName}" ให้บอส
คำสั่งจากบอส: ${instruction}
ให้สรุปเป็นภาษาไทย กระชับ ครอบคลุมประเด็นสำคัญ แบ่งหัวข้อชัดเจน
ถ้ามีเรื่องสำคัญที่ต้องติดตามให้ระบุด้วย
ห้ามใส่ action tags ใดๆ`;

    const aiResponse = await askGemini(env, aiPrompt, contextBlock, null, { feature: 'recap', chatId: message.chat.id });
    const cleanResponse = stripHtmlTags(
      aiResponse
        .replace(/\[SEND:[^\]]+\]/g, '')
        .replace(/\[REMEMBER:\w+:[^\]]+\]/g, '')
        .replace(/\[FORGET:\d+\]/g, '')
        .replace(/[•*\-]?\s*<a\s+href="https?:\/\/vertexaisearch\.cloud\.google\.com\/[^"]*">[^<]*<\/a>/g, '')
    ).replace(/\n{3,}/g, '\n\n').trim();

    const header = dateRange
      ? `📋 Recap "${groupName}" (${dateRange.startDate} ถึง ${dateRange.endDate})`
      : `📋 Recap "${groupName}" (7 วัน)`;

    await sendTelegram(env, message.chat.id, `${header}\n\n${cleanResponse}`, message.message_id);

    // Offer share button
    const shareData = dateRange
      ? `recap:share:${targetChatId}:${dateRange.startDate}:${dateRange.endDate}`
      : `recap:share:${targetChatId}:7`;
    await sendTelegramWithKeyboard(env, message.chat.id,
      "👆 ต้องการส่งสรุปนี้ไปกลุ่มไหมคะนาย?", null,
      [[{ text: "📤 ส่งสรุปไปกลุ่ม", callback_data: shareData }]]);
  } catch (err) {
    console.error("handleRecapReply error:", err);
    await sendTelegram(env, message.chat.id, "❌ เกิดข้อผิดพลาด: " + err.message, message.message_id);
  }
}
