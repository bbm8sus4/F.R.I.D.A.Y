import { sendTelegram } from "../lib/telegram.js";
import { escapeHtml } from "../lib/html-utils.js";

export async function handleRememberCommand(env, message, args) {
  try {
    let content = args.trim();
    if (!content) {
      await sendTelegram(env, message.chat.id, "Usage: /remember <สิ่งที่จะจำ>\nหรือ /remember [category] <สิ่งที่จะจำ>", message.message_id);
      return;
    }

    let category = "general";
    const catMatch = content.match(/^\[(\w+)\]\s*([\s\S]*)/);
    if (catMatch) {
      category = catMatch[1];
      content = catMatch[2];
    }

    const { meta } = await env.DB
      .prepare(`INSERT INTO memories (content, category) VALUES (?, ?)`)
      .bind(content, category)
      .run();

    await sendTelegram(env, message.chat.id, `จำแล้วค่ะนาย (ID: #${meta.last_row_id}, หมวด: ${category})`, message.message_id);
  } catch (err) {
    console.error("handleRememberCommand error:", err);
  }
}

export async function handleMemoriesCommand(env, message) {
  try {
    const { results } = await env.DB
      .prepare(`SELECT id, content, category, priority, datetime(created_at, '+7 hours') as created_at FROM memories ORDER BY CASE priority WHEN 'hot' THEN 1 WHEN 'warm' THEN 2 WHEN 'cold' THEN 3 ELSE 4 END, created_at DESC LIMIT 30`)
      .all();

    if (results.length === 0) {
      await sendTelegram(env, message.chat.id, "ยังไม่มีความจำที่บันทึกไว้ค่ะนาย", message.message_id);
      return;
    }

    const tierEmoji = { hot: "🔴", warm: "🟡", cold: "🔵" };
    let reply = `ความจำถาวรของ ${env.BOT_NAME || "Friday"}:\n\n`;
    for (const m of results) {
      const emoji = tierEmoji[m.priority] || "⚪";
      reply += `#${m.id} ${emoji} ${m.priority} [${m.category}]\n${m.content}\nเมื่อ: ${m.created_at}\n\n`;
    }
    reply += "🔴 hot = ใช้ทุกครั้ง | 🟡 warm = ดึงเมื่อเกี่ยวข้อง | 🔵 cold = เก็บถาวร\n";
    reply += "/cooldown <id> ลดระดับ | /heatup <id> เพิ่มระดับ | /forget <id ...> ลบ";

    await sendTelegram(env, message.chat.id, reply, message.message_id);
  } catch (err) {
    console.error("handleMemoriesCommand error:", err);
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
  }
}
