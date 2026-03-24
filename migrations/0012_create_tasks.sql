CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  result TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  archived_to_memory_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);
