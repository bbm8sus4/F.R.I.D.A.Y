// Tool Executor — multi-turn AI↔tool loop (max 5 rounds)

import { createProvider } from './ai-provider.js';
import { logAIUsage } from './ai-logger.js';
import { getAllToolDefinitions, getExecutor } from './tool-registry.js';
import { requiresConfirmation, checkPermission, checkTaskOwnership } from './guardrails.js';

const MAX_ROUNDS = 5;

/**
 * Execute a secretary turn — multi-round tool calling loop.
 * Returns: { text, needsConfirmation, confirmationData, needsClarification, clarificationQuestion, error }
 */
export async function executeSecretaryTurn(env, { systemPrompt, messages, role, userId, chatId, feature }) {
  const provider = createProvider(env);
  const tools = getAllToolDefinitions(role);
  const startTime = Date.now();
  let totalToolCalls = 0;
  const toolNamesUsed = [];
  let lastUsage = { inputTokens: 0, outputTokens: 0 };
  let usedModel = null;

  // Working copy of messages for multi-turn
  const conversation = [...messages];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await provider.complete({
      systemPrompt,
      messages: conversation,
      tools,
      generationConfig: {
        maxOutputTokens: 4096,
        thinkingConfig: { thinkingBudget: 1024 },
      },
    });

    usedModel = response.model;
    if (response.usage) lastUsage = response.usage;

    if (response.error) {
      await logAIUsage(env.DB, {
        userId, chatId, feature: feature || 'secretary', model: usedModel,
        inputTokens: lastUsage.inputTokens, outputTokens: lastUsage.outputTokens,
        toolCallsCount: totalToolCalls, toolNames: toolNamesUsed,
        durationMs: Date.now() - startTime, success: false, error: response.errorMessage,
      });
      return { error: true, errorMessage: response.errorMessage };
    }

    // No tool calls — just text response
    if (!response.toolCalls || response.toolCalls.length === 0) {
      await logAIUsage(env.DB, {
        userId, chatId, feature: feature || 'secretary', model: usedModel,
        inputTokens: lastUsage.inputTokens, outputTokens: lastUsage.outputTokens,
        toolCallsCount: totalToolCalls, toolNames: toolNamesUsed,
        durationMs: Date.now() - startTime, success: true,
      });
      return { text: response.text || '', noToolsUsed: totalToolCalls === 0 };
    }

    // Process tool calls
    const toolResults = [];
    for (const call of response.toolCalls) {
      totalToolCalls++;
      toolNamesUsed.push(call.name);

      // Special: ask_clarification — signals "need more info"
      if (call.name === 'ask_clarification') {
        await logAIUsage(env.DB, {
          userId, chatId, feature: feature || 'secretary', model: usedModel,
          inputTokens: lastUsage.inputTokens, outputTokens: lastUsage.outputTokens,
          toolCallsCount: totalToolCalls, toolNames: toolNamesUsed,
          durationMs: Date.now() - startTime, success: true,
        });
        return {
          needsClarification: true,
          clarificationQuestion: call.args.question || 'ต้องการข้อมูลเพิ่มเติมค่ะ',
          clarificationOptions: call.args.options || null,
          // Include any text the AI already produced
          text: response.text || '',
        };
      }

      // Check permissions
      const permCheck = checkPermission(call.name, call.args, { role, userId });
      if (!permCheck.allowed) {
        toolResults.push({
          name: call.name,
          result: { error: permCheck.reason },
        });
        continue;
      }

      // Check ownership for members
      if (permCheck.checkOwnership && call.args.task_id) {
        const isOwner = await checkTaskOwnership(env.DB, call.args.task_id, userId);
        if (!isOwner) {
          toolResults.push({
            name: call.name,
            result: { error: 'คุณไม่มีสิทธิ์แก้ไข task นี้ค่ะ (ไม่ใช่ผู้รับผิดชอบหรือผู้สร้าง)' },
          });
          continue;
        }
      }

      // Check if confirmation is required
      if (requiresConfirmation(call.name, call.args, { role, userId })) {
        await logAIUsage(env.DB, {
          userId, chatId, feature: feature || 'secretary', model: usedModel,
          inputTokens: lastUsage.inputTokens, outputTokens: lastUsage.outputTokens,
          toolCallsCount: totalToolCalls, toolNames: toolNamesUsed,
          durationMs: Date.now() - startTime, success: true,
        });
        return {
          needsConfirmation: true,
          confirmationData: {
            toolName: call.name,
            args: call.args,
            pendingMessages: conversation,
          },
          text: response.text || '',
        };
      }

      // Execute the tool
      const executor = getExecutor(call.name);
      if (!executor) {
        toolResults.push({
          name: call.name,
          result: { error: `Unknown tool: ${call.name}` },
        });
        continue;
      }

      try {
        const result = await executor(env, call.args, { userId, chatId, role });
        toolResults.push({ name: call.name, result });
      } catch (e) {
        console.error(`Tool ${call.name} execution error:`, e.message);
        toolResults.push({
          name: call.name,
          result: { error: e.message },
        });
      }
    }

    // Append assistant message with function calls + function responses
    conversation.push({
      role: 'model',
      parts: response.parts,
    });

    conversation.push({
      role: 'user',
      parts: toolResults.map(tr => ({
        functionResponse: {
          name: tr.name,
          response: tr.result,
        },
      })),
    });
  }

  // Max rounds exceeded
  await logAIUsage(env.DB, {
    userId, chatId, feature: feature || 'secretary', model: usedModel,
    inputTokens: lastUsage.inputTokens, outputTokens: lastUsage.outputTokens,
    toolCallsCount: totalToolCalls, toolNames: toolNamesUsed,
    durationMs: Date.now() - startTime, success: true,
  });

  return { text: 'ขออภัยค่ะ ดำเนินการหลายขั้นตอนเกินไป ลองสั่งใหม่ด้วยคำสั่งที่ชัดเจนกว่านี้นะคะ' };
}
