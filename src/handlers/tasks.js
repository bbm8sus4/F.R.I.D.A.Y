import { sendTelegram, sendTelegramWithKeyboard } from '../lib/telegram.js';
import { escapeHtml, sanitizeHtml, truncateDesc } from '../lib/html-utils.js';

export async function handleDashboardCommand(env, message) {
  const dashUrl = env.DASHBOARD_URL;
  if (!dashUrl) {
    await sendTelegram(env, message.chat.id, "ยังไม่ได้ตั้งค่า Dashboard ค่ะ", message.message_id);
    return;
  }
  const botName = env.BOT_NAME || "Friday";
  const workerUrl = env.WORKER_URL || "";
  const url = workerUrl ? `${dashUrl}?api=${encodeURIComponent(workerUrl)}` : dashUrl;
  await sendTelegramWithKeyboard(env, message.chat.id, `📊 ${botName} Dashboard`, null, [
    [{ text: "Open Dashboard", web_app: { url } }],
  ]);
}

// ===== Task System — สั่ง → ทำ → จบ → ลบ =====

export async function handleTaskCommand(env, message, args) {
  try {
    const description = args.trim();
    if (!description) {
      await sendTelegram(env, message.chat.id, "Usage: /task <รายละเอียดงาน>\nตัวอย่าง: /task เตรียม slide ประชุม", message.message_id);
      return;
    }
    const { meta } = await env.DB
      .prepare(`INSERT INTO tasks (description) VALUES (?)`)
      .bind(description)
      .run();
    const id = meta.last_row_id;
    const confirmText = `📌 สร้าง Task #${id} แล้วค่ะ\n"${escapeHtml(description)}"`;
    if (message.chat.type === "private") {
      await sendTelegramWithKeyboard(env, message.chat.id, confirmText, message.message_id,
        [[
          { text: `✅ Done #${id}`, callback_data: `tk:d:${id}` },
          { text: `❌ Cancel #${id}`, callback_data: `tk:x:${id}` },
        ]]
      );
    } else {
      await sendTelegram(env, message.chat.id, confirmText, message.message_id, true);
    }
  } catch (err) {
    console.error("handleTaskCommand error:", err);
    try {
      await sendTelegram(env, message.chat.id,
        `⚠️ สร้าง Task ไม่สำเร็จค่ะ: ${err.message || 'เกิดข้อผิดพลาด'}`,
        message.message_id);
    } catch (_) { /* swallow secondary send failure */ }
  }
}

export async function buildTasksDisplay(env) {
  const { results } = await env.DB
    .prepare(
      `SELECT id, description, status, result, due_on,
              datetime(created_at, '+7 hours') as created_at,
              datetime(completed_at, '+7 hours') as completed_at
       FROM tasks
       WHERE status = 'pending'
          OR (status IN ('done','cancelled') AND completed_at > datetime('now', '-48 hours'))
       ORDER BY
         CASE status WHEN 'pending' THEN 0 ELSE 1 END,
         CASE WHEN status='pending' AND due_on IS NOT NULL AND due_on < date('now', '+7 hours') THEN 0
              WHEN status='pending' AND due_on IS NOT NULL THEN 1
              ELSE 2 END,
         due_on ASC, created_at ASC
       LIMIT 25`
    )
    .all();

  if (results.length === 0) {
    return { text: "ไม่มี task ค้างอยู่เลยค่ะนาย 🎉", buttons: [] };
  }

  const todayStr = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const overdue = results.filter(t => t.status === "pending" && t.due_on && t.due_on < todayStr);
  const pending = results.filter(t => t.status === "pending" && !(t.due_on && t.due_on < todayStr));
  const done = results.filter(t => t.status !== "pending");

  let text = "<b>📝 Tasks</b>\n\n";
  const buttons = [];

  if (overdue.length > 0) {
    text += "<b>🔴 เกินกำหนด:</b>\n";
    for (const t of overdue) {
      const daysOver = Math.floor((new Date(todayStr) - new Date(t.due_on)) / 86400000);
      text += `  ⚠️ <b>#${t.id}</b> ${escapeHtml(truncateDesc(t.description))}\n`;
      text += `     📅 กำหนด: ${t.due_on} (เลย ${daysOver} วัน)\n`;
      buttons.push([
        { text: `✅ Done #${t.id}`, callback_data: `tk:d:${t.id}` },
        { text: `❌ Cancel #${t.id}`, callback_data: `tk:x:${t.id}` },
        { text: `🗑 #${t.id}`, callback_data: `tk:del:${t.id}` },
      ]);
    }
    text += "\n";
  }

  if (pending.length > 0) {
    text += "<b>⏳ รอดำเนินการ:</b>\n";
    for (const t of pending) {
      text += `  ⏳ <b>#${t.id}</b> ${escapeHtml(truncateDesc(t.description))}\n`;
      if (t.due_on) text += `     📅 กำหนด: ${t.due_on}\n`;
      buttons.push([
        { text: `✅ Done #${t.id}`, callback_data: `tk:d:${t.id}` },
        { text: `❌ Cancel #${t.id}`, callback_data: `tk:x:${t.id}` },
        { text: `🗑 #${t.id}`, callback_data: `tk:del:${t.id}` },
      ]);
    }
    text += "\n";
  }

  if (done.length > 0) {
    text += "<b>✅ เสร็จล่าสุด:</b>\n";
    for (const t of done) {
      const icon = t.status === "done" ? "✅" : "❌";
      text += `  ${icon} <b>#${t.id}</b> ${escapeHtml(truncateDesc(t.description))}`;
      if (t.result) text += ` — "${escapeHtml(truncateDesc(t.result))}"`;
      text += "\n";
      if (t.completed_at) text += `     <i>${t.status === "done" ? "เสร็จ" : "ยกเลิก"}: ${t.completed_at}</i>\n`;
      buttons.push([{ text: `🗑 ลบ #${t.id}`, callback_data: `tk:del:${t.id}` }]);
    }
    text += "\n";
  }

  buttons.push([{ text: "📋 ดูประวัติทั้งหมด", callback_data: "tk:h:0" }]);

  return { text, buttons };
}

