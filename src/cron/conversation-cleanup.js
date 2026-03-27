// Conversation Cleanup — expire stale conversation states

import { cleanupExpiredConversations } from '../secretary/conversation.js';

export async function conversationCleanup(env) {
  try {
    const deleted = await cleanupExpiredConversations(env.DB);
    if (deleted > 0) {
      console.log(`Cleaned up ${deleted} expired conversation states`);
    }
  } catch (e) {
    console.error('conversationCleanup error:', e.message);
  }
}
