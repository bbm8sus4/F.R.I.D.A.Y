import { sendTelegram, sendTelegramWithKeyboard, sendTyping } from "../lib/telegram.js";
import { escapeHtml, sanitizeHtml } from "../lib/html-utils.js";

export async function handleCompanyCommand(env, message) {
  try {
    const chatId = message.chat.id;
    await refreshCompanyOverview(env, chatId, null);
  } catch (err) {
    console.error("handleCompanyCommand error:", err);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดค่ะนาย ลองใหม่อีกครั้ง", message.message_id);
  }
}

export async function refreshCompanyOverview(env, chatId, messageId) {
  // Ensure companies table exists
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS companies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run();

  const { results: companies } = await env.DB.prepare(
    `SELECT c.id, c.name, COUNT(g.chat_id) as group_count
     FROM companies c LEFT JOIN group_registry g ON g.company_id = c.id
     GROUP BY c.id ORDER BY c.name ASC`
  ).all();

  const { results: assigned } = await env.DB.prepare(
    `SELECT g.chat_id, g.chat_title, c.name as company_name
     FROM group_registry g LEFT JOIN companies c ON g.company_id = c.id
     WHERE g.is_active = 1 AND g.company_id IS NOT NULL
     ORDER BY c.name ASC, g.chat_title ASC`
  ).all();

  const { results: unassigned } = await env.DB.prepare(
    `SELECT chat_id, chat_title FROM group_registry
     WHERE is_active = 1 AND (company_id IS NULL)
     ORDER BY chat_title ASC`
  ).all();

  let text = "🏢 จัดกลุ่มบริษัท\n\n";

  if (companies.length > 0) {
    // Group assigned groups by company
    const byCompany = {};
    for (const g of assigned) {
      if (!byCompany[g.company_name]) byCompany[g.company_name] = [];
      byCompany[g.company_name].push(g.chat_title);
    }
    for (const c of companies) {
      const groups = byCompany[c.name] || [];
      text += `🏢 ${c.name} (${groups.length} กลุ่ม)\n`;
      for (const title of groups) {
        text += `  • ${title}\n`;
      }
      text += "\n";
    }
  }

  if (unassigned.length > 0) {
    text += `📎 ยังไม่จัดกลุ่ม (${unassigned.length})\n`;
    for (const g of unassigned) {
      text += `  • ${g.chat_title}\n`;
    }
    text += "\n";
  }

  if (companies.length === 0 && unassigned.length === 0) {
    text += "ยังไม่มีกลุ่มหรือบริษัทค่ะ\n";
  }

  const buttons = [
    [
      { text: "➕ เพิ่มบริษัท", callback_data: "co:add" },
      { text: "✏️ จัดกลุ่ม", callback_data: "co:assign" },
      { text: "🗑 ลบบริษัท", callback_data: "co:del" },
    ],
  ];

  if (messageId) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: sanitizeHtml(text.trim()),
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons },
      }),
    });
  } else {
    await sendTelegramWithKeyboard(env, chatId, text.trim(), null, buttons);
  }
}