export async function handleTasksCommand(env, message) {
  try {
    const { text, buttons } = await buildTasksDisplay(env);
    const isDM = message.chat.type === "private";
    if (isDM && buttons.length > 0) {
      await sendTelegramWithKeyboard(env, message.chat.id, text, message.message_id, buttons);
    } else {
      await sendTelegram(env, message.chat.id, text, message.message_id, true);
    }
  } catch (err) {
    console.error("handleTasksCommand error:", err);
    try {
      await sendTelegram(env, message.chat.id,
        `⚠️ โหลดรายการ Tasks ไม่สำเร็จค่ะ: ${err.message || 'เกิดข้อผิดพลาด'}`,
        message.message_id);
    } catch (_) { /* swallow secondary send failure */ }
  }
}

export async function handleDoneCommand(env, message, args) {
  try {
    const match = args.trim().match(/^(\d+)\s*([\s\S]*)/);
    if (!match) {
      await sendTelegram(env, message.chat.id, "Usage: /done <id> [ผลลัพธ์]\nตัวอย่าง: /done 1 ส่ง email ไปแล้ว", message.message_id);
      return;
    }
    const taskId = Number(match[1]);
    const result = match[2].trim() || null;
    const task = await env.DB
      .prepare(`SELECT id, description FROM tasks WHERE id = ? AND status = 'pending'`)
      .bind(taskId)
      .first();
    if (!task) {
      await sendTelegram(env, message.chat.id, `ไม่พบ Task #${taskId} ที่ยังค้างอยู่ค่ะ`, message.message_id);
      return;
    }
    await env.DB
      .prepare(`UPDATE tasks SET status='done', result=?, completed_at=datetime('now') WHERE id=?`)
      .bind(result, taskId)
      .run();
    let msg = `✅ Task #${taskId} เสร็จแล้วค่ะ — "${task.description}"`;
    if (result) msg += `\n↳ ${result}`;
    await sendTelegram(env, message.chat.id, msg, message.message_id);
  } catch (err) {
    console.error("handleDoneCommand error:", err);
    try {
      await sendTelegram(env, message.chat.id,
        `⚠️ ปิด Task ไม่สำเร็จค่ะ: ${err.message || 'เกิดข้อผิดพลาด'}`,
        message.message_id);
    } catch (_) { /* swallow secondary send failure */ }
  }
}

export async function handleCancelCommand(env, message, args) {
  try {
    const taskId = Number(args.trim());
    if (!taskId) {
      await sendTelegram(env, message.chat.id, "Usage: /cancel <id>", message.message_id);
      return;
    }
    const task = await env.DB
      .prepare(`SELECT id, description FROM tasks WHERE id = ? AND status = 'pending'`)
      .bind(taskId)
      .first();
    if (!task) {
      await sendTelegram(env, message.chat.id, `ไม่พบ Task #${taskId} ที่ยังค้างอยู่ค่ะ`, message.message_id);
      return;
    }
    await env.DB
      .prepare(`UPDATE tasks SET status='cancelled', completed_at=datetime('now') WHERE id=?`)
      .bind(taskId)
      .run();
    await sendTelegram(env, message.chat.id, `❌ ยกเลิก Task #${taskId} แล้วค่ะ — "${task.description}"`, message.message_id);
  } catch (err) {
    console.error("handleCancelCommand error:", err);
    try {
      await sendTelegram(env, message.chat.id,
        `⚠️ ยกเลิก Task ไม่สำเร็จค่ะ: ${err.message || 'เกิดข้อผิดพลาด'}`,
        message.message_id);
    } catch (_) { /* swallow secondary send failure */ }
  }
}

