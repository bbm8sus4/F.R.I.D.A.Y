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
    name: 'schedule_message',
    description: 'ตั้งเวลาส่งข้อความไปกลุ่ม Telegram ในอนาคต — boss สั่ง "ส่งพรุ่งนี้ 9 โมง" ได้ ต้องระบุ chat_id, ข้อความ, และเวลาส่ง',
    parameters: {
      type: 'OBJECT',
      properties: {
        chat_id: { type: 'STRING', description: 'chat_id ของกลุ่มเป้าหมาย' },
        message: { type: 'STRING', description: 'ข้อความที่จะส่ง' },
        send_at: { type: 'STRING', description: 'วันเวลาที่ต้องการส่ง (Bangkok time) รูปแบบ YYYY-MM-DD HH:MM' },
      },
      required: ['chat_id', 'message', 'send_at'],
    },
  },
];

export const executors = {
  async send_message(env, args) {
    const { chat_id, message } = args;
    await sendTelegram(env, chat_id, message, null, true);
    return { success: true, chat_id, message_preview: message.substring(0, 100) };
  },

  async schedule_message(env, args, context) {
    const { chat_id, message, send_at } = args;
    if (!send_at?.match(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/)) {
      return { error: 'รูปแบบเวลาไม่ถูกต้อง ต้องเป็น YYYY-MM-DD HH:MM' };
    }
    // Validate send_at is in the future (Bangkok time)
    const sendTime = new Date(send_at.replace(' ', 'T') + ':00+07:00');
    if (isNaN(sendTime.getTime()) || sendTime.getTime() <= Date.now()) {
      return { error: 'เวลาที่กำหนดต้องเป็นอนาคตค่ะ' };
    }

    const userId = context?.userId || null;
    await env.DB.prepare(
      `INSERT INTO scheduled_messages (target_chat_id, message_text, send_at, created_by)
       VALUES (?, ?, ?, ?)`
    ).bind(chat_id, message, send_at, userId).run();

    return { success: true, chat_id, send_at, message_preview: message.substring(0, 80) };
  },
};
