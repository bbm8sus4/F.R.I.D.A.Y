-- Task blockers
CREATE TABLE IF NOT EXISTS task_blockers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  blocker_description TEXT NOT NULL,
  blocked_by_task_id INTEGER,
  resolved INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_task_blockers_task ON task_blockers(task_id, resolved);
