// AI usage logger — logs to ai_log table

export async function logAIUsage(db, { userId, chatId, feature, model, inputTokens, outputTokens, toolCallsCount, toolNames, durationMs, success, error }) {
  try {
    await db.prepare(
      `INSERT INTO ai_log (user_id, chat_id, provider, model, feature, input_tokens, output_tokens, tool_calls_count, tool_names, duration_ms, success, error_message)
       VALUES (?, ?, 'gemini', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      userId || null,
      chatId || null,
      model || null,
      feature || null,
      inputTokens || 0,
      outputTokens || 0,
      toolCallsCount || 0,
      toolNames ? JSON.stringify(toolNames) : null,
      durationMs || 0,
      success ? 1 : 0,
      error || null,
    ).run();
  } catch (e) {
    console.error('logAIUsage error:', e.message);
  }
}
