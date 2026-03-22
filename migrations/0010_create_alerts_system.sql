-- Proactive Alert v2: alerts table + group_registry

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_hash TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  chat_title TEXT,
  urgency TEXT DEFAULT 'medium',
  category TEXT DEFAULT 'info',
  who TEXT,
  summary TEXT NOT NULL,
  topic_fingerprint TEXT,
  status TEXT DEFAULT 'new',
  boss_action TEXT,
  telegram_message_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_alerts_fingerprint ON alerts (topic_fingerprint, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_chat ON alerts (chat_id, created_at);

CREATE TABLE IF NOT EXISTS group_registry (
  chat_id INTEGER PRIMARY KEY,
  chat_title TEXT,
  last_message_at DATETIME,
  is_active INTEGER DEFAULT 1,
  priority_weight REAL DEFAULT 1.0
);
