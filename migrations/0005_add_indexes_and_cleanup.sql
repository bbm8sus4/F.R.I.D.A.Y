-- เพิ่ม indexes สำหรับ performance optimization

-- messages: index on created_at สำหรับ DM mode queries + cross-group (ที่ไม่ filter chat_id)
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- memories: index on category + created_at (ไม่มี index เลย)
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category, created_at);

-- messages: partial index สำหรับค้นรูปภาพ (photo_file_id IS NOT NULL)
CREATE INDEX IF NOT EXISTS idx_messages_photo_lookup ON messages(chat_id, message_id)
  WHERE photo_file_id IS NOT NULL;
