-- Upgrade pending_sends for AI compose + edit loop
DROP TABLE IF EXISTS pending_sends;
CREATE TABLE pending_sends (
  user_id INTEGER PRIMARY KEY,
  target_chat_id TEXT NOT NULL,
  instruction TEXT,
  draft_text TEXT,
  revision_count INTEGER DEFAULT 0,
  preview_message_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
