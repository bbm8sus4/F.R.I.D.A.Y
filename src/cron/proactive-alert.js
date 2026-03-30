import { sendTelegram, sendTelegramWithKeyboard } from '../lib/telegram.js';
import { escapeHtml, truncateDesc } from '../lib/html-utils.js';

export async function proactiveAlert(env) {
  try {
    const bossId = env.BOSS_USER_ID;

    // Group 1: overdue (due_on < today)
    const { results: overdue } = await env.DB
      .prepare(
        `SELECT id, description, due_on, datetime(created_at, '+7 hours') as created_at
         FROM tasks
         WHERE status = 'pending' AND due_on IS NOT NULL AND due_on < date('now', '+7 hours')
         ORDER BY due_on ASC LIMIT 10`
      )
      .all();

    // Group 2: stale (no due_on, created > 48h ago)
    const { results: stale } = await env.DB
      .prepare(
        `SELECT id, description, datetime(created_at, '+7 hours') as created_at
         FROM tasks
         WHERE status = 'pending' AND due_on IS NULL AND created_at < datetime('now', '-48 hours')
         ORDER BY created_at ASC LIMIT 5`
      )
      .all();

    if (overdue.length === 0 && stale.length === 0) return;

    let alert = "⏰ <b>Tasks ที่ต้องจัดการ</b>\n\n";
    const buttons = [];

    if (overdue.length > 0) {
      alert += "<b>🔴 เกินกำหนด:</b>\n";
      for (const t of overdue) {
        alert += `⚠️ <b>#${t.id}</b> ${escapeHtml(truncateDesc(t.description))} (กำหนด ${t.due_on})\n`;
        buttons.push([
          { text: `✅ Done #${t.id}`, callback_data: `tk:d:${t.id}` },
          { text: `❌ Cancel #${t.id}`, callback_data: `tk:x:${t.id}` },
        ]);
      }
      alert += "\n";
    }

    if (stale.length > 0) {
      alert += "<b>⏳ ค้างนานเกิน 48 ชม.:</b>\n";
      for (const t of stale) {
        alert += `⏳ <b>#${t.id}</b> ${escapeHtml(truncateDesc(t.description))} (สร้างเมื่อ ${t.created_at})\n`;
        buttons.push([
          { text: `✅ Done #${t.id}`, callback_data: `tk:d:${t.id}` },
          { text: `❌ Cancel #${t.id}`, callback_data: `tk:x:${t.id}` },
        ]);
      }
    }

    await sendTelegramWithKeyboard(env, bossId, alert, null, buttons);
  } catch (err) {
    console.error("Proactive alert error:", err);
  }
}
