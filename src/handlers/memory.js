import { sendTelegram, sendTelegramWithKeyboard } from "../lib/telegram.js";
import { escapeHtml } from "../lib/html-utils.js";

const VALID_CATEGORIES = ["person", "preference", "rule", "project", "task", "general"];

const PAGE_SIZE = 5;
const TIER_EMOJI = { hot: "🔴", warm: "🟡", cold: "🔵" };
const TIER_LABEL = { hot: "Hot", warm: "Warm", cold: "Cold" };

// ===== Helpers =====

async function editMessage(env, chatId, messageId, text, buttons) {
  const editText = text.length > 4000 ? text.substring(0, 4000) + "\n\n…(ตัดบางส่วน)" : text;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: editText,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: buttons },
    }),
  }).catch(e => console.error("memory editMessage error:", e.message));
}

function answerCallback(env, callbackQueryId) {
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

// ===== Dashboard =====

async function showDashboard(env, chatId, messageIdOrReplyTo, isEdit) {
  // Count by priority
  const { results: priCounts } = await env.DB
    .prepare(`SELECT priority, COUNT(*) as cnt FROM memories GROUP BY priority`)
    .all();
  const byPri = {};
  let total = 0;
  for (const r of priCounts) {
    byPri[r.priority] = r.cnt;
    total += r.cnt;
  }

  // Count by category
  const { results: catCounts } = await env.DB
    .prepare(`SELECT category, COUNT(*) as cnt FROM memories GROUP BY category ORDER BY cnt DESC`)
    .all();

  const hot = byPri["hot"] || 0;
  const warm = byPri["warm"] || 0;
  const cold = byPri["cold"] || 0;

  const catLine = catCounts.map(c => `${c.category}(${c.cnt})`).join(", ");

  let text = `🧠 <b>Memory Dashboard</b>\n\n`;
  text += `📊 <b>ภาพรวม:</b>\n`;
  text += `🔴 Hot: ${hot} | 🟡 Warm: ${warm} | 🔵 Cold: ${cold}\n`;
  if (catLine) text += `📁 หมวด: ${catLine}\n`;
  text += `\nเลือกดู:`;

  const buttons = [];
  buttons.push([{ text: `📋 ทั้งหมด (${total})`, callback_data: "mem:a:0" }]);

  const priRow = [];
  if (hot > 0) priRow.push({ text: `🔴 Hot (${hot})`, callback_data: "mem:p:hot:0" });
  if (warm > 0) priRow.push({ text: `🟡 Warm (${warm})`, callback_data: "mem:p:warm:0" });
  if (cold > 0) priRow.push({ text: `🔵 Cold (${cold})`, callback_data: "mem:p:cold:0" });
  if (priRow.length > 0) buttons.push(priRow);

  // Category buttons (max 3 per row, max 2 rows = 6 categories)
  const catBtns = catCounts.slice(0, 6).map(c => ({
    text: `📁 ${c.category}`,
    callback_data: `mem:c:${c.category.substring(0, 10)}:0`,
  }));
  for (let i = 0; i < catBtns.length; i += 3) {
    buttons.push(catBtns.slice(i, i + 3));
  }

  if (isEdit) {
    await editMessage(env, chatId, messageIdOrReplyTo, text, buttons);
  } else {
    await sendTelegramWithKeyboard(env, chatId, text, messageIdOrReplyTo, buttons);
  }
}

// ===== Memory List =====

async function showMemoryList(env, chatId, messageId, filter, offset) {
  offset = Math.max(0, parseInt(offset) || 0);

  // Parse filter
  let whereClause = "1=1";
  let bindParams = [];
  let filterLabel = "ทั้งหมด";
  let filterKey = "a"; // for callback src

  if (filter.startsWith("p:")) {
    const pri = filter.substring(2);
    whereClause = "priority = ?";
    bindParams = [pri];
    filterLabel = `${TIER_EMOJI[pri] || ""} ${TIER_LABEL[pri] || pri}`;
    filterKey = `p:${pri}`;
  } else if (filter.startsWith("c:")) {
    const cat = filter.substring(2);
    whereClause = "category = ?";
    bindParams = [cat];
    filterLabel = `📁 ${cat}`;
    filterKey = `c:${cat}`;
  }

  // Count total
  const countRow = await env.DB
    .prepare(`SELECT COUNT(*) as cnt FROM memories WHERE ${whereClause}`)
    .bind(...bindParams)
    .first();
  const total = countRow?.cnt || 0;

  // Get page
  const { results } = await env.DB
    .prepare(`SELECT id, content, category, priority FROM memories WHERE ${whereClause} ORDER BY CASE priority WHEN 'hot' THEN 1 WHEN 'warm' THEN 2 WHEN 'cold' THEN 3 ELSE 4 END, created_at DESC LIMIT ? OFFSET ?`)
    .bind(...bindParams, PAGE_SIZE, offset)
    .all();

  if (total === 0) {
    const text = `🧠 <b>Memories — ${filterLabel}</b>\n\nไม่พบความจำในหมวดนี้ค่ะ`;
    const buttons = [[{ text: "⬅️ Dashboard", callback_data: "mem:d" }]];
    await editMessage(env, chatId, messageId, text, buttons);
    return;
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  let text = `🧠 <b>Memories — ${filterLabel}</b> (${total} รายการ)\n\n`;
  results.forEach((m, i) => {
    const emoji = TIER_EMOJI[m.priority] || "⚪";
    const truncated = m.content.length > 60 ? m.content.substring(0, 57) + "..." : m.content;
    text += `${offset + i + 1}. #${m.id} ${emoji} [${escapeHtml(m.category)}] ${escapeHtml(truncated)}\n`;
  });

  const buttons = [];

  // ID buttons row(s) — max 5 per row
  const idBtns = results.map(m => ({
    text: `#${m.id}`,
    callback_data: `mem:v:${m.id}:${filterKey}:${offset}`,
  }));
  buttons.push(idBtns);

  // Pagination row
  const navRow = [];
  if (offset > 0) {
    navRow.push({ text: "◀️", callback_data: `mem:${filterKey}:${offset - PAGE_SIZE}` });
  }
  navRow.push({ text: `${currentPage}/${totalPages}`, callback_data: "mem:_" });
  if (offset + PAGE_SIZE < total) {
    navRow.push({ text: "▶️", callback_data: `mem:${filterKey === "a" ? "a" : filterKey}:${offset + PAGE_SIZE}` });
  }
  buttons.push(navRow);

  // Back button
  buttons.push([{ text: "⬅️ Dashboard", callback_data: "mem:d" }]);

  await editMessage(env, chatId, messageId, text, buttons);
}

// ===== Memory Detail =====

async function showMemoryDetail(env, chatId, messageId, memoryId, src) {
  const mem = await env.DB
    .prepare(`SELECT id, content, category, priority, datetime(created_at, '+7 hours') as created_at FROM memories WHERE id = ?`)
    .bind(memoryId)
    .first();

  if (!mem) {
    const text = `ไม่พบ Memory #${memoryId} ค่ะ`;
    const buttons = [[{ text: "⬅️ Dashboard", callback_data: "mem:d" }]];
    await editMessage(env, chatId, messageId, text, buttons);
    return;
  }

  const emoji = TIER_EMOJI[mem.priority] || "⚪";
  let text = `🧠 <b>Memory #${mem.id}</b>\n\n`;
  text += `📁 หมวด: ${escapeHtml(mem.category)}\n`;
  text += `${emoji} Priority: ${TIER_LABEL[mem.priority] || mem.priority}\n`;
  text += `📅 สร้างเมื่อ: ${mem.created_at}\n\n`;
  text += `📝 <b>เนื้อหา:</b>\n${escapeHtml(mem.content)}`;

  const buttons = [];

  // Priority change buttons (exclude current)
  const priRow = [];
  for (const [pri, label] of [["hot", "Hot"], ["warm", "Warm"], ["cold", "Cold"]]) {
    if (pri !== mem.priority) {
      priRow.push({ text: `${TIER_EMOJI[pri]} → ${label}`, callback_data: `mem:s:${mem.id}:${pri}:${src}` });
    }
  }
  if (priRow.length > 0) buttons.push(priRow);

  // Delete button
  buttons.push([{ text: "🗑 ลบ", callback_data: `mem:x:${mem.id}:${src}` }]);

  // Back button — parse src to go back to the list
  const backCb = src ? `mem:${src}` : "mem:d";
  buttons.push([{ text: "⬅️ กลับรายการ", callback_data: backCb }]);

  await editMessage(env, chatId, messageId, text, buttons);
}

// ===== Callback Handler =====

export async function handleMemoryCallback(env, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;

  try {
    // mem:_ → no-op
    if (data === "mem:_") {
      await answerCallback(env, callbackQuery.id);
      return;
    }

    // mem:d → Dashboard
    if (data === "mem:d") {
      await answerCallback(env, callbackQuery.id);
      await showDashboard(env, chatId, messageId, true);
      return;
    }

    // mem:a:<offset> → All memories list
    const allMatch = data.match(/^mem:a:(\d+)$/);
    if (allMatch) {
      await answerCallback(env, callbackQuery.id);
      await showMemoryList(env, chatId, messageId, "a", parseInt(allMatch[1]));
      return;
    }

    // mem:p:<pri>:<offset> → List by priority
    const priMatch = data.match(/^mem:p:(hot|warm|cold):(\d+)$/);
    if (priMatch) {
      await answerCallback(env, callbackQuery.id);
      await showMemoryList(env, chatId, messageId, `p:${priMatch[1]}`, parseInt(priMatch[2]));
      return;
    }

    // mem:c:<cat>:<offset> → List by category
    const catMatch = data.match(/^mem:c:([^:]+):(\d+)$/);
    if (catMatch) {
      await answerCallback(env, callbackQuery.id);
      await showMemoryList(env, chatId, messageId, `c:${catMatch[1]}`, parseInt(catMatch[2]));
      return;
    }

    // mem:v:<id>:<src> → View detail (src is the back-context like p:hot:0 or a:0)
    const viewMatch = data.match(/^mem:v:(\d+):(.+)$/);
    if (viewMatch) {
      await answerCallback(env, callbackQuery.id);
      await showMemoryDetail(env, chatId, messageId, parseInt(viewMatch[1]), viewMatch[2]);
      return;
    }

    // mem:s:<id>:<newPri>:<src> → Set priority
    const setMatch = data.match(/^mem:s:(\d+):(hot|warm|cold):(.+)$/);
    if (setMatch) {
      const [, id, newPri, src] = setMatch;
      await env.DB
        .prepare(`UPDATE memories SET priority = ? WHERE id = ?`)
        .bind(newPri, parseInt(id))
        .run();
      await answerCallback(env, callbackQuery.id);
      await showMemoryDetail(env, chatId, messageId, parseInt(id), src);
      return;
    }

    // mem:x:<id>:<src> → Delete confirmation
    const delMatch = data.match(/^mem:x:(\d+):(.+)$/);
    if (delMatch) {
      const [, id, src] = delMatch;
      await answerCallback(env, callbackQuery.id);
      const text = `🗑 ยืนยันลบ Memory #${id}?`;
      const buttons = [
        [
          { text: "✅ ยืนยัน", callback_data: `mem:xy:${id}:${src}` },
          { text: "❌ ยกเลิก", callback_data: `mem:v:${id}:${src}` },
        ],
      ];
      await editMessage(env, chatId, messageId, text, buttons);
      return;
    }

    // mem:xy:<id>:<src> → Confirm delete
    const delConfirmMatch = data.match(/^mem:xy:(\d+):(.+)$/);
    if (delConfirmMatch) {
      const [, id, src] = delConfirmMatch;
      await env.DB
        .prepare(`DELETE FROM memories WHERE id = ?`)
        .bind(parseInt(id))
        .run();
      await answerCallback(env, callbackQuery.id);
      // Go back to list
      // Parse src to reconstruct filter and offset
      const srcParts = src.split(":");
      if (srcParts[0] === "a") {
        await showMemoryList(env, chatId, messageId, "a", parseInt(srcParts[1]) || 0);
      } else if (srcParts[0] === "p" && srcParts.length >= 3) {
        await showMemoryList(env, chatId, messageId, `p:${srcParts[1]}`, parseInt(srcParts[2]) || 0);
      } else if (srcParts[0] === "c" && srcParts.length >= 3) {
        await showMemoryList(env, chatId, messageId, `c:${srcParts[1]}`, parseInt(srcParts[2]) || 0);
      } else {
        await showDashboard(env, chatId, messageId, true);
      }
      return;
    }

    // Fallback
    await answerCallback(env, callbackQuery.id);
  } catch (err) {
    console.error("handleMemoryCallback error:", err);
    await answerCallback(env, callbackQuery.id).catch(() => {});
  }
}

// ===== Original Command Handlers (kept for backward compat) =====

async function autoClassify(env, content) {
  try {
    if (!env.GEMINI_API_KEY) return "general";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL || 'gemini-2.5-pro'}:generateContent?key=${env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `จัดหมวดข้อความนี้เป็นหนึ่งใน: ${VALID_CATEGORIES.join(", ")}\n\nข้อความ: "${content}"\n\nตอบแค่คำเดียว (ชื่อหมวด):` }] }],
        generationConfig: { maxOutputTokens: 10, temperature: 0 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return "general";
    const data = await res.json();
    const answer = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim().toLowerCase();
    return VALID_CATEGORIES.includes(answer) ? answer : "general";
  } catch (e) {
    console.error("autoClassify error:", e);
    return "general";
  }
}

