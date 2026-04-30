import { sendTelegram, sendTelegramWithKeyboard } from '../lib/telegram.js';
import { escapeHtml, formatLocation } from '../lib/html-utils.js';
import { listEvents, createEvent, deleteEvent, isCalendarConfigured } from '../lib/google-calendar.js';

const THAI_DAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

/**
 * /cal command handler
 * /cal            → 7 วันข้างหน้า
 * /cal today      → วันนี้
 * /cal week       → สัปดาห์นี้
 * /cal add <text> → สร้างนัด (Gemini parse)
 * /cal del        → แสดงนัดพร้อมปุ่มลบ
 */
export async function handleCalendarCommand(env, message, args) {
  const chatId = message.chat.id;
  const msgId = message.message_id;

  if (!isCalendarConfigured(env)) {
    await sendTelegram(env, chatId, "ยังไม่ได้ตั้งค่า Google Calendar ค่ะ\nกรุณาเพิ่ม GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALENDAR_REFRESH_TOKEN", msgId);
    return;
  }

  const sub = args.trim().toLowerCase();

  try {
    if (sub.startsWith("add ") || sub.startsWith("เพิ่ม ")) {
      await handleCalAdd(env, message, args.replace(/^(add|เพิ่ม)\s+/i, "").trim());
      return;
    }

    if (sub === "del" || sub === "ลบ" || sub === "delete") {
      await handleCalDelete(env, message);
      return;
    }

    // List mode
    const now = new Date();
    const bangkokNow = new Date(now.getTime() + 7 * 3600000);
    let timeMin, timeMax, label;

    if (sub === "today" || sub === "วันนี้") {
      const todayStr = bangkokNow.toISOString().slice(0, 10);
      timeMin = `${todayStr}T00:00:00+07:00`;
      timeMax = `${todayStr}T23:59:59+07:00`;
      label = "วันนี้";
    } else if (sub === "week" || sub === "สัปดาห์" || sub === "สัปดาห์นี้") {
      const todayStr = bangkokNow.toISOString().slice(0, 10);
      const endOfWeek = new Date(bangkokNow);
      const dayOfWeek = endOfWeek.getUTCDay();
      endOfWeek.setUTCDate(endOfWeek.getUTCDate() + (7 - dayOfWeek));
      const endStr = endOfWeek.toISOString().slice(0, 10);
      timeMin = `${todayStr}T00:00:00+07:00`;
      timeMax = `${endStr}T23:59:59+07:00`;
      label = "สัปดาห์นี้";
    } else {
      // Default: 7 วันข้างหน้า
      const todayStr = bangkokNow.toISOString().slice(0, 10);
      const next7 = new Date(bangkokNow);
      next7.setUTCDate(next7.getUTCDate() + 7);
      const endStr = next7.toISOString().slice(0, 10);
      timeMin = `${todayStr}T00:00:00+07:00`;
      timeMax = `${endStr}T23:59:59+07:00`;
      label = "7 วันข้างหน้า";
    }

    const events = await listEvents(env, timeMin, timeMax, 25);

    if (events.length === 0) {
      await sendTelegram(env, chatId, `📅 ไม่มีนัดหมาย${label}ค่ะ`, msgId);
      return;
    }

    const text = formatEventList(events, label);
    await sendTelegram(env, chatId, text, msgId, true);
  } catch (err) {
    console.error("handleCalendarCommand error:", err);
    await sendTelegram(env, chatId, `❌ ไม่สามารถเข้าถึงปฏิทินได้ค่ะ: ${escapeHtml(err.message)}`, msgId);
  }
}

/**
 * /cal add — parse natural language then create event
 * Uses Gemini to parse Thai text → structured event data
 */
async function handleCalAdd(env, message, rawText) {
  const chatId = message.chat.id;
  const msgId = message.message_id;

  if (!rawText) {
    await sendTelegram(env, chatId, "Usage: /cal add ประชุม vendor พุธ 10:00\nหรือ: /cal add กินข้าวกับทีม 28/3 12:00", msgId);
    return;
  }

  // Use Gemini to parse natural Thai event text
  const todayBkk = new Date(Date.now() + 7 * 3600000);
  const todayStr = todayBkk.toISOString().slice(0, 10);
  const dayName = THAI_DAYS[todayBkk.getUTCDay()];

  const parsePrompt = `วันนี้คือ ${todayStr} (วัน${dayName})
แปลงข้อความนี้เป็น JSON สำหรับสร้างนัดหมายในปฏิทิน:
"${rawText}"

ตอบเฉพาะ JSON เท่านั้น ไม่ต้องอธิบาย:
{"title":"ชื่อนัด","date":"YYYY-MM-DD","time":"HH:MM","duration":60}

กฎ:
- ถ้าบอกวัน (จันทร์-อาทิตย์) ให้คำนวณวันที่ถัดไปที่ตรง (ถ้าเป็นวันนี้ก็วันนี้)
- ถ้าไม่ระบุเวลา ใช้ 09:00
- ถ้าไม่ระบุระยะเวลา ใช้ 60 นาที
- ถ้าบอก "1 ชม." = 60, "2 ชม." = 120, "30 นาที" = 30
- ตอบ JSON เท่านั้น ห้ามมี text อื่น`;

  try {
    const parseRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: parsePrompt }] }],
          generationConfig: { maxOutputTokens: 256, temperature: 0 },
        }),
      }
    );

    if (!parseRes.ok) throw new Error("Gemini parse failed");

    const parseData = await parseRes.json();
    const rawReply = parseData.candidates?.[0]?.content?.parts?.[0]?.text || "";
    // Extract JSON from reply (may have markdown code fences)
    const jsonMatch = rawReply.match(/\{[^}]+\}/);
    if (!jsonMatch) throw new Error("ไม่สามารถแปลงข้อความได้");

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.title || !parsed.date || !parsed.time) {
      throw new Error("ข้อมูลไม่ครบ");
    }

    const event = await createEvent(env, {
      title: parsed.title,
      date: parsed.date,
      time: parsed.time,
      duration: parsed.duration || 60,
    });

    const d = new Date(event.date + "T12:00:00Z");
    const dayThai = THAI_DAYS[d.getUTCDay()];
    const monthThai = THAI_MONTHS[d.getUTCMonth()];

    await sendTelegram(env, chatId,
      `✅ สร้างนัดหมายแล้วค่ะ\n\n📅 <b>${escapeHtml(event.title)}</b>\n📆 วัน${dayThai} ${d.getUTCDate()} ${monthThai} ${d.getUTCFullYear()}\n🕐 ${event.time}${event.endTime ? `-${event.endTime}` : ""}`,
      msgId, true
    );
  } catch (err) {
    console.error("handleCalAdd error:", err);
    await sendTelegram(env, chatId, `❌ สร้างนัดไม่สำเร็จค่ะ: ${escapeHtml(err.message)}`, msgId);
  }
}

