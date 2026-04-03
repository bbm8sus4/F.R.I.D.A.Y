// Secretary Handler — handleSecretary(), handleSecretaryContinue(), handleSecretaryCallback()

import { sendTyping, sendTelegram, sendTelegramWithKeyboard } from '../lib/telegram.js';
import { downloadPhotoByFileId, downloadHtmlFile, getPhotoFileId, getRecentPhoto } from '../lib/media.js';
import { buildSecretaryContext } from '../secretary/secretary-context.js';
import { buildSecretaryPrompt, buildMemberSecretaryPrompt } from '../secretary/secretary-prompt.js';
import { executeSecretaryTurn } from '../secretary/tool-executor.js';
import { saveConversation, clearConversation } from '../secretary/conversation.js';
import { fallbackIntentExtraction, buildFallbackResponse } from '../secretary/fallback.js';
import { getExecutor } from '../secretary/tool-registry.js';
import { escapeHtml } from '../lib/html-utils.js';
import { askGemini } from '../lib/gemini.js';

export async function handleSecretary(env, message, botUsername, text, hasMedia, isDM) {
  try {
    const cleanText = text.replace(new RegExp(`@${botUsername}`, 'g'), '').trim();
    const replyHasMedia = !!(message.reply_to_message && getPhotoFileId(message.reply_to_message));
    if (!cleanText && !hasMedia && !replyHasMedia) return;

    await sendTyping(env, message.chat.id);

    // Build secretary context
    let context;
    try {
      context = await buildSecretaryContext(env, message.chat.id, isDM, cleanText);
    } catch (e) {
      console.error('buildSecretaryContext failed:', e.message);
      context = '';
    }

    // Handle media (same pattern as handleMention)
    let imageData = null;
    let userMessage = cleanText;

    const isHtml = message.document?.mime_type === 'text/html' ||
      message.reply_to_message?.document?.mime_type === 'text/html';

    if (isHtml) {
      const htmlFileId = (message.document?.mime_type === 'text/html'
        ? message.document.file_id
        : message.reply_to_message?.document?.file_id);
      if (htmlFileId) {
        const htmlContent = await downloadHtmlFile(env, htmlFileId);
        if (htmlContent?.text) {
          const truncated = htmlContent.text.substring(0, 8000);
          userMessage = cleanText
            ? `[ไฟล์ HTML: ${htmlContent.fileName}]\n${truncated}\n\n${cleanText}`
            : `[ไฟล์ HTML: ${htmlContent.fileName}]\n${truncated}\n\nสรุปเนื้อหาในไฟล์นี้ให้หน่อย`;
        }
      }
    } else {
      const fileId = getPhotoFileId(message) || getPhotoFileId(message.reply_to_message) || null;
      if (fileId) {
        imageData = await downloadPhotoByFileId(env, fileId);
      }
      if (imageData?.error === 'FILE_TOO_LARGE') {
        const sizeMB = (imageData.size / 1024 / 1024).toFixed(1);
        await sendTelegram(env, message.chat.id,
          `ไฟล์ใหญ่เกินไปค่ะนาย (${sizeMB}MB) รับได้ไม่เกิน 10MB ค่ะ`,
          message.message_id);
        return;
      }
      if (!imageData) {
        imageData = await getRecentPhoto(env, message.chat.id, message.message_id);
      }
    }

    // Attach reply context
    const replyMsg = message.reply_to_message;
    if (replyMsg && !isHtml) {
      const replyContent = replyMsg.text || replyMsg.caption || '';
      if (replyContent) {
        const replyFrom = replyMsg.from?.first_name || replyMsg.from?.username || 'Unknown';
        userMessage = `[Reply ถึงข้อความของ ${replyFrom}: "${replyContent}"]\n\n${cleanText}`;
      }
    }

    // Build messages array for tool executor
    const messages = [];
    if (imageData) {
      messages.push({
        role: 'user',
        parts: [
          { inline_data: { mime_type: imageData.mimeType, data: imageData.base64 } },
          { text: userMessage || 'อธิบายรูปนี้ให้หน่อย' },
        ],
      });
    } else {
      messages.push({ role: 'user', content: userMessage });
    }

    const systemPrompt = buildSecretaryPrompt(env, context);

    const result = await executeSecretaryTurn(env, {
      systemPrompt,
      messages,
      role: 'boss',
      userId: message.from.id,
      chatId: message.chat.id,
      feature: 'secretary',
    });

    // Handle result
    if (result.error) {
      // Try fallback regex for task-like commands
      const fallbackResult = fallbackIntentExtraction(cleanText);
      if (fallbackResult) {
        const executor = getExecutor(fallbackResult.tool);
        if (executor) {
          try {
            const toolResult = await executor(env, fallbackResult.args, {
              userId: message.from.id,
              chatId: message.chat.id,
              role: 'boss',
            });
            if (toolResult.success) {
              await sendTelegram(env, message.chat.id,
                formatToolResult(fallbackResult.tool, toolResult),
                message.message_id, true);
              return;
            }
          } catch { /* fallback also failed */ }
        }
      }
      // Fall through to askGemini (has Google Search) for general questions
      try {
        const reply = await askGemini(env, userMessage, context, imageData);
        if (reply) {
          await sendTelegram(env, message.chat.id, reply, message.message_id, true);
          return;
        }
      } catch (e) {
        console.error('askGemini fallback error:', e.message);
      }
      await sendTelegram(env, message.chat.id,
        buildFallbackResponse(env.BOT_NAME || 'Friday'),
        message.message_id);
      return;
    }

    if (result.needsClarification) {
      // Save conversation state for follow-up
      await saveConversation(env.DB, message.chat.id, message.from.id, 'clarification', {
        messages,
        systemPrompt,
      });
      const questionText = (result.text ? result.text + '\n\n' : '') + result.clarificationQuestion;
      if (result.clarificationOptions?.length) {
        const buttons = result.clarificationOptions.map((opt, i) => [
          { text: opt, callback_data: `sec:opt:${message.from.id}:${i}` },
        ]);
        buttons.push([{ text: '❌ ยกเลิก', callback_data: `sec:cancel:${message.from.id}` }]);
        await sendTelegramWithKeyboard(env, message.chat.id, questionText, message.message_id, buttons);
      } else {
        await sendTelegram(env, message.chat.id, questionText, message.message_id, true);
      }
      return;
    }

    if (result.needsConfirmation) {
      // Save pending action for confirmation
      await saveConversation(env.DB, message.chat.id, message.from.id, 'confirmation', {
        messages,
        systemPrompt,
        pendingAction: result.confirmationData,
      });
      const confirmText = (result.text ? result.text + '\n\n' : '') +
        formatConfirmationMessage(result.confirmationData);
      await sendTelegramWithKeyboard(env, message.chat.id, confirmText, message.message_id, [
        [
          { text: '✅ ยืนยัน', callback_data: `sec:confirm:${message.from.id}` },
          { text: '❌ ยกเลิก', callback_data: `sec:cancel:${message.from.id}` },
        ],
        [{ text: '✏️ แก้ไข', callback_data: `sec:edit:${message.from.id}` }],
      ]);
      return;
    }

    // No tools used = general question → re-route to askGemini (has Google Search + sources)
    if (result.noToolsUsed) {
      try {
        const reply = await askGemini(env, userMessage, context, imageData);
        if (reply) {
          await sendTelegram(env, message.chat.id, reply, message.message_id, true);
          return;
        }
      } catch (e) {
        console.error('askGemini re-route error:', e.message);
        // Fall through to secretary's own response
      }
    }

    // Normal text response
    if (result.text) {
      await sendTelegram(env, message.chat.id, result.text, message.message_id, true);
    } else {
      await sendTelegram(env, message.chat.id, 'ไม่เข้าใจค่ะนาย ลองพิมพ์ใหม่อีกครั้งนะคะ', message.message_id);
    }
  } catch (err) {
    console.error('handleSecretary error:', err.message, err.stack);
    await sendTelegram(env, message.chat.id,
      'เกิดข้อผิดพลาดค่ะนาย ลองใหม่อีกครั้งนะคะ', message.message_id);
  }
}