export async function handleRememberCommand(env, message, args) {
  try {
    let content = args.trim();
    if (!content) {
      await sendTelegram(env, message.chat.id, "Usage: /remember <สิ่งที่จะจำ>", message.message_id);
      return;
    }

    // Manual category override: /remember [work] something
    let category = null;
    const catMatch = content.match(/^\[(\w+)\]\s*([\s\S]*)/);
    if (catMatch) {
      category = catMatch[1];
      content = catMatch[2];
    }

    // Auto-classify if no manual category
    if (!category) {
      category = await autoClassify(env, content);
    }

    const { meta } = await env.DB
      .prepare(`INSERT INTO memories (content, category) VALUES (?, ?)`)
      .bind(content, category)
      .run();

    await sendTelegram(env, message.chat.id, `จำแล้วค่ะนาย (ID: #${meta.last_row_id}, หมวด: ${category})`, message.message_id);
  } catch (err) {
    console.error("handleRememberCommand error:", err);
    try {
      await sendTelegram(env, message.chat.id,
        `⚠️ บันทึกความจำไม่สำเร็จค่ะ: ${err.message || 'เกิดข้อผิดพลาด'}`,
        message.message_id);
    } catch (_) { /* swallow */ }
  }
}

export async function handleMemoriesCommand(env, message) {
  try {
    const isDM = message.chat.type === "private";

    // In DM → show interactive dashboard
    if (isDM) {
      await showDashboard(env, message.chat.id, message.message_id, false);
      return;
    }

    // In group → legacy text dump
    const { results } = await env.DB
      .prepare(`SELECT id, content, category, priority, datetime(created_at, '+7 hours') as created_at FROM memories ORDER BY CASE priority WHEN 'hot' THEN 1 WHEN 'warm' THEN 2 WHEN 'cold' THEN 3 ELSE 4 END, created_at DESC LIMIT 30`)
      .all();

    if (results.length === 0) {
      await sendTelegram(env, message.chat.id, "ยังไม่มีความจำที่บันทึกไว้ค่ะนาย", message.message_id);
      return;
    }

    let reply = `ความจำถาวรของ ${env.BOT_NAME || "Friday"}:\n\n`;
    for (const m of results) {
      const emoji = TIER_EMOJI[m.priority] || "⚪";
      reply += `#${m.id} ${emoji} ${m.priority} [${m.category}]\n${m.content}\nเมื่อ: ${m.created_at}\n\n`;
    }
    reply += "🔴 hot = ใช้ทุกครั้ง | 🟡 warm = ดึงเมื่อเกี่ยวข้อง | 🔵 cold = เก็บถาวร\n";
    reply += "/cooldown <id> ลดระดับ | /heatup <id> เพิ่มระดับ | /forget <id ...> ลบ";

    await sendTelegram(env, message.chat.id, reply, message.message_id);
  } catch (err) {
    console.error("handleMemoriesCommand error:", err);
    try {
      await sendTelegram(env, message.chat.id,
        `⚠️ โหลดความจำไม่สำเร็จค่ะ: ${err.message || 'เกิดข้อผิดพลาด'}`,
        message.message_id);
    } catch (_) { /* swallow */ }
  }
}

