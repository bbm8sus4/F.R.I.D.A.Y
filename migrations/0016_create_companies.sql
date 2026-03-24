-- Companies table for grouping Telegram groups by company
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Link groups to companies
ALTER TABLE group_registry ADD COLUMN company_id INTEGER DEFAULT NULL;
