export async function getUserRole(env, userId) {
  if (userId === Number(env.BOSS_USER_ID)) return "boss";
  try {
    const row = await env.DB.prepare(
      `SELECT user_id FROM allowed_users WHERE user_id = ?`
    ).bind(userId).first();
    return row ? "member" : null;
  } catch { return null; }
}

// ===== Helper: ตรวจจับการแท็กบอสในกลุ่ม =====
export function detectBossMention(message, bossId, bossUsername, env) {
  // 1. Telegram entity mentions (text_mention + @username)
  // Check both text entities and caption entities separately
  const textEntities = message.entities || [];
  const captionEntities = message.caption_entities || [];
  const allEntities = [...textEntities, ...captionEntities];
  const msgText = message.text || message.caption || "";

  for (const e of allEntities) {
    if (e.type === "text_mention" && e.user?.id === bossId) return "tag";
    if (e.type === "mention" && bossUsername) {
      const mentioned = msgText.substring(e.offset + 1, e.offset + e.length);
      if (mentioned.toLowerCase() === bossUsername.toLowerCase()) return "tag";
    }
  }

  // 2. Reply to boss's message (skip forum topic auto-replies)
  if (message.reply_to_message?.from?.id === bossId
      && !message.is_topic_message
      && !message.reply_to_message?.forum_topic_created
      && !message.reply_to_message?.forum_topic_edited) return "reply";

  // 3. Keyword mention — ชื่อเล่น/คำเรียกบอส (skip if no text)
  if (!msgText) return false;
  const textLower = msgText.toLowerCase();
  let bossNicknames = ["บ๊อบ", "บ๊อบบี้", "จารย์บ๊อบ", "พี่บ๊อบ", "ครับบ๊อบ", "บ๊อบครับ", "พ่อใหญ่บ๊อบ", "bob"];
  if (env?.BOSS_NICKNAMES) {
    try { bossNicknames = JSON.parse(env.BOSS_NICKNAMES); } catch (e) { /* use defaults */ }
  }
  if (bossNicknames.some(nick => textLower.includes(nick.toLowerCase()))) return "nickname";

  return false;
}

// ===== Helper: แยก command ออกจากข้อความ =====
// "/send@Bot_username hello" → { cmd: "/send", args: "hello" }
export function parseCommand(text) {
  const match = text.match(/^\/(\w+)(@\w+)?\s*([\s\S]*)/);
  if (!match) return null;
  return { cmd: `/${match[1]}`, args: match[3] || "" };
}

// ===== Telegram Mini App Auth Validator =====
export async function validateTelegramWebApp(authHeader, env) {
  if (!authHeader?.startsWith("tma ")) return null;
  const initData = authHeader.slice(4);
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const entries = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");

  const encoder = new TextEncoder();
  const secretKey = await crypto.subtle.importKey(
    "raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const secretHash = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(env.TELEGRAM_BOT_TOKEN));
  const validationKey = await crypto.subtle.importKey(
    "raw", secretHash, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", validationKey, encoder.encode(dataCheckString));
  const computedHash = [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("");

  if (computedHash !== hash) return null;
  const authDate = Number(params.get("auth_date"));
  if (Date.now() / 1000 - authDate > 86400) return null;

  try { return JSON.parse(params.get("user")); } catch { return null; }
}
