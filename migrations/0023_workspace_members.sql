CREATE TABLE IF NOT EXISTS workspace_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER,
  telegram_username TEXT,
  display_name TEXT NOT NULL,
  nicknames TEXT DEFAULT '[]',
  role TEXT DEFAULT 'employee',
  department TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
