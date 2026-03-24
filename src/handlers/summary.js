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

      const searchMaxLen = maxTextPerEntry(results.length);
      let reply = `🔍 ค้นหา summary: "${keyword}" (${results.length} รายการ)\n\n`;
      for (const s of results) {
        const typeLabel = s.summary_type === "daily" ? "📅" : "📆";
        reply += `${typeLabel} ${s.summary_date} | ${s.chat_title} (${s.message_count} msg)\n`;
        reply += truncate(s.summary_text, searchMaxLen) + "\n\n";
      }
      await sendTelegram(env, chatId, reply.trim(), message.message_id);
    } else if (isDM && !parseInt(parts[0])) {
      // DM with no numeric arg → interactive flow
      const hasCompanies = await checkHasCompanies(env);
      if (hasCompanies) {
        await showCompanySelection(env, chatId, message.message_id, null);
      } else {
        await showDaySelection(env, chatId, message.message_id, "all", false);
      }
    } else {
      // /summary <N> (with arg) or group chat → direct listing
      const days = parseInt(parts[0]) || 7;
      if (isDM) {
        const { text: reply, buttons } = await buildSummaryListing(env, chatId, true, days, "all");
        await sendSummaryWithButtons(env, chatId, reply, message.message_id, buttons);
      } else {
        const { text: reply, buttons } = await buildSummaryListing(env, chatId, false, days, null);
        await sendSummaryWithButtons(env, chatId, reply, message.message_id, buttons);
      }
    }
  } catch (err) {
    console.error("handleSummaryCommand error:", err);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดค่ะนาย ลองใหม่อีกครั้ง", message.message_id);
  }
}

// --- Helpers ---

async function checkHasCompanies(env) {
  try {
    const row = await env.DB.prepare(`SELECT COUNT(*) as cnt FROM companies`).first();
    return row && row.cnt > 0;
  } catch { return false; }
}

async function resolveCompanyName(env, companyFilter) {
  if (companyFilter === "all") return "ทั้งหมด";
  if (companyFilter === "none") return "อื่นๆ";
  try {
    const row = await env.DB.prepare(`SELECT name FROM companies WHERE id = ?`).bind(Number(companyFilter)).first();
    return row?.name || `Company #${companyFilter}`;
  } catch { return `Company #${companyFilter}`; }
}

// --- Step 1: Company Selection ---

