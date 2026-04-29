import { sendTelegram, sendTelegramWithKeyboard } from "../lib/telegram.js";

export async function handleDeleteCommand(env, message) {
  try {
    // Boss-only: /delete manages bot messages across every group, must not be invokable by members.
    if (message.from.id !== Number(env.BOSS_USER_ID)) {
      return;
    }
    if (message.chat.type !== "private") {
      await sendTelegram(env, message.chat.id, "คำสั่ง /delete ใช้ได้เฉพาะใน DM เท่านั้นค่ะนาย", message.message_id);
      return;
    }
    const { results } = await env.DB
      .prepare(
        `SELECT chat_id, MAX(created_at) as last_msg
         FROM bot_messages
         WHERE created_at > datetime('now', '-48 hours')
         GROUP BY chat_id
         ORDER BY last_msg DESC`
      )
      .all();
    if (!results.length) {
      await sendTelegram(env, message.chat.id, `ไม่พบข้อความของ ${env.BOT_NAME || "Friday"} ในกลุ่มใดเลยในช่วง 48 ชม.ที่ผ่านมาค่ะนาย`, message.message_id);
      return;
    }
    // ดึงชื่อกลุ่มจาก messages table
    const chatIds = results.map(r => r.chat_id);
    const placeholders = chatIds.map(() => "?").join(",");
    const { results: titles } = await env.DB
      .prepare(
        `SELECT chat_id, chat_title FROM messages
         WHERE chat_id IN (${placeholders}) AND chat_title IS NOT NULL
         GROUP BY chat_id`
      )
      .bind(...chatIds)
      .all();
    const titleMap = {};
    for (const t of titles) titleMap[t.chat_id] = t.chat_title;

    const buttons = results.map((r) => [
      { text: titleMap[r.chat_id] || `Group ${r.chat_id}`, callback_data: `del:g:${r.chat_id}` },
    ]);
    buttons.push([{ text: "🗑 ลบทั้งหมดทุกกลุ่ม", callback_data: "del:aa" }]);
    await sendTelegramWithKeyboard(env, message.chat.id, `🗑 เลือกกลุ่มที่ต้องการลบข้อความของ ${env.BOT_NAME || "Friday"}:`, message.message_id, buttons);
  } catch (err) {
    console.error("handleDeleteCommand error:", err);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดค่ะนาย: " + err.message, message.message_id);
  }
}

export async function handleDeleteCallback(env, callbackQuery) {
  // Defense-in-depth: even if the global MEMBER_CALLBACKS gate is bypassed,
  // refuse any del: callback that isn't from the boss.
  if (callbackQuery.from.id !== Number(env.BOSS_USER_ID)) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQuery.id,
        text: "ฟังก์ชันนี้สำหรับผู้ดูแลระบบเท่านั้นค่ะ",
        show_alert: true,
      }),
    }).catch(e => console.error("answerCallbackQuery (del non-boss) error:", e.message));
    return;
  }
  const parts = callbackQuery.data.split(":");
  const action = parts[1];
  try {
    if (action === "g" || action === "p") {
      const targetChatId = parts[2];
      const offset = action === "p" ? parseInt(parts[3], 10) : 0;
      await showGroupMessages(env, callbackQuery, targetChatId, offset);
    } else if (action === "m") {
      const targetChatId = parts[2];
      const targetMsgId = parseInt(parts[3], 10);
      await executeDeleteMessage(env, callbackQuery, targetChatId, targetMsgId);
    } else if (action === "a") {
      const targetChatId = parts[2];
      await executeDeleteAll(env, callbackQuery, targetChatId);
    } else if (action === "aa") {
      await executeDeleteAllGroups(env, callbackQuery);
    } else if (action === "b") {
      await showGroupList(env, callbackQuery);
    }
  } catch (err) {
    console.error("handleDeleteCallback error:", err);
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQuery.id,
        text: "เกิดข้อผิดพลาด: " + err.message,
        show_alert: true,
      }),
    });
  }
}

