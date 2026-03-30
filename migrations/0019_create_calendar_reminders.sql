CREATE TABLE IF NOT EXISTS calendar_reminders (
  event_id TEXT NOT NULL,
  event_date TEXT NOT NULL,
  reminded_at DATETIME DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, event_date)
);