export async function handleSecretaryContinue(env, message, activeConvo, text, isDM) {
  try {
    await sendTyping(env, message.chat.id);

    const { data } = activeConvo;
    const conversationMessages = data.messages || [];

    // Append user's new reply
    conversationMessages.push({ role: 'user', content: text });

    const result = await executeSecretaryTurn(env, {
      systemPrompt: data.systemPrompt,
      messages: conversationMessages,
      role: 'boss',
      userId: message.from.id,
      chatId: message.chat.id,
      feature: 'secretary_continue',
    });

    // Clear the conversation state (done with multi-turn)
    await clearConversation(env.DB, message.chat.id, message.from.id);

    if (result.error) {
      await sendTelegram(env, message.chat.id,
        buildFallbackResponse(env.BOT_NAME || 'Friday'),
        message.message_id);
      return;
    }

    if (result.needsClarification) {
      await saveConversation(env.DB, message.chat.id, message.from.id, 'clarification', {
        messages: conversationMessages,
        systemPrompt: data.systemPrompt,
      });
      const questionText = (result.text ? result.text + '\n\n' : '') + result.clarificationQuestion;
      await sendTelegram(env, message.chat.id, questionText, message.message_id, true);
      return;
    }

    if (result.needsConfirmation) {
      await saveConversation(env.DB, message.chat.id, message.from.id, 'confirmation', {
        messages: conversationMessages,
        systemPrompt: data.systemPrompt,
        pendingAction: result.confirmationData,
      });
      const confirmText = (result.text ? result.text + '\n\n' : '') +
        formatConfirmationMessage(result.confirmationData);
      await sendTelegramWithKeyboard(env, message.chat.id, confirmText, message.message_id, [
        [
          { text: '✅ ยืนยัน', callback_data: `sec:confirm:${message.from.id}` },
          { text: '❌ ยกเลิก', callback_data: `sec:cancel:${message.from.id}` },
        ],
        [{ text: '✏️ แก้ไข', callback_data: `sec:edit:${message.from.id}` }],
      ]);
      return;
    }

    if (result.text) {
      await sendTelegram(env, message.chat.id, result.text, message.message_id, true);
    } else {
      await sendTelegram(env, message.chat.id, 'ไม่เข้าใจค่ะนาย ลองพิมพ์ใหม่อีกครั้งนะคะ', message.message_id);
    }
  } catch (err) {
    console.error('handleSecretaryContinue error:', err.message, err.stack);
    await clearConversation(env.DB, message.chat.id, message.from.id);
    await sendTelegram(env, message.chat.id,
      'เกิดข้อผิดพลาดค่ะนาย ลองใหม่อีกครั้งนะคะ', message.message_id);
  }
}

