import { sendTelegram } from "../lib/telegram.js";

export async function handleAllowCommand(env, message, args) {
  try {
    if (message.from.id !== Number(env.BOSS_USER_ID)) {
      await sendTelegram(env, message.chat.id, "ฟีเจอร์นี้สำหรับผู้ดูแลระบบเท่านั้นค่ะ", message.message_id);
      return;
    }
    let targetId, targetUsername, targetFirstName;

    // Method 1: Reply to someone's message
    if (message.reply_to_message?.from && !args.trim()) {
      const from = message.reply_to_message.from;
      if (from.is_bot) {
        await sendTelegram(env, message.chat.id, "ไม่สามารถเพิ่มบอทเป็นสมาชิกได้ค่ะ", message.message_id);
        return;
      }
      targetId = from.id;
      targetUsername = from.username || null;
      targetFirstName = from.first_name || null;
    }
    // Method 2: /allow <user_id>
    else if (args.trim()) {
      targetId = Number(args.trim());
      if (!targetId || isNaN(targetId)) {
        await sendTelegram(env, message.chat.id, "Usage: Reply ข้อความแล้วพิมพ์ /allow หรือ /allow <user_id>", message.message_id);
        return;
      }
    } else {
      await sendTelegram(env, message.chat.id, "Usage: Reply ข้อความแล้วพิมพ์ /allow หรือ /allow <user_id>", message.message_id);
      return;
    }

    if (targetId === Number(env.BOSS_USER_ID)) {
      await sendTelegram(env, message.chat.id, "นายเป็นผู้ดูแลระบบอยู่แล้วค่ะ 😄", message.message_id);
      return;
    }

    await env.DB.prepare(
      `INSERT OR REPLACE INTO allowed_users (user_id, username, first_name, added_by) VALUES (?, ?, ?, ?)`
    ).bind(targetId, targetUsername || null, targetFirstName || null, message.from.id).run();

    const displayName = targetFirstName || targetId;
    const usernameStr = targetUsername ? ` (@${targetUsername})` : "";
    await sendTelegram(env, message.chat.id, `✅ เพิ่ม ${displayName}${usernameStr} เป็นสมาชิกแล้วค่ะ`, message.message_id);
  } catch (err) {
    console.error("handleAllowCommand error:", err);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดค่ะ", message.message_id);
  }
}

export async function handleRevokeCommand(env, message, args) {
  try {
    if (message.from.id !== Number(env.BOSS_USER_ID)) {
      await sendTelegram(env, message.chat.id, "ฟีเจอร์นี้สำหรับผู้ดูแลระบบเท่านั้นค่ะ", message.message_id);
      return;
    }
    let targetId, targetUsername, targetFirstName;

    if (message.reply_to_message?.from && !args.trim()) {
      const from = message.reply_to_message.from;
      targetId = from.id;
      targetUsername = from.username || null;
      targetFirstName = from.first_name || null;
    } else if (args.trim()) {
      targetId = Number(args.trim());
      if (!targetId || isNaN(targetId)) {
        await sendTelegram(env, message.chat.id, "Usage: Reply ข้อความแล้วพิมพ์ /revoke หรือ /revoke <user_id>", message.message_id);
        return;
      }
      // Try to get name from DB
      const existing = await env.DB.prepare(
        `SELECT username, first_name FROM allowed_users WHERE user_id = ?`
      ).bind(targetId).first();
      if (existing) {
        targetUsername = existing.username;
        targetFirstName = existing.first_name;
      }
    } else {
      await sendTelegram(env, message.chat.id, "Usage: Reply ข้อความแล้วพิมพ์ /revoke หรือ /revoke <user_id>", message.message_id);
      return;
    }

    const result = await env.DB.prepare(
      `DELETE FROM allowed_users WHERE user_id = ?`
    ).bind(targetId).run();

    if (result.meta.changes === 0) {
      await sendTelegram(env, message.chat.id, `ไม่พบ user ID ${targetId} ในรายชื่อสมาชิกค่ะ`, message.message_id);
      return;
    }

    const displayName = targetFirstName || targetId;
    const usernameStr = targetUsername ? ` (@${targetUsername})` : "";
    await sendTelegram(env, message.chat.id, `❌ ถอดสิทธิ์ ${displayName}${usernameStr} แล้วค่ะ`, message.message_id);
  } catch (err) {
    console.error("handleRevokeCommand error:", err);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดค่ะ", message.message_id);
  }
}

export async function handleUsersCommand(env, message) {
  try {
    if (message.from.id !== Number(env.BOSS_USER_ID)) {
      await sendTelegram(env, message.chat.id, "ฟีเจอร์นี้สำหรับผู้ดูแลระบบเท่านั้นค่ะ", message.message_id);
      return;
    }
    const { results } = await env.DB.prepare(
      `SELECT user_id, username, first_name, datetime(added_at, '+7 hours') as added_at FROM allowed_users ORDER BY added_at DESC`
    ).all();

    if (results.length === 0) {
      await sendTelegram(env, message.chat.id, "ยังไม่มีสมาชิกค่ะ\nใช้ /allow เพื่อเพิ่มสมาชิก", message.message_id);
      return;
    }

    let text = `👥 สมาชิกทั้งหมด (${results.length} คน)\n`;
    for (const u of results) {
      const name = u.first_name || "ไม่ทราบชื่อ";
      const uname = u.username ? ` (@${u.username})` : "";
      const date = u.added_at ? u.added_at.substring(0, 16) : "N/A";
      text += `\n• ${name}${uname}\n  ID: ${u.user_id} | เพิ่มเมื่อ: ${date}`;
    }
    await sendTelegram(env, message.chat.id, text, message.message_id);
  } catch (err) {
    console.error("handleUsersCommand error:", err);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดค่ะ", message.message_id);
  }
}