export async function handleCompanyCallback(env, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQuery.id }),
  });

  try {
    // Ensure companies table exists
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS companies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run();

    if (data === "co:add") {
      // Ask user to type company name via force reply
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "🏢 พิมพ์ชื่อบริษัทใหม่:",
          reply_markup: { force_reply: true, selective: false },
        }),
      });
      return;
    }

    if (data === "co:assign") {
      // Show list of groups as buttons
      const { results: groups } = await env.DB.prepare(
        `SELECT g.chat_id, g.chat_title, c.name as company_name
         FROM group_registry g LEFT JOIN companies c ON g.company_id = c.id
         WHERE g.is_active = 1 ORDER BY g.chat_title ASC`
      ).all();

      if (groups.length === 0) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: "ยังไม่มีกลุ่มในระบบค่ะ",
            reply_markup: { inline_keyboard: [[{ text: "⬅️ กลับ", callback_data: "co:back" }]] },
          }),
        });
        return;
      }

      const buttons = groups.map(g => {
        const label = g.company_name ? `${g.chat_title} [${g.company_name}]` : g.chat_title;
        return [{ text: label, callback_data: `co:g:${g.chat_id}` }];
      });
      buttons.push([{ text: "⬅️ กลับ", callback_data: "co:back" }]);

      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: "✏️ เลือกกลุ่มที่จะจัดบริษัท:",
          reply_markup: { inline_keyboard: buttons },
        }),
      });
      return;
    }

    // co:g:<chatId> — selected a group, now show company choices
    const groupMatch = data.match(/^co:g:(-?\d+)$/);
    if (groupMatch) {
      const targetChatId = groupMatch[1];
      const group = await env.DB.prepare(
        `SELECT chat_title FROM group_registry WHERE chat_id = ?`
      ).bind(targetChatId).first();

      const { results: companies } = await env.DB.prepare(
        `SELECT id, name FROM companies ORDER BY name ASC`
      ).all();

      if (companies.length === 0) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: `ยังไม่มีบริษัทในระบบค่ะ กรุณาเพิ่มบริษัทก่อน`,
            reply_markup: { inline_keyboard: [[{ text: "⬅️ กลับ", callback_data: "co:back" }]] },
          }),
        });
        return;
      }

      const buttons = companies.map(c => [{ text: `🏢 ${c.name}`, callback_data: `co:s:${targetChatId}:${c.id}` }]);
      buttons.push([{ text: "📎 ไม่มีบริษัท", callback_data: `co:s:${targetChatId}:0` }]);
      buttons.push([{ text: "⬅️ กลับ", callback_data: "co:assign" }]);

      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: `เลือกบริษัทสำหรับ "${group?.chat_title || targetChatId}":`,
          reply_markup: { inline_keyboard: buttons },
        }),
      });
      return;
    }

    // co:s:<chatId>:<companyId> — assign group to company
    const setMatch = data.match(/^co:s:(-?\d+):(\d+)$/);
    if (setMatch) {
      const targetChatId = setMatch[1];
      const companyId = parseInt(setMatch[2]);
      await env.DB.prepare(
        `UPDATE group_registry SET company_id = ? WHERE chat_id = ?`
      ).bind(companyId === 0 ? null : companyId, targetChatId).run();
      await refreshCompanyOverview(env, chatId, messageId);
      return;
    }

    if (data === "co:del") {
      const { results: companies } = await env.DB.prepare(
        `SELECT id, name FROM companies ORDER BY name ASC`
      ).all();

      if (companies.length === 0) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: "ไม่มีบริษัทให้ลบค่ะ",
            reply_markup: { inline_keyboard: [[{ text: "⬅️ กลับ", callback_data: "co:back" }]] },
          }),
        });
        return;
      }

      const buttons = companies.map(c => [{ text: `🗑 ${c.name}`, callback_data: `co:rm:${c.id}` }]);
      buttons.push([{ text: "⬅️ กลับ", callback_data: "co:back" }]);

      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: "🗑 เลือกบริษัทที่จะลบ:",
          reply_markup: { inline_keyboard: buttons },
        }),
      });
      return;
    }

    // co:rm:<companyId> — delete company
    const rmMatch = data.match(/^co:rm:(\d+)$/);
    if (rmMatch) {
      const companyId = parseInt(rmMatch[1]);
      await env.DB.prepare(`UPDATE group_registry SET company_id = NULL WHERE company_id = ?`).bind(companyId).run();
      await env.DB.prepare(`DELETE FROM companies WHERE id = ?`).bind(companyId).run();
      await refreshCompanyOverview(env, chatId, messageId);
      return;
    }

    if (data === "co:back") {
      await refreshCompanyOverview(env, chatId, messageId);
      return;
    }
  } catch (err) {
    console.error("handleCompanyCallback error:", err);
  }
}

export async function handleCompanyReply(env, message, text) {
  const chatId = message.chat.id;
  const companyName = text.trim();

  if (!companyName) {
    await sendTelegram(env, chatId, "กรุณาพิมพ์ชื่อบริษัทค่ะ", message.message_id);
    return;
  }

  try {
    // Ensure companies table exists
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS companies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run();

    await env.DB.prepare(
      `INSERT INTO companies (name) VALUES (?)`
    ).bind(companyName).run();

    await refreshCompanyOverview(env, chatId, null);
  } catch (err) {
    if (err.message?.includes("UNIQUE")) {
      await sendTelegram(env, chatId, `บริษัท "${companyName}" มีอยู่แล้วค่ะ`, message.message_id);
    } else {
      console.error("handleCompanyReply error:", err);
      await sendTelegram(env, chatId, "เกิดข้อผิดพลาดค่ะนาย", message.message_id);
    }
  }
}
