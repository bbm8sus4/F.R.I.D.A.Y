import { sendTelegram } from '../lib/telegram.js';

export async function handleApicostCommand(env, message) {
  const row = await env.DB.prepare(
    `SELECT value, updated_at FROM kv_store WHERE key = 'apicost_report' LIMIT 1`
  ).first();

  if (!row) {
    await sendTelegram(env, message.chat.id,
      '⚠️ ยังไม่มีข้อมูล cost — ให้พิมพ์ /apicost ใน Claude Code เพื่อ scrape ข้อมูลจาก platform ก่อนค่ะ',
      message.message_id
    );
    return;
  }

  const age = Math.round((Date.now() - new Date(row.updated_at + 'Z').getTime()) / 60000);
  const staleNote = age > 60 ? `\n\n⏳ <i>ข้อมูลเก่า ${age} นาที — scrape ใหม่ได้ที่ Claude Code</i>` : '';

  await sendTelegram(env, message.chat.id,
    row.value + staleNote,
    message.message_id, true
  );
}
