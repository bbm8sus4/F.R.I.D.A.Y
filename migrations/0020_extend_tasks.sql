-- Extend tasks table for secretary layer
ALTER TABLE tasks ADD COLUMN title TEXT DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN assignee_id INTEGER DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN assignee_name TEXT DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN priority TEXT DEFAULT 'medium';
ALTER TABLE tasks ADD COLUMN category TEXT DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN expected_output TEXT DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN created_by_id INTEGER DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN created_by_name TEXT DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN chat_id INTEGER DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority, status);
CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category, status);
CREATE INDEX IF NOT EXISTS idx_tasks_chat ON tasks(chat_id, status);
