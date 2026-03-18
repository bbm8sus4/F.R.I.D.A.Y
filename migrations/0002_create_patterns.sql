-- ตาราง commitments สำหรับจับคำสัญญา/งานค้าง
CREATE TABLE IF NOT EXISTS commitments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  username TEXT,
  first_name TEXT,
  promise_text TEXT NOT NULL,
  original_message TEXT,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME
);

CREATE INDEX idx_commitments_status ON commitments(status, created_at);
CREATE INDEX idx_commitments_user ON commitments(user_id, status);
