import { sendTelegram, trackBotMessage } from "../lib/telegram.js";

export async function handleSummaryCommand(env, message, args) {
  try {
    const chatId = message.chat.id;
    const isDM = message.chat.type === "private";
    const parts = args.trim().split(/\s+/);

    if (parts[0] === "backfill") {
      // /summary backfill — generate daily summaries for all missing dates (default last 7 days)
      // /summary backfill 2026-03-18 — from specific date
      const fromDate = parts[1] || null;
      const daysBack = fromDate ? null : 7;

      await sendTelegram(env, chatId, "⏳ กำลัง backfill daily summaries... รอสักครู่ค่ะนาย", message.message_id);

      // Find all group × date combos with messages but no daily summary
      let query, bindParams;
      if (fromDate) {
        query = `SELECT DISTINCT chat_id, chat_title, date(created_at, '+7 hours') as msg_date
                 FROM messages
                 WHERE chat_title IS NOT NULL AND date(created_at, '+7 hours') >= ?
                   AND date(created_at, '+7 hours') < date('now', '+7 hours')
                 ORDER BY msg_date ASC`;
        bindParams = [fromDate];
      } else {
        query = `SELECT DISTINCT chat_id, chat_title, date(created_at, '+7 hours') as msg_date
                 FROM messages
                 WHERE chat_title IS NOT NULL AND created_at >= datetime('now', '-' || ? || ' days')
                   AND date(created_at, '+7 hours') < date('now', '+7 hours')
                 ORDER BY msg_date ASC`;
        bindParams = [daysBack];
      }

      const { results: combos } = await env.DB.prepare(query).bind(...bindParams).all();

      let created = 0, skipped = 0, failed = 0;
      const processed = [];

      for (const combo of combos) {
        // Check if daily summary already exists
        const existing = await env.DB.prepare(
          `SELECT id FROM summaries WHERE chat_id = ? AND summary_type = 'daily' AND summary_date = ?`
        ).bind(combo.chat_id, combo.msg_date).first();

        if (existing) { skipped++; continue; }

        // Get messages for this group × date
        const { results: dayMessages } = await env.DB.prepare(
          `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at
           FROM messages WHERE chat_id = ? AND date(created_at, '+7 hours') = ?
           ORDER BY created_at ASC LIMIT 500`
        ).bind(combo.chat_id, combo.msg_date).all();

        if (dayMessages.length === 0) { skipped++; continue; }

        const conversationText = dayMessages
          .map(m => {
            const name = m.username ? `@${m.username}` : m.first_name || "Unknown";
            return `[${m.created_at}] ${name}: ${m.message_text}`;
          })
          .join("\n");

        const summary = await generateDailySummary(env, combo.chat_title || "Unknown", conversationText, combo.msg_date);

        if (summary) {
          await env.DB.prepare(
            `INSERT INTO summaries (chat_id, chat_title, week_start, week_end, summary_text, message_count, summary_type, summary_date)
             VALUES (?, ?, ?, ?, ?, ?, 'daily', ?)`
          ).bind(combo.chat_id, combo.chat_title, combo.msg_date, combo.msg_date, summary, dayMessages.length, combo.msg_date).run();
          created++;
          processed.push(`📅 ${combo.msg_date} | ${combo.chat_title} (${dayMessages.length} msg)`);
        } else {
          failed++;
        }
      }

      let reply = `✅ Backfill เสร็จแล้วค่ะนาย\n\n`;
      reply += `สร้างใหม่: ${created} | ข้าม (มีแล้ว): ${skipped} | ล้มเหลว: ${failed}\n\n`;
      if (processed.length > 0) {
        reply += processed.join("\n") + "\n\n";
      }
      reply += `ใช้ /summary ดูผลได้เลยค่ะ`;
      await sendTelegram(env, chatId, reply.trim(), message.message_id);
      return;
    }

    if (parts[0] === "search" && parts.length > 1) {
      // /summary search <keyword>
      const keyword = parts.slice(1).join(" ");
      const searchQuery = isDM
        ? `SELECT chat_title, COALESCE(summary_date, week_end) as summary_date,
                  COALESCE(summary_type, 'weekly') as summary_type, summary_text, message_count
           FROM summaries
           WHERE summary_text LIKE ?
           ORDER BY COALESCE(summary_date, week_end) DESC LIMIT 10`
        : `SELECT chat_title, COALESCE(summary_date, week_end) as summary_date,
                  COALESCE(summary_type, 'weekly') as summary_type, summary_text, message_count
           FROM summaries
           WHERE summary_text LIKE ? AND chat_id = ?
           ORDER BY COALESCE(summary_date, week_end) DESC LIMIT 10`;
      const searchBinds = isDM ? [`%${keyword}%`] : [`%${keyword}%`, chatId];
      const { results } = await env.DB.prepare(searchQuery).bind(...searchBinds).all();

      if (results.length === 0) {
        await sendTelegram(env, chatId, `ไม่พบ summary ที่มีคำว่า "${keyword}" ค่ะนาย`, message.message_id);
        return;
      }

      let reply = `🔍 ค้นหา summary: "${keyword}" (${results.length} รายการ)\n\n`;
      for (const s of results) {
        const typeLabel = s.summary_type === "daily" ? "📅" : "📆";
        reply += `${typeLabel} ${s.summary_date} | ${s.chat_title} (${s.message_count} msg)\n`;
        reply += s.summary_text.substring(0, 300) + (s.summary_text.length > 300 ? "..." : "") + "\n\n";
      }
      await sendTelegram(env, chatId, reply.trim(), message.message_id);
    } else {
      // /summary หรือ /summary <N>
      const days = parseInt(parts[0]) || 7;
      const { text: reply, buttons } = await buildSummaryListing(env, chatId, isDM, days);
      await sendSummaryWithButtons(env, chatId, reply, message.message_id, buttons);
    }
  } catch (err) {
    console.error("handleSummaryCommand error:", err);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดค่ะนาย ลองใหม่อีกครั้ง", message.message_id);
  }
}

