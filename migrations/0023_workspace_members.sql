-- Workspace members for secretary layer
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_telegram ON workspace_members(telegram_user_id) WHERE telegram_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wm_name ON workspace_members(display_name);
