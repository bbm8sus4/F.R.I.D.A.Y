// Conversation state management — save/load/expire multi-turn states in D1

const DEFAULT_TTL_MINUTES = 30;

export async function getActiveConversation(db, chatId, userId) {
  try {
    const row = await db.prepare(
      `SELECT id, state_type, state_data, expires_at FROM conversation_state
       WHERE chat_id = ? AND user_id = ? AND expires_at > datetime('now')
       ORDER BY updated_at DESC LIMIT 1`
    ).bind(chatId, userId).first();
    if (!row) return null;
    return {
      id: row.id,
      stateType: row.state_type,
      data: JSON.parse(row.state_data),
    };
  } catch (e) {
    console.error('getActiveConversation error:', e.message);
    return null;
  }
}

export async function saveConversation(db, chatId, userId, stateType, data, ttlMinutes) {
  const ttl = ttlMinutes || DEFAULT_TTL_MINUTES;
  try {
    // Upsert: delete existing then insert
    await db.prepare(
      `DELETE FROM conversation_state WHERE chat_id = ? AND user_id = ?`
    ).bind(chatId, userId).run();

    const expiresAt = new Date(Date.now() + ttl * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    await db.prepare(
      `INSERT INTO conversation_state (chat_id, user_id, state_type, state_data, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(chatId, userId, stateType, JSON.stringify(data), expiresAt).run();
  } catch (e) {
    console.error('saveConversation error:', e.message);
  }
}

export async function clearConversation(db, chatId, userId) {
  try {
    await db.prepare(
      `DELETE FROM conversation_state WHERE chat_id = ? AND user_id = ?`
    ).bind(chatId, userId).run();
  } catch (e) {
    console.error('clearConversation error:', e.message);
  }
}

export async function cleanupExpiredConversations(db) {
  try {
    const result = await db.prepare(
      `DELETE FROM conversation_state WHERE expires_at < datetime('now')`
    ).run();
    return result.meta?.changes || 0;
  } catch (e) {
    console.error('cleanupExpiredConversations error:', e.message);
    return 0;
  }
}