export async function handleCooldownCommand(env, message, args) {
  try {
    const id = args.trim();
    if (!id || isNaN(id)) {
      await sendTelegram(env, message.chat.id, "Usage: /cooldown <id> — ลด memory จาก hot → warm", message.message_id);
      return;
    }
    const { meta } = await env.DB
      .prepare(`UPDATE memories SET priority = 'warm' WHERE id = ?`)
      .bind(Number(id))
      .run();
    if (meta.changes > 0) {
      await sendTelegram(env, message.chat.id, `ปรับ memory #${id} เป็น warm แล้วค่ะนาย`, message.message_id);
    } else {
      await sendTelegram(env, message.chat.id, `ไม่พบ memory #${id} ค่ะนาย`, message.message_id);
    }
  } catch (err) {
    console.error("handleCooldownCommand error:", err);
    try {
      await sendTelegram(env, message.chat.id,
        `⚠️ ปรับ priority ไม่สำเร็จค่ะ: ${err.message || 'เกิดข้อผิดพลาด'}`,
        message.message_id);
    } catch (_) { /* swallow */ }
  }
}

export async function handleHeatupCommand(env, message, args) {
  try {
    const id = args.trim();
    if (!id || isNaN(id)) {
      await sendTelegram(env, message.chat.id, "Usage: /heatup <id> — ปรับ memory เป็น hot", message.message_id);
      return;
    }
    const { meta } = await env.DB
      .prepare(`UPDATE memories SET priority = 'hot' WHERE id = ?`)
      .bind(Number(id))
      .run();
    if (meta.changes > 0) {
      await sendTelegram(env, message.chat.id, `ปรับ memory #${id} เป็น hot แล้วค่ะนาย`, message.message_id);
    } else {
      await sendTelegram(env, message.chat.id, `ไม่พบ memory #${id} ค่ะนาย`, message.message_id);
    }
  } catch (err) {
    console.error("handleHeatupCommand error:", err);
    try {
      await sendTelegram(env, message.chat.id,
        `⚠️ ปรับ priority ไม่สำเร็จค่ะ: ${err.message || 'เกิดข้อผิดพลาด'}`,
        message.message_id);
    } catch (_) { /* swallow */ }
  }
}

export async function handleForgetCommand(env, message, args) {
  try {
    const ids = args.trim().split(/[\s,]+/).filter(s => s && !isNaN(s)).map(Number);
    if (ids.length === 0) {
      await sendTelegram(env, message.chat.id, "Usage: /forget <id> [id2 id3 ...]", message.message_id);
      return;
    }
    const placeholders = ids.map(() => "?").join(",");
    await env.DB
      .prepare(`DELETE FROM memories WHERE id IN (${placeholders})`)
      .bind(...ids)
      .run();
    const label = ids.map(id => `#${id}`).join(" ");
    await sendTelegram(env, message.chat.id, `ลบความจำ ${label} แล้วค่ะนาย`, message.message_id);
  } catch (err) {
    console.error("handleForgetCommand error:", err);
    try {
      await sendTelegram(env, message.chat.id,
        `⚠️ ลบความจำไม่สำเร็จค่ะ: ${err.message || 'เกิดข้อผิดพลาด'}`,
        message.message_id);
    } catch (_) { /* swallow */ }
  }
}
