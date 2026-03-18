-- สร้างตาราง messages สำหรับเก็บข้อความทั้งหมดจาก Telegram
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  chat_title TEXT,
  user_id INTEGER NOT NULL,
  username TEXT,
  first_name TEXT,
  message_text TEXT,
  message_id INTEGER,
  reply_to_message_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_chat_created ON messages(chat_id, created_at);
