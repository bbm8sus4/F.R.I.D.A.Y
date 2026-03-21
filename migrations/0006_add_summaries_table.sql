CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  chat_title TEXT,
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  message_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_summaries_chat_week ON summaries(chat_id, week_end);
