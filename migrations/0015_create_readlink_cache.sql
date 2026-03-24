-- readlink_cache สำหรับเก็บเนื้อหาลิงก์ที่อ่านแล้ว
CREATE TABLE IF NOT EXISTS readlink_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  body_text TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
