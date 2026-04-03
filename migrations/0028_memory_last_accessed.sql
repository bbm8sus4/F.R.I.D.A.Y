-- Track when memories are last used in context (for auto-decay)
ALTER TABLE memories ADD COLUMN last_accessed DATETIME DEFAULT NULL;