/**
 * /cal del — show events with delete buttons
 */
async function handleCalDelete(env, message) {
  const chatId = message.chat.id;
  const msgId = message.message_id;

  const now = new Date();
  const bangkokNow = new Date(now.getTime() + 7 * 3600000);
  const todayStr = bangkokNow.toISOString().slice(0, 10);
  const next14 = new Date(bangkokNow);
  next14.setUTCDate(next14.getUTCDate() + 14);
  const endStr = next14.toISOString().slice(0, 10);

  const events = await listEvents(env, `${todayStr}T00:00:00+07:00`, `${endStr}T23:59:59+07:00`, 10);

  if (events.length === 0) {
    await sendTelegram(env, chatId, "📅 ไม่มีนัดหมายที่จะลบค่ะ", msgId);
    return;
  }

  const buttons = events.map(e => {
    const label = `🗑 ${e.time !== "ทั้งวัน" ? e.time + " " : ""}${e.title}`;
    // Truncate callback_data to 64 bytes max (Telegram limit)
    const cbData = `cl:del:${e.id}`.slice(0, 64);
    return [{ text: label.slice(0, 40), callback_data: cbData }];
  });

  await sendTelegramWithKeyboard(env, chatId, "📅 เลือกนัดที่ต้องการลบ:", msgId, buttons);
}

/**
 * Handle cl: callback queries (calendar callbacks)
 */
export async function handleCalendarCallback(env, callbackQuery) {
  const data = callbackQuery.data;
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  try {
    if (data.startsWith("cl:del:")) {
      // Boss-only: there is one shared Google Calendar (the boss's), so
      // deleting events must not be invokable by members.
      if (callbackQuery.from.id !== Number(env.BOSS_USER_ID)) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callback_query_id: callbackQuery.id,
            text: "ฟังก์ชันนี้สำหรับผู้ดูแลระบบเท่านั้นค่ะ",
            show_alert: true,
          }),
        }).catch(e => console.error("cl non-boss answer error:", e.message));
        return;
      }
      const eventId = data.slice(7);
      await deleteEvent(env, eventId);

      // Answer callback
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callbackQuery.id,
          text: "✅ ลบนัดหมายแล้วค่ะ",
        }),
      });

      // Edit message to show deleted
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: "✅ ลบนัดหมายแล้วค่ะ",
        }),
      });
    }
  } catch (err) {
    console.error("handleCalendarCallback error:", err);
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQuery.id,
        text: "❌ ลบไม่สำเร็จ: " + err.message,
        show_alert: true,
      }),
    });
  }
}

// ===== Display helpers =====

function formatEventList(events, label) {
  let text = `📅 <b>ปฏิทิน${label}:</b>\n`;
  let currentDate = "";

  for (const e of events) {
    if (e.date !== currentDate) {
      currentDate = e.date;
      const d = new Date(e.date + "T12:00:00Z");
      const dayThai = THAI_DAYS[d.getUTCDay()];
      const monthThai = THAI_MONTHS[d.getUTCMonth()];
      text += `\n<b>วัน${dayThai} ${d.getUTCDate()} ${monthThai}</b>\n`;
    }
    const timeStr = e.time === "ทั้งวัน" ? "ทั้งวัน" : `${e.time}-${e.endTime}`;
    text += `• ${timeStr} ${escapeHtml(e.title)}`;
    if (e.status) text += ` [${escapeHtml(e.status)}]`;
    text += "\n";
    if (e.description) text += `  📝 ${escapeHtml(e.description.slice(0, 100))}${e.description.length > 100 ? "..." : ""}\n`;
    if (e.location) text += `  📍 ${formatLocation(e.location)}\n`;
    if (e.meetLink) text += `  🔗 <a href="${escapeHtml(e.meetLink)}">Google Meet</a>\n`;
    if (e.phone) text += `  📞 ${escapeHtml(e.phone)}\n`;
    if (e.organizer) text += `  👤 จัดโดย: ${escapeHtml(e.organizer)}\n`;
    if (e.attendees?.length) {
      const others = e.attendees.filter(a => !a.self);
      if (others.length) text += `  👥 ผู้เข้าร่วม ${others.length} คน\n`;
    }
    if (e.attachments?.length) {
      for (const att of e.attachments) {
        text += `  📎 <a href="${escapeHtml(att.url)}">${escapeHtml(att.title)}</a>\n`;
      }
    }
    text += "\n";
  }

  return text;
}