export async function sendSummaryWithButtons(env, chatId, text, replyToMessageId, buttons) {
  // Summary text is plain text (no HTML) — send without parse_mode to avoid HTML parse errors
  // Truncate to fit Telegram's 4096 char limit with buttons
  const sendText = text.length > 4000 ? text.substring(0, 4000) + "\n\n…(ตัดบางส่วน)" : text;
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: sendText,
      reply_to_message_id: replyToMessageId,
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: buttons },
    }),
  });
  if (!res.ok) {
    console.error("sendSummaryWithButtons error:", await res.text());
  } else {
    try {
      const result = await res.clone().json();
      if (result.ok) await trackBotMessage(env, chatId, result.result.message_id, text);
    } catch (e) { /* ignore */ }
  }
}

export function summaryDayButtons(activeDays, groupChatId) {
  const options = [3, 7, 14, 30];
  const prefix = groupChatId ? `sm:${groupChatId}:` : "sm:dm:";
  return [options.map(d => ({
    text: d === activeDays ? `• ${d} วัน •` : `${d} วัน`,
    callback_data: `${prefix}${d}`,
  }))];
}

export async function buildSummaryListing(env, chatId, isDM, days) {
  // Check if companies exist (for grouped display in DM)
  let hasCompanies = false;
  if (isDM) {
    try {
      const companyCount = await env.DB.prepare(`SELECT COUNT(*) as cnt FROM companies`).first();
      hasCompanies = companyCount && companyCount.cnt > 0;
    } catch { /* companies table may not exist yet */ }
  }

  if (isDM && hasCompanies) {
    const { results } = await env.DB.prepare(
      `SELECT s.chat_title, COALESCE(s.summary_date, s.week_end) as summary_date,
              COALESCE(s.summary_type, 'weekly') as summary_type, s.summary_text, s.message_count,
              c.name as company_name
       FROM summaries s
       LEFT JOIN group_registry g ON s.chat_id = g.chat_id
       LEFT JOIN companies c ON g.company_id = c.id
       WHERE COALESCE(s.summary_date, s.week_end) >= date('now', '-' || ? || ' days')
       ORDER BY COALESCE(c.name, 'zzz') ASC, COALESCE(s.summary_date, s.week_end) DESC
       LIMIT 30`
    ).bind(days).all();

    if (results.length === 0) {
      return { text: `ไม่มี summary ใน ${days} วันที่ผ่านมาค่ะนาย`, buttons: summaryDayButtons(days, null) };
    }

    let reply = `📋 Summaries (${days} วันล่าสุด): ${results.length} รายการ\n\n`;
    let currentCompany = undefined;
    for (const s of results) {
      const companyLabel = s.company_name || null;
      if (companyLabel !== currentCompany) {
        currentCompany = companyLabel;
        reply += currentCompany ? `🏢 ${currentCompany}\n` : `📎 อื่นๆ\n`;
      }
      const typeLabel = s.summary_type === "daily" ? "📅" : "📆";
      reply += `${typeLabel} ${s.summary_date} | ${s.chat_title} (${s.message_count} msg)\n`;
      reply += s.summary_text.substring(0, 300) + (s.summary_text.length > 300 ? "..." : "") + "\n\n";
    }
    return { text: reply.trim(), buttons: summaryDayButtons(days, null) };
  }

  // Flat list (group chat or no companies)
  const listQuery = isDM
    ? `SELECT chat_title, COALESCE(summary_date, week_end) as summary_date,
              COALESCE(summary_type, 'weekly') as summary_type, summary_text, message_count
       FROM summaries
       WHERE COALESCE(summary_date, week_end) >= date('now', '-' || ? || ' days')
       ORDER BY COALESCE(summary_date, week_end) DESC LIMIT 20`
    : `SELECT chat_title, COALESCE(summary_date, week_end) as summary_date,
              COALESCE(summary_type, 'weekly') as summary_type, summary_text, message_count
       FROM summaries
       WHERE COALESCE(summary_date, week_end) >= date('now', '-' || ? || ' days') AND chat_id = ?
       ORDER BY COALESCE(summary_date, week_end) DESC LIMIT 20`;
  const listBinds = isDM ? [days] : [days, chatId];
  const { results } = await env.DB.prepare(listQuery).bind(...listBinds).all();

  const groupChatId = isDM ? null : chatId;

  if (results.length === 0) {
    return { text: `ไม่มี summary ใน ${days} วันที่ผ่านมาค่ะนาย`, buttons: summaryDayButtons(days, groupChatId) };
  }

  let reply = `📋 Summaries (${days} วันล่าสุด): ${results.length} รายการ\n\n`;
  for (const s of results) {
    const typeLabel = s.summary_type === "daily" ? "📅" : "📆";
    reply += `${typeLabel} ${s.summary_date} | ${s.chat_title} (${s.message_count} msg)\n`;
    reply += s.summary_text.substring(0, 300) + (s.summary_text.length > 300 ? "..." : "") + "\n\n";
  }
  return { text: reply.trim(), buttons: summaryDayButtons(days, groupChatId) };
}

