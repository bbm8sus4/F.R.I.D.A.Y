CREATE TABLE IF NOT EXISTS pending_sends (
  user_id INTEGER PRIMARY KEY,
  target_chat_id TEXT NOT NULL,
  instruction TEXT,
  draft_text TEXT,
  revision_count INTEGER DEFAULT 0,
  preview_message_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
