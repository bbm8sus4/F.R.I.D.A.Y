ALTER TABLE memories ADD COLUMN priority TEXT DEFAULT 'hot';
CREATE INDEX idx_memories_priority ON memories(priority, created_at);
