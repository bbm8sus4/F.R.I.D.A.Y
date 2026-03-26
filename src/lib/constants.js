// ===== Urgent keyword patterns (real-time alert, no AI) =====
export const URGENT_PATTERNS = [
  { pattern: /ด่วน(มาก)?|urgent|emergency|asap/i, type: "urgent" },
  { pattern: /ระบบ.*(ล่ม|พัง|crash|down)/i, type: "system" },
  { pattern: /เสียหาย|data\s*loss/i, type: "data" },
  { pattern: /ลูกค้า.*(โกรธ|ร้องเรียน|complain)/i, type: "customer" },
];

export const MAX_PDF_SIZE = 10 * 1024 * 1024; // 10MB

// ===== Multi-user access control =====
export const MEMBER_COMMANDS = new Set([
  "/task", "/tasks", "/done", "/cancel",
  "/readlink", "/readpdf", "/readhtml", "/readimg", "/readvoice",
  "/summary", "/menu", "/start",
  "/recap", "/delete",
  "/cal",
]);

export const MEMBER_CALLBACKS = new Set(["tk:", "rl:", "fc:", "recap:", "del:", "sm:", "cl:"]);

// Telegram-supported HTML tags
export const ALLOWED_TAGS = new Set(["b", "i", "u", "s", "code", "pre", "blockquote", "a", "tg-spoiler", "tg-emoji"]);

export const STOP_WORDS = new Set([
  "ครับ", "ค่ะ", "คะ", "นะ", "นะครับ", "นะคะ", "จ้า", "จ้ะ", "จะ", "ก็", "แล้ว", "ด้วย", "ที่", "ของ", "ให้", "ได้", "มี", "เป็น", "ไป", "มา", "อยู่", "ไม่", "กัน", "คือ", "แต่", "หรือ", "ถ้า", "เรา", "ผม", "ฉัน",
  "the", "is", "are", "was", "were", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by", "it", "this", "that", "i", "you", "he", "she", "we", "they", "my", "your", "do", "does", "did", "not", "no", "yes",
]);