export async function showGroupMessages(env, callbackQuery, targetChatId, offset) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const limit = 10;
  const { results } = await env.DB
    .prepare(
      `SELECT message_id, text_preview, datetime(created_at, '+7 hours') as created_at
       FROM bot_messages
       WHERE chat_id = ? AND created_at > datetime('now', '-48 hours')
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(targetChatId, limit + 1, offset)
    .all();
  const hasNext = results.length > limit;
  const rows = results.slice(0, limit);
  if (!rows.length) {
    const buttons = [[{ text: "⬅️ กลับ", callback_data: "del:b" }]];
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: `ไม่มีข้อความของ ${env.BOT_NAME || "Friday"} ในกลุ่มนี้ในช่วง 48 ชม.ที่ผ่านมาค่ะนาย`,
        reply_markup: { inline_keyboard: buttons },
      }),
    });
    return;
  }
  const buttons = rows.map((r) => {
    const preview = (r.text_preview || "").substring(0, 30);
    const label = `${env.BOT_NAME || "Friday"}: ${preview}${(r.text_preview || "").length > 30 ? "…" : ""}`;
    return [{ text: label, callback_data: `del:m:${targetChatId}:${r.message_id}` }];
  });
  // ปุ่มลบทั้งหมด
  buttons.push([{ text: "🗑 ลบทั้งหมดในกลุ่มนี้", callback_data: `del:a:${targetChatId}` }]);
  const nav = [];
  nav.push({ text: "⬅️ กลับ", callback_data: "del:b" });
  if (hasNext) {
    nav.push({ text: "หน้าถัดไป ➡️", callback_data: `del:p:${targetChatId}:${offset + limit}` });
  }
  buttons.push(nav);
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: `🗑 แตะข้อความของ ${env.BOT_NAME || "Friday"} ที่ต้องการลบ:`,
      reply_markup: { inline_keyboard: buttons },
    }),
  });
}

export async function showGroupList(env, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const { results } = await env.DB
    .prepare(
      `SELECT chat_id, MAX(created_at) as last_msg
       FROM bot_messages
       WHERE created_at > datetime('now', '-48 hours')
       GROUP BY chat_id
       ORDER BY last_msg DESC`
    )
    .all();
  if (!results.length) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: `ไม่พบข้อความของ ${env.BOT_NAME || "Friday"} ในกลุ่มใดเลยในช่วง 48 ชม.ที่ผ่านมาค่ะนาย`,
        reply_markup: { inline_keyboard: [] },
      }),
    });
    return;
  }
  // ดึงชื่อกลุ่ม
  const chatIds = results.map(r => r.chat_id);
  const placeholders = chatIds.map(() => "?").join(",");
  const { results: titles } = await env.DB
    .prepare(
      `SELECT chat_id, chat_title FROM messages
       WHERE chat_id IN (${placeholders}) AND chat_title IS NOT NULL
       GROUP BY chat_id`
    )
    .bind(...chatIds)
    .all();
  const titleMap = {};
  for (const t of titles) titleMap[t.chat_id] = t.chat_title;

  const buttons = results.map((r) => [
    { text: titleMap[r.chat_id] || `Group ${r.chat_id}`, callback_data: `del:g:${r.chat_id}` },
  ]);
  buttons.push([{ text: "🗑 ลบทั้งหมดทุกกลุ่ม", callback_data: "del:aa" }]);
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: `🗑 เลือกกลุ่มที่ต้องการลบข้อความของ ${env.BOT_NAME || "Friday"}:`,
      reply_markup: { inline_keyboard: buttons },
    }),
  });
}

export async function executeDeleteMessage(env, callbackQuery, targetChatId, targetMsgId) {
  // ลบจาก Telegram
  const delRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: targetChatId, message_id: targetMsgId }),
  });
  const delResult = await delRes.json();
  // ลบจาก bot_messages DB
  await env.DB
    .prepare(`DELETE FROM bot_messages WHERE chat_id = ? AND message_id = ?`)
    .bind(targetChatId, targetMsgId)
    .run();
  let toastText;
  if (delResult.ok) {
    toastText = "ลบข้อความสำเร็จแล้วค่ะนาย ✓";
  } else {
    const desc = delResult.description || "";
    if (desc.includes("message to delete not found")) {
      toastText = "ข้อความถูกลบไปแล้วก่อนหน้านี้ (ลบจาก DB แล้ว)";
    } else if (desc.includes("message can't be deleted")) {
      toastText = "ไม่สามารถลบได้ — อาจเก่าเกิน 48 ชม.";
    } else if (desc.includes("upgraded to a supergroup")) {
      const migrateChatId = delResult.parameters?.migrate_to_chat_id;
      if (migrateChatId) {
        await env.DB.prepare(`UPDATE bot_messages SET chat_id = ? WHERE chat_id = ?`).bind(migrateChatId, targetChatId).run();
        await env.DB.prepare(`UPDATE messages SET chat_id = ? WHERE chat_id = ?`).bind(migrateChatId, targetChatId).run();
        toastText = "กลุ่มถูกอัพเกรดเป็น supergroup — อัพเดท DB แล้ว กรุณาลองใหม่";
      } else {
        await env.DB.prepare(`DELETE FROM bot_messages WHERE chat_id = ?`).bind(targetChatId).run();
        toastText = "กลุ่มถูกอัพเกรดเป็น supergroup — ลบข้อมูลเก่าจาก DB แล้ว";
      }
    } else {
      toastText = "ลบไม่สำเร็จ: " + desc;
    }
  }
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQuery.id,
      text: toastText,
      show_alert: true,
    }),
  });
  // Refresh รายการ
  await showGroupMessages(env, callbackQuery, targetChatId, 0);
}

export async function executeDeleteAll(env, callbackQuery, targetChatId) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  // ดึงข้อความทั้งหมดของบอทในกลุ่มนี้
  const { results } = await env.DB
    .prepare(
      `SELECT message_id FROM bot_messages
       WHERE chat_id = ? AND created_at > datetime('now', '-48 hours')`
    )
    .bind(targetChatId)
    .all();

  if (!results.length) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQuery.id,
        text: "ไม่มีข้อความให้ลบค่ะนาย",
        show_alert: true,
      }),
    });
    return;
  }

  // อัพเดทสถานะ
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: `🗑 กำลังลบข้อความของ ${env.BOT_NAME || "Friday"} ทั้งหมด ${results.length} ข้อความ...`,
      reply_markup: { inline_keyboard: [] },
    }),
  });

  let deleted = 0;
  let failed = 0;
  for (const row of results) {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: targetChatId, message_id: row.message_id }),
    });
    const result = await res.json();
    if (result.ok) {
      deleted++;
    } else {
      failed++;
    }
  }

  // ลบจาก DB
  await env.DB
    .prepare(`DELETE FROM bot_messages WHERE chat_id = ? AND created_at > datetime('now', '-48 hours')`)
    .bind(targetChatId)
    .run();

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: `🗑 ลบเสร็จแล้วค่ะนาย\n✅ ลบสำเร็จ: ${deleted}\n${failed > 0 ? `❌ ลบไม่ได้: ${failed} (อาจเก่าเกิน 48 ชม.)` : ""}`,
      reply_markup: { inline_keyboard: [[{ text: "⬅️ กลับ", callback_data: "del:b" }]] },
    }),
  });
}

export async function executeDeleteAllGroups(env, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  // ดึงข้อความทั้งหมดของบอทจากทุกกลุ่ม
  const { results } = await env.DB
    .prepare(
      `SELECT chat_id, message_id FROM bot_messages
       WHERE created_at > datetime('now', '-48 hours')`
    )
    .all();

  if (!results.length) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQuery.id,
        text: "ไม่มีข้อความให้ลบค่ะนาย",
        show_alert: true,
      }),
    });
    return;
  }

  // อัพเดทสถานะ
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: `🗑 กำลังลบข้อความของ ${env.BOT_NAME || "Friday"} ทั้งหมด ${results.length} ข้อความจากทุกกลุ่ม...`,
      reply_markup: { inline_keyboard: [] },
    }),
  });

  let deleted = 0;
  let failed = 0;
  for (const row of results) {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: row.chat_id, message_id: row.message_id }),
    });
    const result = await res.json();
    if (result.ok) {
      deleted++;
    } else {
      failed++;
    }
  }

  // ลบจาก DB
  await env.DB
    .prepare(`DELETE FROM bot_messages WHERE created_at > datetime('now', '-48 hours')`)
    .run();

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: `🗑 ลบเสร็จแล้วค่ะนาย\n✅ ลบสำเร็จ: ${deleted}\n${failed > 0 ? `❌ ลบไม่ได้: ${failed} (อาจเก่าเกิน 48 ชม.)` : ""}`,
      reply_markup: { inline_keyboard: [] },
    }),
  });
}
