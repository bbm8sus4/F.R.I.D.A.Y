-- Conversation state for multi-turn secretary interactions
CREATE TABLE IF NOT EXISTS conversation_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  state_type TEXT NOT NULL,
  state_data TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_conv_lookup ON conversation_state(chat_id, user_id);
CREATE INDEX IF NOT EXISTS idx_conv_expires ON conversation_state(expires_at);
