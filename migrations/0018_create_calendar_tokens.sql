CREATE TABLE IF NOT EXISTS calendar_tokens (
  id INTEGER PRIMARY KEY DEFAULT 1,
  access_token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