export async function handleSecretaryCallback(env, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;
  const parts = data.split(':');
  const action = parts[1]; // confirm, cancel, edit, opt
  const targetUserId = Number(parts[2]);

  // Answer callback immediately
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQuery.id }),
  });

  // Only the original user can interact
  if (callbackQuery.from.id !== targetUserId) {
    return;
  }

  try {
    if (action === 'cancel') {
      await clearConversation(env.DB, chatId, targetUserId);
      await editMessage(env, chatId, messageId, 'ยกเลิกแล้วค่ะ ❌');
      return;
    }

    if (action === 'confirm') {
      const convo = await getConvoForCallback(env.DB, chatId, targetUserId);
      if (!convo || convo.stateType !== 'confirmation') {
        await editMessage(env, chatId, messageId, 'ไม่พบข้อมูลที่ต้องยืนยันค่ะ (หมดอายุแล้ว)');
        return;
      }

      const pending = convo.data.pendingAction;
      const executor = getExecutor(pending.toolName);
      if (!executor) {
        await clearConversation(env.DB, chatId, targetUserId);
        await editMessage(env, chatId, messageId, 'ไม่พบฟังก์ชันที่ต้องดำเนินการค่ะ');
        return;
      }

      const toolResult = await executor(env, pending.args, {
        userId: targetUserId,
        chatId,
        role: 'boss',
      });

      await clearConversation(env.DB, chatId, targetUserId);

      const resultText = toolResult.success
        ? '✅ ดำเนินการเสร็จเรียบร้อยแล้วค่ะ\n' + formatToolResult(pending.toolName, toolResult)
        : '❌ เกิดข้อผิดพลาด: ' + (toolResult.error || 'ไม่ทราบสาเหตุ');
      await editMessage(env, chatId, messageId, resultText);
      return;
    }

    if (action === 'edit') {
      // Update state to accept text edit
      const convo = await getConvoForCallback(env.DB, chatId, targetUserId);
      if (convo) {
        await saveConversation(env.DB, chatId, targetUserId, 'clarification', {
          messages: convo.data.messages || [],
          systemPrompt: convo.data.systemPrompt,
        });
      }
      await editMessage(env, chatId, messageId,
        callbackQuery.message.text + '\n\n✏️ พิมพ์คำสั่งใหม่ได้เลยค่ะ');
      return;
    }

    if (action === 'opt') {
      // Option selected from clarification
      const optIndex = Number(parts[3]);
      const convo = await getConvoForCallback(env.DB, chatId, targetUserId);
      if (!convo) {
        await editMessage(env, chatId, messageId, 'หมดอายุแล้วค่ะ ลองใหม่');
        return;
      }

      // Get the selected option text from the button
      const selectedText = callbackQuery.message.reply_markup?.inline_keyboard?.[optIndex]?.[0]?.text || `option ${optIndex}`;

      // Continue conversation with selected option
      const messages = convo.data.messages || [];
      messages.push({ role: 'user', content: selectedText });

      await clearConversation(env.DB, chatId, targetUserId);

      await sendTyping(env, chatId);
      const result = await executeSecretaryTurn(env, {
        systemPrompt: convo.data.systemPrompt,
        messages,
        role: 'boss',
        userId: targetUserId,
        chatId,
        feature: 'secretary_continue',
      });

      if (result.text) {
        await sendTelegram(env, chatId, result.text, null, true);
      } else {
        await sendTelegram(env, chatId, 'ไม่เข้าใจค่ะ ลองพิมพ์ใหม่อีกครั้งนะคะ', null);
      }
    }
  } catch (err) {
    console.error('handleSecretaryCallback error:', err.message, err.stack);
    await clearConversation(env.DB, chatId, targetUserId);
    await editMessage(env, chatId, messageId, `❌ เกิดข้อผิดพลาด: ${escapeHtml(err.message || 'ไม่ทราบสาเหตุ')}`);
  }
}

