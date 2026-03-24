-- Multi-user access control: allowed members table
CREATE TABLE IF NOT EXISTS allowed_users (
  user_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  added_by INTEGER NOT NULL,
  added_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