// Mutating actions need boss-only gating until the schema gains real per-user
// ownership wiring (0020_extend_tasks.sql added created_by_id/assignee_id but
// writes don't populate them — see security_audit_2026-04-29.md).
const MUTATING_TASK_ACTIONS = new Set(["d", "x", "u", "del"]);

export async function handleTaskCallback(env, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const parts = callbackQuery.data.split(":");
  const action = parts[1]; // "d" (done), "x" (cancel), "h" (history), "b" (back), "u" (undo), "del" (delete)

  // Boss-only on mutating actions — without this any allowed member could press
  // tk:del:<id> and wipe the boss's tasks (same shape as the del: callback IDOR).
  if (MUTATING_TASK_ACTIONS.has(action) && callbackQuery.from.id !== Number(env.BOSS_USER_ID)) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQuery.id,
        text: "ฟังก์ชันนี้สำหรับผู้ดูแลระบบเท่านั้นค่ะ",
        show_alert: true,
      }),
    }).catch(e => console.error("tk non-boss answer error:", e.message));
    return;
  }

  // Answer callback immediately
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQuery.id }),
  }).catch(e => console.error("tk answerCallbackQuery error:", e.message));

  try {
    // History view
    if (action === "h") {
      const offset = Number(parts[2]) || 0;
      const { results } = await env.DB.prepare(
        `SELECT id, description, status, result, due_on,
                datetime(completed_at, '+7 hours') as completed_at
         FROM tasks WHERE status IN ('done','cancelled')
         ORDER BY completed_at DESC LIMIT 10 OFFSET ?`
      ).bind(offset).all();

      const total = (await env.DB.prepare(
        `SELECT COUNT(*) as c FROM tasks WHERE status IN ('done','cancelled')`
      ).first()).c;

      if (results.length === 0) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: "📋 ยังไม่มีประวัติ Tasks ค่ะ",
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "🔙 กลับ Tasks", callback_data: "tk:b" }]] },
          }),
        });
        return;
      }

      let text = "<b>📋 ประวัติ Tasks</b>\n\n";
      const buttons = [];
      for (const t of results) {
        const icon = t.status === "done" ? "✅" : "❌";
        text += `${icon} <b>#${t.id}</b> ${escapeHtml(truncateDesc(t.description))}\n`;
        if (t.result) text += `   ↳ ${escapeHtml(truncateDesc(t.result))}\n`;
        if (t.due_on) text += `   📅 กำหนด: ${t.due_on}\n`;
        text += `   <i>${t.status === "done" ? "เสร็จ" : "ยกเลิก"}: ${t.completed_at}</i>\n\n`;
        buttons.push([
          { text: `↩️ Undo #${t.id}`, callback_data: `tk:u:${t.id}` },
          { text: `🗑 ลบ #${t.id}`, callback_data: `tk:del:${t.id}` },
        ]);
      }
      text += `แสดง ${offset + 1}-${offset + results.length} จาก ${total} รายการ`;

      const navButtons = [];
      if (offset > 0) navButtons.push({ text: "◀️ ก่อนหน้า", callback_data: `tk:h:${offset - 10}` });
      if (offset + 10 < total) navButtons.push({ text: "▶️ ถัดไป", callback_data: `tk:h:${offset + 10}` });

      if (navButtons.length) buttons.push(navButtons);
      buttons.push([{ text: "🔙 กลับ Tasks", callback_data: "tk:b" }]);

      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: sanitizeHtml(text),
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: buttons },
        }),
      });
      return;
    }

    // Back to tasks view
    if (action === "b") {
      const { text, buttons } = await buildTasksDisplay(env);
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: sanitizeHtml(text),
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: buttons },
        }),
      });
      return;
    }

    // Undo — revert task back to pending
    if (action === "u") {
      const undoId = Number(parts[2]);
      const task = await env.DB
        .prepare(`SELECT id, description, status FROM tasks WHERE id = ? AND status IN ('done','cancelled')`)
        .bind(undoId)
        .first();

      if (!task) {
        await sendTelegram(env, chatId, `Task #${undoId} ไม่พบ หรือกลับไม่ได้แล้วค่ะ`, null);
        return;
      }

      await env.DB
        .prepare(`UPDATE tasks SET status='pending', completed_at=NULL, result=NULL WHERE id=?`)
        .bind(undoId)
        .run();

      // Go back to tasks view showing the restored task
      const { text, buttons } = await buildTasksDisplay(env);
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: sanitizeHtml(`↩️ Task #${undoId} กลับมาเป็นรอดำเนินการแล้วค่ะ — "${escapeHtml(truncateDesc(task.description))}"\n\n` + text),
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: buttons },
        }),
      });
      return;
    }

    // Delete — permanently remove task from DB
    if (action === "del") {
      const delId = Number(parts[2]);
      const task = await env.DB
        .prepare(`SELECT id, description FROM tasks WHERE id = ?`)
        .bind(delId)
        .first();

      if (!task) {
        await sendTelegram(env, chatId, `Task #${delId} ไม่พบแล้วค่ะ`, null);
        return;
      }

      await env.DB.prepare(`DELETE FROM tasks WHERE id = ?`).bind(delId).run();

      // Refresh: if we came from history view, re-render history; otherwise show tasks
      const { results: histCheck } = await env.DB.prepare(
        `SELECT COUNT(*) as c FROM tasks WHERE status IN ('done','cancelled')`
      ).all();
      const total = histCheck[0].c;

      if (total > 0) {
        // Re-render history at offset 0
        const { results } = await env.DB.prepare(
          `SELECT id, description, status, result, due_on,
                  datetime(completed_at, '+7 hours') as completed_at
           FROM tasks WHERE status IN ('done','cancelled')
           ORDER BY completed_at DESC LIMIT 10`
        ).all();

        let text = `🗑 ลบ Task #${delId} แล้วค่ะ — "${escapeHtml(truncateDesc(task.description))}"\n\n`;
        text += "<b>📋 ประวัติ Tasks</b>\n\n";
        const buttons = [];
        for (const t of results) {
          const icon = t.status === "done" ? "✅" : "❌";
          text += `${icon} <b>#${t.id}</b> ${escapeHtml(truncateDesc(t.description))}\n`;
          if (t.result) text += `   ↳ ${escapeHtml(truncateDesc(t.result))}\n`;
          if (t.due_on) text += `   📅 กำหนด: ${t.due_on}\n`;
          text += `   <i>${t.status === "done" ? "เสร็จ" : "ยกเลิก"}: ${t.completed_at}</i>\n\n`;
          buttons.push([
            { text: `↩️ Undo #${t.id}`, callback_data: `tk:u:${t.id}` },
            { text: `🗑 ลบ #${t.id}`, callback_data: `tk:del:${t.id}` },
          ]);
        }
        text += `แสดง 1-${results.length} จาก ${total} รายการ`;

        const navButtons = [];
        if (total > 10) navButtons.push({ text: "▶️ ถัดไป", callback_data: "tk:h:10" });
        if (navButtons.length) buttons.push(navButtons);
        buttons.push([{ text: "🔙 กลับ Tasks", callback_data: "tk:b" }]);

        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: sanitizeHtml(text),
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buttons },
          }),
        });
      } else {
        // No more history, go back to tasks view
        const { text, buttons } = await buildTasksDisplay(env);
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: sanitizeHtml(`🗑 ลบ Task #${delId} แล้วค่ะ — "${escapeHtml(truncateDesc(task.description))}"\n\n` + text),
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buttons },
          }),
        });
      }
      return;
    }

    // Done / Cancel actions
    const taskId = Number(parts[2]);
    const task = await env.DB
      .prepare(`SELECT id, description FROM tasks WHERE id = ? AND status = 'pending'`)
      .bind(taskId)
      .first();

    if (!task) {
      await sendTelegram(env, chatId, `Task #${taskId} ไม่พบ หรือจัดการไปแล้วค่ะ`, null);
      return;
    }

    let confirmMsg;
    if (action === "d") {
      await env.DB
        .prepare(`UPDATE tasks SET status='done', completed_at=datetime('now') WHERE id=?`)
        .bind(taskId)
        .run();
      confirmMsg = `✅ Task #${taskId} เสร็จแล้วค่ะ — "${escapeHtml(truncateDesc(task.description))}"`;
    } else if (action === "x") {
      await env.DB
        .prepare(`UPDATE tasks SET status='cancelled', completed_at=datetime('now') WHERE id=?`)
        .bind(taskId)
        .run();
      confirmMsg = `❌ ยกเลิก Task #${taskId} แล้วค่ะ — "${escapeHtml(truncateDesc(task.description))}"`;
    }

    // Replace original buttons with undo button
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      }),
    });

    // Send confirmation with undo button
    if (confirmMsg) {
      await sendTelegramWithKeyboard(env, chatId, confirmMsg, null,
        [[{ text: `↩️ Undo #${taskId}`, callback_data: `tk:u:${taskId}` }]]
      );
    }
  } catch (err) {
    console.error("handleTaskCallback error:", err);
    try {
      await sendTelegram(env, chatId,
        `⚠️ ดำเนินการไม่สำเร็จค่ะ: ${err.message || 'เกิดข้อผิดพลาด'}`, null);
    } catch (_) { /* swallow secondary send failure */ }
  }
}