async function showCompanySelection(env, chatId, replyToMessageId, messageIdToEdit) {
  let companies = [];
  let hasUnassigned = false;
  try {
    const { results } = await env.DB.prepare(`SELECT id, name FROM companies ORDER BY name ASC`).all();
    companies = results || [];
    const unassigned = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM group_registry WHERE is_active = 1 AND company_id IS NULL`
    ).first();
    hasUnassigned = unassigned && unassigned.cnt > 0;
  } catch { /* companies table may not exist */ }

  const text = "📋 Summary — เลือกบริษัท:";
  const buttons = [];
  buttons.push([{ text: "📋 ทั้งหมด", callback_data: "sm:co:all" }]);
  // 2 companies per row
  for (let i = 0; i < companies.length; i += 2) {
    const row = [{ text: `🏢 ${companies[i].name}`, callback_data: `sm:co:${companies[i].id}` }];
    if (companies[i + 1]) {
      row.push({ text: `🏢 ${companies[i + 1].name}`, callback_data: `sm:co:${companies[i + 1].id}` });
    }
    buttons.push(row);
  }
  if (hasUnassigned) {
    buttons.push([{ text: "📎 อื่นๆ", callback_data: "sm:co:none" }]);
  }

  if (messageIdToEdit) {
    await editMessage(env, chatId, messageIdToEdit, text, buttons);
  } else {
    await sendSummaryWithButtons(env, chatId, text, replyToMessageId, buttons);
  }
}

// --- Step 2: Day Selection ---

async function showDaySelection(env, chatId, messageIdOrReplyTo, companyFilter, isEdit) {
  const companyName = await resolveCompanyName(env, companyFilter);
  const text = `📋 Summary "${companyName}" — เลือกช่วงเวลา:`;
  const buttons = [
    [
      { text: "📅 1 วัน", callback_data: `sm:v:${companyFilter}:1` },
      { text: "📅 3 วัน", callback_data: `sm:v:${companyFilter}:3` },
    ],
    [
      { text: "📅 7 วัน", callback_data: `sm:v:${companyFilter}:7` },
      { text: "✏️ กำหนดเอง", callback_data: `sm:c:${companyFilter}` },
    ],
  ];
  // Show back button only if companies exist
  const hasCompanies = await checkHasCompanies(env);
  if (hasCompanies) {
    buttons.push([{ text: "⬅️ เลือกบริษัท", callback_data: "sm:back" }]);
  }

  if (isEdit) {
    await editMessage(env, chatId, messageIdOrReplyTo, text, buttons);
  } else {
    await sendSummaryWithButtons(env, chatId, text, messageIdOrReplyTo, buttons);
  }
}

// --- Step 3: Result buttons ---

function summaryResultButtons(activeDays, companyFilter) {
  const options = [1, 3, 7];
  const row1 = options.map(d => ({
    text: d === activeDays ? `• ${d} วัน •` : `${d} วัน`,
    callback_data: `sm:v:${companyFilter}:${d}`,
  }));
  const row2 = [
    { text: "✏️ กำหนดเอง", callback_data: `sm:c:${companyFilter}` },
    { text: "⬅️ เลือกบริษัท", callback_data: "sm:back" },
  ];
  return [row1, row2];
}

// --- Existing helpers (kept) ---

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

async function editMessage(env, chatId, messageId, text, buttons) {
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
}

export function summaryDayButtons(activeDays, groupChatId) {
  const options = [3, 7, 14, 30];
  const prefix = groupChatId ? `sm:${groupChatId}:` : "sm:dm:";
  return [options.map(d => ({
    text: d === activeDays ? `• ${d} วัน •` : `${d} วัน`,
    callback_data: `${prefix}${d}`,
  }))];
}

// Dynamic truncation: allocate text budget per entry based on count
// Telegram limit = 4096, reserve ~200 for header/buttons, ~100 per entry for metadata line
function maxTextPerEntry(count) {
  if (count <= 0) return 800;
  const available = 3800 - (count * 80); // header overhead per entry
  return Math.max(200, Math.min(1500, Math.floor(available / count)));
}

function truncate(text, limit) {
  return text.length > limit ? text.substring(0, limit) + "..." : text;
}

// --- Build Summary Listing ---

export async function buildSummaryListing(env, chatId, isDM, days, companyFilter) {
  // companyFilter: "all" = all companies grouped, "none" = unassigned only, numeric = specific company, null = group chat (flat)
  if (isDM && companyFilter !== null) {
    // DM with company filter
    let query, bindParams;
    if (companyFilter === "none") {
      query = `SELECT s.chat_title, COALESCE(s.summary_date, s.week_end) as summary_date,
                COALESCE(s.summary_type, 'weekly') as summary_type, s.summary_text, s.message_count,
                NULL as company_name
         FROM summaries s
         LEFT JOIN group_registry g ON s.chat_id = g.chat_id
         WHERE COALESCE(s.summary_date, s.week_end) >= date('now', '-' || ? || ' days')
           AND (g.company_id IS NULL)
         ORDER BY COALESCE(s.summary_date, s.week_end) DESC
         LIMIT 30`;
      bindParams = [days];
    } else if (companyFilter !== "all" && !isNaN(Number(companyFilter))) {
      query = `SELECT s.chat_title, COALESCE(s.summary_date, s.week_end) as summary_date,
                COALESCE(s.summary_type, 'weekly') as summary_type, s.summary_text, s.message_count,
                c.name as company_name
         FROM summaries s
         LEFT JOIN group_registry g ON s.chat_id = g.chat_id
         LEFT JOIN companies c ON g.company_id = c.id
         WHERE COALESCE(s.summary_date, s.week_end) >= date('now', '-' || ? || ' days')
           AND g.company_id = ?
         ORDER BY COALESCE(s.summary_date, s.week_end) DESC
         LIMIT 30`;
      bindParams = [days, Number(companyFilter)];
    } else {
      // "all" — group by company
      query = `SELECT s.chat_title, COALESCE(s.summary_date, s.week_end) as summary_date,
                COALESCE(s.summary_type, 'weekly') as summary_type, s.summary_text, s.message_count,
                c.name as company_name
         FROM summaries s
         LEFT JOIN group_registry g ON s.chat_id = g.chat_id
         LEFT JOIN companies c ON g.company_id = c.id
         WHERE COALESCE(s.summary_date, s.week_end) >= date('now', '-' || ? || ' days')
         ORDER BY COALESCE(c.name, 'zzz') ASC, COALESCE(s.summary_date, s.week_end) DESC
         LIMIT 30`;
      bindParams = [days];
    }

    const { results } = await env.DB.prepare(query).bind(...bindParams).all();
    const companyName = await resolveCompanyName(env, companyFilter);
    const buttons = summaryResultButtons(days, companyFilter);

    if (results.length === 0) {
      return { text: `📋 "${companyName}" — ไม่มี summary ใน ${days} วันที่ผ่านมาค่ะนาย`, buttons };
    }

    const maxLen = maxTextPerEntry(results.length);
    let reply = `📋 Summary "${companyName}" (${days} วันล่าสุด): ${results.length} รายการ\n\n`;
    if (companyFilter === "all") {
      let currentCompany = undefined;
      for (const s of results) {
        const companyLabel = s.company_name || null;
        if (companyLabel !== currentCompany) {
          currentCompany = companyLabel;
          reply += currentCompany ? `🏢 ${currentCompany}\n` : `📎 อื่นๆ\n`;
        }
        const typeLabel = s.summary_type === "daily" ? "📅" : "📆";
        reply += `${typeLabel} ${s.summary_date} | ${s.chat_title} (${s.message_count} msg)\n`;
        reply += truncate(s.summary_text, maxLen) + "\n\n";
      }
    } else {
      for (const s of results) {
        const typeLabel = s.summary_type === "daily" ? "📅" : "📆";
        reply += `${typeLabel} ${s.summary_date} | ${s.chat_title} (${s.message_count} msg)\n`;
        reply += truncate(s.summary_text, maxLen) + "\n\n";
      }
    }
    return { text: reply.trim(), buttons };
  }

  // Group chat or DM without company filter (legacy) — flat list
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

  const maxLen = maxTextPerEntry(results.length);
  let reply = `📋 Summaries (${days} วันล่าสุด): ${results.length} รายการ\n\n`;
  for (const s of results) {
    const typeLabel = s.summary_type === "daily" ? "📅" : "📆";
    reply += `${typeLabel} ${s.summary_date} | ${s.chat_title} (${s.message_count} msg)\n`;
    reply += truncate(s.summary_text, maxLen) + "\n\n";
  }
  return { text: reply.trim(), buttons: summaryDayButtons(days, groupChatId) };
}

// --- Callback Handler ---

export async function handleSummaryCallback(env, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;

  const answerCallback = () => fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQuery.id }),
  });

  try {
    // sm:back → back to company selection
    if (data === "sm:back") {
      await answerCallback();
      await showCompanySelection(env, chatId, null, messageId);
      return;
    }

    // sm:co:<filter> → show day selection
    const coMatch = data.match(/^sm:co:(.+)$/);
    if (coMatch) {
      await answerCallback();
      const companyFilter = coMatch[1];
      await showDaySelection(env, chatId, messageId, companyFilter, true);
      return;
    }

    // sm:v:<filter>:<days> → show summary results
    const vMatch = data.match(/^sm:v:(.+):(\d+)$/);
    if (vMatch) {
      await answerCallback();
      const companyFilter = vMatch[1];
      const days = parseInt(vMatch[2]) || 7;
      const { text, buttons } = await buildSummaryListing(env, chatId, true, days, companyFilter);
      await editMessage(env, chatId, messageId, text, buttons);
      return;
    }

    // sm:c:<filter> → custom days (force_reply)
    const cMatch = data.match(/^sm:c:(.+)$/);
    if (cMatch) {
      const companyFilter = cMatch[1];
      // Store pending custom in DB
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS pending_summary_custom (user_id INTEGER PRIMARY KEY, company_filter TEXT, created_at TEXT DEFAULT (datetime('now')))`
      ).run();
      await env.DB.prepare(
        `INSERT OR REPLACE INTO pending_summary_custom (user_id, company_filter) VALUES (?, ?)`
      ).bind(chatId, companyFilter).run();

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
          text: "📋 กรุณาพิมพ์จำนวนวัน (1-365) ที่ต้องการดู Summary (reply ข้อความนี้ค่ะ)",
          reply_markup: { force_reply: true, selective: true },
        }),
      });

      await answerCallback();
      return;
    }

    // Legacy: sm:dm:<days>
    const dmMatch = data.match(/^sm:dm:(\d+)$/);
    if (dmMatch) {
      await answerCallback();
      const days = parseInt(dmMatch[1]) || 7;
      const { text, buttons } = await buildSummaryListing(env, chatId, true, days, "all");
      await editMessage(env, chatId, messageId, text, buttons);
      return;
    }

    // Legacy: sm:<groupChatId>:<days>
    const groupMatch = data.match(/^sm:(-?\d+):(\d+)$/);
    if (groupMatch) {
      await answerCallback();
      const targetChatId = groupMatch[1];
      const days = parseInt(groupMatch[2]) || 7;
      const { text, buttons } = await buildSummaryListing(env, targetChatId, false, days, null);
      await editMessage(env, chatId, messageId, text, buttons);
      return;
    }
  } catch (err) {
    console.error("handleSummaryCallback error:", err);
  }

  // Fallback: answer callback to dismiss spinner
  await answerCallback().catch(() => {});
}

// --- Custom Reply Handler ---

export async function handleSummaryCustomReply(env, message, companyFilter, text) {
  const chatId = message.chat.id;
  const days = parseInt(text.trim());
  if (!days || days < 1 || days > 365) {
    await sendTelegram(env, chatId, "กรุณาพิมพ์ตัวเลข 1-365 ค่ะ", message.message_id);
    return;
  }
  const { text: reply, buttons } = await buildSummaryListing(env, chatId, true, days, companyFilter);
  await sendSummaryWithButtons(env, chatId, reply, message.message_id, buttons);
}

// --- Gemini Summary Generators ---

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
