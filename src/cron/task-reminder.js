// Task Reminder — notify boss about tasks due tomorrow (runs every 3h cron, dedup per day)

import { sendTelegramWithKeyboard } from '../lib/telegram.js';
import { escapeHtml, truncateDesc } from '../lib/html-utils.js';

export async function taskReminder(env) {
  try {
    // Calculate tomorrow in Bangkok time (UTC+7)
    const now = new Date(Date.now() + 7 * 3600000);
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    const todayStr = now.toISOString().slice(0, 10);

    // Dedup: only send once per day
    const alreadySent = await env.DB.prepare(
      `SELECT id FROM ai_log WHERE feature = 'task_reminder'
       AND success = 1 AND created_at > datetime('now', '-20 hours')
       LIMIT 1`
    ).first();
    if (alreadySent) return;

    // Find tasks due tomorrow
    const { results: dueTomorrow } = await env.DB.prepare(
      `SELECT id, title, description, assignee_name, priority, due_on
       FROM tasks
       WHERE status NOT IN ('done', 'cancelled')
         AND due_on = ?
       ORDER BY priority DESC
       LIMIT 15`
    ).bind(tomorrowStr).all();

    if (dueTomorrow.length === 0) return;

    // Build message
    let msg = `🔔 <b>แจ้งเตือน: ${dueTomorrow.length} งานครบกำหนดพรุ่งนี้</b> (${tomorrowStr})\n\n`;

    const buttons = [];
    for (const t of dueTomorrow) {
      const name = escapeHtml(t.title || truncateDesc(t.description));
      const assignee = t.assignee_name ? ` [${escapeHtml(t.assignee_name)}]` : '';
      const priority = t.priority ? ` ⚡${t.priority}` : '';
      msg += `📌 <b>#${t.id}</b> ${name}${assignee}${priority}\n`;
      buttons.push([
        { text: `✅ Done #${t.id}`, callback_data: `tk:d:${t.id}` },
        { text: `❌ Cancel #${t.id}`, callback_data: `tk:x:${t.id}` },
      ]);
    }

    const bossId = Number(env.BOSS_USER_ID);
    await sendTelegramWithKeyboard(env, bossId, msg, null, buttons);

    // Log for dedup
    await env.DB.prepare(
      `INSERT INTO ai_log (feature, model, input_tokens, output_tokens, duration_ms, success)
       VALUES ('task_reminder', 'none', 0, 0, 0, 1)`
    ).run();
  } catch (e) {
    console.error('taskReminder error:', e.message);
  }
}