// Helpers

async function getConvoForCallback(db, chatId, userId) {
  try {
    const row = await db.prepare(
      `SELECT state_type, state_data FROM conversation_state
       WHERE chat_id = ? AND user_id = ? AND expires_at > datetime('now')
       ORDER BY updated_at DESC LIMIT 1`
    ).bind(chatId, userId).first();
    if (!row) return null;
    return { stateType: row.state_type, data: JSON.parse(row.state_data) };
  } catch { return null; }
}

async function editMessage(env, chatId, messageId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
    }),
  }).catch(e => console.error('editMessage error:', e.message));
}

function formatConfirmationMessage(confirmationData) {
  const { toolName, args } = confirmationData;
  if (toolName === 'send_message') {
    return `📨 จะส่งข้อความไปกลุ่ม <code>${escapeHtml(String(args.chat_id))}</code>:\n"${escapeHtml(args.message?.substring(0, 200) || '')}"`;
  }
  if (toolName === 'update_task' && args.assignee_name) {
    return `📝 จะมอบหมาย Task #${args.task_id} ให้ <b>${escapeHtml(args.assignee_name)}</b>`;
  }
  if (toolName === 'delete_calendar_event') {
    return `🗑 จะลบนัดหมายนี้ออกจากปฏิทิน (event: <code>${escapeHtml(args.event_id || '')}</code>)`;
  }
  if (toolName === 'delete_memory') {
    return `🗑 จะลบความจำ #${args.memory_id}`;
  }
  return `⚡ ยืนยันการดำเนินการ: ${toolName}`;
}

function formatToolResult(toolName, result) {
  if (toolName === 'create_task') {
    let text = `📌 สร้าง Task #${result.task_id} — "<b>${escapeHtml(result.title || '')}</b>"`;
    if (result.assignee) text += `\n👤 ผู้รับผิดชอบ: ${escapeHtml(result.assignee)}`;
    if (result.due_on) text += `\n📅 กำหนด: ${result.due_on}`;
    if (result.priority) text += `\n⚡ Priority: ${result.priority}`;
    return text;
  }
  if (toolName === 'complete_task') {
    return `✅ Task #${result.task_id} เสร็จแล้ว — "${escapeHtml(result.title || '')}"`;
  }
  if (toolName === 'send_message') {
    return `📨 ส่งข้อความเรียบร้อยแล้วค่ะ`;
  }
  if (toolName === 'create_calendar_event') {
    let text = `📅 สร้างนัด "<b>${escapeHtml(result.title || '')}</b>"`;
    text += `\n📆 ${result.date} เวลา ${result.time}-${result.endTime}`;
    if (result.location) text += `\n📍 ${escapeHtml(result.location)}`;
    return text;
  }
  if (toolName === 'update_calendar_event') {
    let text = `📅 แก้ไขนัด "<b>${escapeHtml(result.title || '')}</b>"`;
    text += `\n📆 ${result.date} เวลา ${result.time}-${result.endTime}`;
    if (result.location) text += `\n📍 ${escapeHtml(result.location)}`;
    return text;
  }
  if (toolName === 'delete_calendar_event') {
    return `🗑 ลบนัดหมายแล้ว — "<b>${escapeHtml(result.title || '')}</b>"`;
  }
  if (toolName === 'save_memory') {
    return `🧠 จำแล้วค่ะ #${result.memory_id} — "${escapeHtml(result.content || '')}" (หมวด: ${result.category})`;
  }
  if (toolName === 'delete_memory') {
    return `🗑 ลบความจำ #${result.memory_id} แล้วค่ะ`;
  }
  return JSON.stringify(result).substring(0, 300);
}

