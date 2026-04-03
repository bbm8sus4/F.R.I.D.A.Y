// Scheduled Messages — send pending messages that are due (runs every 3h cron)

import { sendTelegram } from '../lib/telegram.js';

export async function sendScheduledMessages(env) {
  try {
    // Find messages due for sending (send_at <= now, Bangkok time stored as UTC+7)
    const { results } = await env.DB.prepare(
      `SELECT id, target_chat_id, message_text
       FROM scheduled_messages
       WHERE status = 'pending' AND send_at <= datetime('now', '+7 hours')
       ORDER BY send_at ASC
       LIMIT 20`
    ).all();

    if (results.length === 0) return;

    const bossId = Number(env.BOSS_USER_ID);
    let sentCount = 0;

    for (const msg of results) {
      try {
        await sendTelegram(env, msg.target_chat_id, msg.message_text, null);
        await env.DB.prepare(
          `UPDATE scheduled_messages SET status = 'sent', sent_at = datetime('now') WHERE id = ?`
        ).bind(msg.id).run();
        sentCount++;
      } catch (e) {
        console.error(`Scheduled message #${msg.id} failed:`, e.message);
        await env.DB.prepare(
          `UPDATE scheduled_messages SET status = 'failed' WHERE id = ?`
        ).bind(msg.id).run();
        await sendTelegram(env, bossId,
          `❌ ส่งข้อความตั้งเวลา #${msg.id} ไม่สำเร็จ: ${e.message}`, null);
      }
    }

    if (sentCount > 0) {
      await sendTelegram(env, bossId,
        `📤 ส่งข้อความตั้งเวลาแล้ว ${sentCount} รายการค่ะ`, null);
    }
  } catch (e) {
    console.error('sendScheduledMessages error:', e.message);
  }
}
