CREATE TABLE IF NOT EXISTS file_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  file_type TEXT NOT NULL,       -- 'html' or 'pdf'
  file_name TEXT,
  body_text TEXT,                -- HTML: extracted text content
  file_id TEXT,                  -- PDF: Telegram file_id (re-download later)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
