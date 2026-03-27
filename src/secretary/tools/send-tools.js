// Send tools — wraps existing sendTelegram (boss only)

import { sendTelegram } from '../../lib/telegram.js';

export const definitions = [
  {
    name: 'send_message',
    description: 'ส่งข้อความไปกลุ่ม Telegram (ใช้ได้เฉพาะบอส) — ต้องระบุ chat_id ของกลุ่ม',
    parameters: {
      type: 'OBJECT',
      properties: {
        chat_id: { type: 'STRING', description: 'chat_id ของกลุ่มเป้าหมาย' },
        message: { type: 'STRING', description: 'ข้อความที่จะส่ง' },
      },
      required: ['chat_id', 'message'],
    },
  },
  {
    name: 'schedule_reminder',
    description: 'ตั้งเวลาเตือน task ในอนาคต (เก็บใน DB สำหรับ cron)',
    parameters: {
      type: 'OBJECT',
      properties: {
        task_id: { type: 'INTEGER', description: 'ID ของ task ที่ต้องการเตือน' },
        remind_at: { type: 'STRING', description: 'วันเวลาที่ต้องการเตือน YYYY-MM-DD HH:MM' },
      },
      required: ['task_id', 'remind_at'],
    },
  },
];

export const executors = {
  async send_message(env, args) {
    const { chat_id, message } = args;
    await sendTelegram(env, chat_id, message, null, true);
    return { success: true, chat_id, message_preview: message.substring(0, 100) };
  },

  async schedule_reminder(env, args) {
    const { task_id, remind_at } = args;
    const task = await env.DB.prepare(
      `SELECT id, title, description FROM tasks WHERE id = ?`
    ).bind(task_id).first();
    if (!task) return { error: `ไม่พบ Task #${task_id}` };

    // Store as a comment with source='reminder'
    await env.DB.prepare(
      `INSERT INTO task_comments (task_id, content, source) VALUES (?, ?, 'reminder')`
    ).bind(task_id, `Reminder scheduled for ${remind_at}`).run();

    return { success: true, task_id, remind_at };
  },
};