export async function handleSummaryCallback(env, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;

  // sm:dm:<days> or sm:<groupChatId>:<days>
  const match = data.match(/^sm:(dm|(-?\d+)):(\d+)$/);
  if (!match) return;

  const isDM = match[1] === "dm";
  const targetChatId = isDM ? chatId : match[1];
  const days = parseInt(match[3]) || 7;

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQuery.id }),
  });

  try {
    const { text, buttons } = await buildSummaryListing(env, targetChatId, isDM, days);
    const editText = text.length > 4000 ? text.substring(0, 4000) + "\n\n…(ตัดบางส่วน)" : text;
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: editText,
        reply_markup: { inline_keyboard: buttons },
      }),
    });
  } catch (err) {
    console.error("handleSummaryCallback error:", err);
  }
}

export async function generateDailySummary(env, groupTitle, conversationText, dateStr) {
  const prompt = `สรุปบทสนทนาของกลุ่ม "${groupTitle}" วันที่ ${dateStr} อย่างละเอียด เน้น:
1. หัวข้อหลักที่คุยกัน — แต่ละหัวข้อสรุปประเด็นสำคัญ
2. การตัดสินใจสำคัญ — ใครตัดสินใจอะไร เหตุผล
3. งานที่มอบหมาย — ใคร ทำอะไร เมื่อไหร่ สถานะ
4. ตัวเลข/จำนวนเงินสำคัญ — ยอด ราคา จำนวน
5. ปัญหาหรือข้อกังวลที่ยังค้าง — อะไรยังไม่ได้แก้
6. ข้อมูลสำคัญอื่นๆ — ชื่อคน สถานที่ ลิงก์ รหัสอ้างอิง ที่อาจต้องใช้ภายหลัง

ถ้าไม่มีเรื่องสำคัญเลย ให้สรุปสั้นๆ 2-3 ประโยคว่าคุยเรื่องอะไร
ตอบเป็นภาษาไทย ละเอียดแต่กระชับ ไม่เกิน 1500 คำ`;

  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: prompt }] },
      contents: [{ role: "user", parts: [{ text: conversationText }] }],
      generationConfig: { maxOutputTokens: 4096 },
    }),
  });

  if (!response.ok) {
    console.error("Daily summary Gemini error:", response.status);
    return null;
  }

  const data = await response.json();
  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts) return null;

  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].text && !parts[i].thought) return parts[i].text;
  }
  return parts.find(p => p.text)?.text || null;
}

export async function generateSummary(env, groupTitle, conversationText) {
  const prompt = `สรุปบทสนทนาของกลุ่ม "${groupTitle}" ให้กระชับที่สุด เน้น:
1. หัวข้อหลักที่คุยกัน
2. การตัดสินใจสำคัญ
3. งานที่มอบหมาย (ใคร ทำอะไร เมื่อไหร่)
4. ตัวเลข/จำนวนเงินสำคัญ
5. ปัญหาหรือข้อกังวลที่ยังค้าง

ถ้าไม่มีเรื่องสำคัญเลย ให้สรุปสั้นๆ 1-2 ประโยคว่าคุยเรื่องอะไร
ตอบเป็นภาษาไทย กระชับ ไม่เกิน 500 คำ`;

  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: prompt }] },
      contents: [{ role: "user", parts: [{ text: conversationText }] }],
      generationConfig: { maxOutputTokens: 2048 },
    }),
  });

  if (!response.ok) {
    console.error("Summary Gemini error:", response.status);
    return null;
  }

  const data = await response.json();
  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts) return null;

  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].text && !parts[i].thought) return parts[i].text;
  }
  return parts.find(p => p.text)?.text || null;
}
