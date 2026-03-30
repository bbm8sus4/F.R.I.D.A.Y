CREATE TABLE IF NOT EXISTS task_blockers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  blocker_description TEXT NOT NULL,
  blocked_by_task_id INTEGER,
  resolved INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME
);
