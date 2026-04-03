CREATE TABLE IF NOT EXISTS scheduled_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_chat_id INTEGER NOT NULL,
  message_text TEXT NOT NULL,
  send_at DATETIME NOT NULL,
  status TEXT DEFAULT 'pending',
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  sent_at DATETIME
);
