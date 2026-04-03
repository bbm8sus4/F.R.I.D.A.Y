// Utility tools — fetch_url, text_to_speech

import { fetchUrlContent } from '../../handlers/read.js';
import { textToSpeech, sendVoice } from '../../lib/telegram.js';

export const definitions = [
  {
    name: 'fetch_url',
    description: 'ดึงเนื้อหาจาก URL เว็บไซต์เพื่อให้ AI อ่านและวิเคราะห์ ใช้เมื่อผู้ใช้ส่ง URL มาพร้อมคำถาม หรือขอให้สรุป/วิเคราะห์ลิงก์',
    parameters: {
      type: 'OBJECT',
      properties: {
        url: { type: 'STRING', description: 'URL ที่ต้องการดึงเนื้อหา (ต้องขึ้นต้นด้วย http:// หรือ https://)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'text_to_speech',
    description: 'แปลงข้อความเป็นเสียงพูด (TTS) แล้วส่งเป็น voice message ใช้เมื่อผู้ใช้ขอให้อ่านออกเสียง/แปลงเป็นเสียง',
    parameters: {
      type: 'OBJECT',
      properties: {
        text: { type: 'STRING', description: 'ข้อความที่ต้องการแปลงเป็นเสียง (สูงสุด 5000 ตัวอักษร)' },
      },
      required: ['text'],
    },
  },
];

export const executors = {
  async fetch_url(_env, args) {
    const { url } = args;
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return { error: 'URL ไม่ถูกต้อง ต้องขึ้นต้นด้วย http:// หรือ https://' };
    }
    const result = await fetchUrlContent(url);
    if (result.error) {
      return { error: result.error };
    }
    return {
      title: result.title || null,
      description: result.description || null,
      body_text: result.bodyText || '',
      url: result.url,
    };
  },

  async text_to_speech(env, args, { chatId }) {
    const { text } = args;
    if (!text) {
      return { error: 'ไม่มีข้อความที่จะแปลงเป็นเสียง' };
    }
    const audio = await textToSpeech(env, text);
    if (!audio) {
      return { error: 'ไม่สามารถแปลงเป็นเสียงได้ กรุณาตรวจสอบว่าเปิด Cloud TTS API แล้ว' };
    }
    await sendVoice(env, chatId, audio, null);
    return { success: true, message: 'ส่งข้อความเสียงแล้ว' };
  },
};
