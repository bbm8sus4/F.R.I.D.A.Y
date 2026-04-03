CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  chat_id INTEGER,
  command TEXT,
  args TEXT,
  role TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
