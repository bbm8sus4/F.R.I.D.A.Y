-- AI usage logging
CREATE TABLE IF NOT EXISTS ai_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  chat_id INTEGER,
  provider TEXT DEFAULT 'gemini',
  model TEXT,
  feature TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  tool_calls_count INTEGER DEFAULT 0,
  tool_names TEXT,
  duration_ms INTEGER,
  success INTEGER DEFAULT 1,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ai_log_created ON ai_log(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_log_feature ON ai_log(feature, created_at);
