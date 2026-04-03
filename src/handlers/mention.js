import { sendTyping, sendTelegram } from "../lib/telegram.js";
import { getSmartContext } from "../lib/context.js";
import { askGemini } from "../lib/gemini.js";
import { parseAndExecuteActions } from "../lib/actions.js";
import { downloadPhotoByFileId, downloadHtmlFile, getPhotoFileId, getRecentPhoto } from "../lib/media.js";

export async function handleMention(env, message, botUsername, text, hasMedia, isDM) {
  try {
    const cleanText = text.replace(new RegExp(`@${botUsername}`, "g"), "").trim();
    if (!cleanText && !hasMedia) return;

    await sendTyping(env, message.chat.id);

    let context;
    try {
      context = await getSmartContext(env.DB, message.chat.id, isDM, cleanText, env);
    } catch (ctxErr) {
      console.error("getSmartContext FAILED:", ctxErr.message, ctxErr.stack);
      context = "";
    }

    // ดึง HTML file: ดาวน์โหลด → แปลงเป็น text → แนบใน userMessage
    const isHtml = message.document?.mime_type === "text/html" ||
      message.reply_to_message?.document?.mime_type === "text/html";
    let htmlContent = null;
    if (isHtml) {
      const htmlFileId = (message.document?.mime_type === "text/html"
        ? message.document.file_id
        : message.reply_to_message?.document?.file_id);
      if (htmlFileId) {
        htmlContent = await downloadHtmlFile(env, htmlFileId);
      }
    }

    // ดึงรูป/PDF: จากข้อความนี้ → reply → รูปล่าสุด
    let imageData = null;
    if (!isHtml) {
      const fileId =
        getPhotoFileId(message) ||
        getPhotoFileId(message.reply_to_message) ||
        null;

      if (fileId) {
        imageData = await downloadPhotoByFileId(env, fileId);
      }

      // เช็คไฟล์ใหญ่เกินไป
      if (imageData?.error === "FILE_TOO_LARGE") {
        const sizeMB = (imageData.size / 1024 / 1024).toFixed(1);
        await sendTelegram(env, message.chat.id,
          `ไฟล์ใหญ่เกินไปค่ะนาย (${sizeMB}MB) รับได้ไม่เกิน 10MB ค่ะ`,
          message.message_id);
        return;
      }

      // ถ้ายังไม่มีรูป ดึงจากรูปล่าสุดใน DB (5 นาที) — ทั้ง DM และกลุ่ม
      if (!imageData) {
        imageData = await getRecentPhoto(env, message.chat.id, message.message_id);
      }
    }

    // แนบเนื้อหาข้อความที่ reply ถึง เพื่อให้ Gemini รู้บริบท
    let userMessage = cleanText;

    // แนบเนื้อหา HTML file
    if (htmlContent?.text) {
      const truncated = htmlContent.text.substring(0, 8000);
      const label = cleanText
        ? `[ไฟล์ HTML: ${htmlContent.fileName}]\n${truncated}\n\n${cleanText}`
        : `[ไฟล์ HTML: ${htmlContent.fileName}]\n${truncated}\n\nสรุปเนื้อหาในไฟล์นี้ให้หน่อย`;
      userMessage = label;
    }
    const replyMsg = message.reply_to_message;
    const isReplyToBot = replyMsg?.from?.username === botUsername;
    if (replyMsg && !htmlContent?.text) {
      const replyContent = replyMsg.text || replyMsg.caption || "";
      if (replyContent) {
        if (isReplyToBot) {
          // Include bot's prior response + try to find the triggering user message
          let priorContext = "";
          try {
            const priorMsg = await env.DB.prepare(
              `SELECT message_text FROM messages
               WHERE chat_id = ? AND message_id < ? AND user_id = ?
               ORDER BY message_id DESC LIMIT 1`
            ).bind(message.chat.id, replyMsg.message_id, message.from.id).first();
            if (priorMsg?.message_text) {
              priorContext = `[ข้อความก่อนหน้าของผู้ใช้: "${priorMsg.message_text.substring(0, 300)}"]\n`;
            }
          } catch (e) { /* ignore */ }
          userMessage = `${priorContext}[บอทตอบก่อนหน้า: "${replyContent.substring(0, 500)}"]\n\n${cleanText}`;
        } else {
          const replyFrom = replyMsg.from?.first_name || replyMsg.from?.username || "Unknown";
          userMessage = `[Reply ถึงข้อความของ ${replyFrom}: "${replyContent}"]\n\n${cleanText}`;
        }
      }
    }

    let reply = await askGemini(env, userMessage, context, imageData);

    // Parse and execute action tags (e.g., [SEND:chat_id:message])
    const { cleanReply, actionsExecuted, hasActionTags } = await parseAndExecuteActions(env, reply);

    // Send clean reply to boss (without action tags)
    // ถ้ามี action tags + อยู่ในกลุ่ม → ส่ง confirmation ไป DM บอส ไม่โชว์ในกลุ่ม
    if (cleanReply) {
      if (hasActionTags && !isDM) {
        await sendTelegram(env, message.from.id, cleanReply, null, true);
      } else {
        await sendTelegram(env, message.chat.id, cleanReply, message.message_id, true);
      }
    } else if (!actionsExecuted) {
      // AI returned empty reply and no actions executed → send fallback
      await sendTelegram(env, message.chat.id, "ขออภัยค่ะ ไม่สามารถประมวลผลได้ในตอนนี้ ลองใหม่อีกครั้งนะคะ", message.message_id);
    }
  } catch (err) {
    console.error("handleMention error:", err.message, err.stack);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดค่ะนาย ลองใหม่อีกครั้งนะคะ", message.message_id);
  }
}

export async function handleMemberChat(env, message, botUsername, text, hasMedia) {
  try {
    const cleanText = text.replace(new RegExp(`@${botUsername}`, "g"), "").trim();
    const replyHasMedia = !!(message.reply_to_message && getPhotoFileId(message.reply_to_message));
    if (!cleanText && !hasMedia && !replyHasMedia) return;

    await sendTyping(env, message.chat.id);

    let context;
    try {
      context = await getSmartContext(env.DB, message.chat.id, false, cleanText);
    } catch (ctxErr) {
      console.error("getSmartContext (member) FAILED:", ctxErr.message);
      context = "";
    }

    // ดึง HTML file
    const isHtml = message.document?.mime_type === "text/html" ||
      message.reply_to_message?.document?.mime_type === "text/html";
    let htmlContent = null;
    if (isHtml) {
      const htmlFileId = (message.document?.mime_type === "text/html"
        ? message.document.file_id
        : message.reply_to_message?.document?.file_id);
      if (htmlFileId) {
        htmlContent = await downloadHtmlFile(env, htmlFileId);
      }
    }

    // ดึงรูป/PDF
    let imageData = null;
    if (!isHtml) {
      const fileId =
        getPhotoFileId(message) ||
        getPhotoFileId(message.reply_to_message) ||
        null;
      if (fileId) {
        imageData = await downloadPhotoByFileId(env, fileId);
      }
      if (imageData?.error === "FILE_TOO_LARGE") {
        const sizeMB = (imageData.size / 1024 / 1024).toFixed(1);
        await sendTelegram(env, message.chat.id,
          `ไฟล์ใหญ่เกินไปค่ะ (${sizeMB}MB) รับได้ไม่เกิน 10MB ค่ะ`,
          message.message_id);
        return;
      }
      if (!imageData) {
        imageData = await getRecentPhoto(env, message.chat.id, message.message_id);
      }
    }

    let userMessage = cleanText;
    if (htmlContent?.text) {
      const truncated = htmlContent.text.substring(0, 8000);
      userMessage = cleanText
        ? `[ไฟล์ HTML: ${htmlContent.fileName}]\n${truncated}\n\n${cleanText}`
        : `[ไฟล์ HTML: ${htmlContent.fileName}]\n${truncated}\n\nสรุปเนื้อหาในไฟล์นี้ให้หน่อย`;
    }
    const replyMsg = message.reply_to_message;
    const isMemberReplyToBot = replyMsg?.from?.username === botUsername;
    if (replyMsg && !htmlContent?.text) {
      const replyContent = replyMsg.text || replyMsg.caption || "";
      if (replyContent && !isMemberReplyToBot) {
        const replyFrom = replyMsg.from?.first_name || replyMsg.from?.username || "Unknown";
        userMessage = `[Reply ถึงข้อความของ ${replyFrom}: "${replyContent}"]\n\n${cleanText}`;
      }
      // For reply-to-bot: multi-turn is built below in contents array
    }

    const memberBotName = env.BOT_NAME || "Friday";
    const memberSystemPrompt = `[Role & Identity]
คุณคือ "${memberBotName}" — AI ผู้ช่วยอัจฉริยะ เพศหญิง
ชื่อของคุณคือ "${memberBotName}" — เมื่อเอ่ยถึงตัวเอง ให้เขียนว่า "${memberBotName}" เท่านั้น ห้ามแปล ห้ามทับศัพท์ ห้ามเขียนเป็นภาษาอื่นเด็ดขาด
หน้าที่คือช่วยเหลือผู้ใช้ในการวิเคราะห์ข้อมูล ตอบคำถาม และสนับสนุนงานทั่วไป

[Core Personality]
- Direct & Analytical: ตอบตรงประเด็น กระชับ ชัดเจน
- ZERO PREAMBLE: เข้าเนื้อหาทันที ไม่เกริ่นนำ
- Helpful & Professional: สุภาพ เป็นกันเอง พร้อมช่วยเหลือ

[Tone & Voice]
- เรียกผู้ใช้ว่า "คุณ"
- ใช้คำลงท้ายผู้หญิง เช่น "ค่ะ" "นะคะ" "คะ"
- พูดได้ทั้งไทยและอังกฤษ ตามภาษาของผู้ใช้
- ตอบสั้นกระชับ ไม่พูดซ้ำ
- Format responses using Telegram HTML. Allowed tags: <b>bold</b>, <i>italic</i>, <code>code</code>, <pre>code block</pre>. Do NOT use Markdown.

[Image Analysis]
- เมื่อได้รับรูปภาพ ให้อธิบายเฉพาะสิ่งที่เห็นจริงในภาพเท่านั้น
- ถ้าภาพไม่ชัด ให้บอกตรงๆ

[Context]
---
${context}
---`;

    const model = env.GEMINI_MODEL || "gemini-2.5-pro";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

    // Build contents array — multi-turn when replying to bot
    const contents = [];

    if (isMemberReplyToBot && replyMsg) {
      const botText = replyMsg.text || replyMsg.caption || "";
      let hasPriorUser = false;
      // Find the user message that triggered the bot's response
      try {
        const priorMsg = await env.DB.prepare(
          `SELECT message_text FROM messages
           WHERE chat_id = ? AND message_id < ? AND user_id = ?
           ORDER BY message_id DESC LIMIT 1`
        ).bind(message.chat.id, replyMsg.message_id, message.from.id).first();
        if (priorMsg?.message_text) {
          contents.push({ role: "user", parts: [{ text: priorMsg.message_text }] });
          hasPriorUser = true;
        }
      } catch (e) {
        console.error("Failed to fetch prior message for member reply chain:", e.message);
      }
      // Only add model turn if there's a preceding user turn (Gemini requires user-first)
      if (botText && hasPriorUser) {
        contents.push({ role: "model", parts: [{ text: botText }] });
      }
    }

    const currentParts = [];
    if (imageData) {
      currentParts.push({ inline_data: { mime_type: imageData.mimeType, data: imageData.base64 } });
    }
    currentParts.push({ text: (isMemberReplyToBot ? cleanText : userMessage) || "อธิบายรูปนี้ให้หน่อย" });
    contents.push({ role: "user", parts: currentParts });

    const reqBody = JSON.stringify({
      system_instruction: { parts: [{ text: memberSystemPrompt }] },
      contents,
      tools: [{ google_search: {} }],
      generationConfig: {
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingBudget: 2048 },
      },
    });

    let response, lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      try {
        response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: reqBody, signal: controller.signal });
        clearTimeout(timeout);
        if (response.ok) break;
        if ([429, 500, 502, 503].includes(response.status) && attempt < 2) {
          lastError = `HTTP ${response.status}`;
          continue;
        }
        break;
      } catch (e) {
        clearTimeout(timeout);
        lastError = e.message;
        if (attempt === 2) break;
      }
    }

    if (!response?.ok) {
      console.error("Member Gemini error:", lastError);
      await sendTelegram(env, message.chat.id, "ขออภัยค่ะ ระบบขัดข้อง กรุณาลองใหม่ค่ะ", message.message_id);
      return;
    }

    const data = await response.json();
    const reply = data.candidates?.[0]?.content?.parts
      ?.filter(p => p.text && !p.thought)
      ?.map(p => p.text)
      ?.join("") || "";

    if (reply) {
      await sendTelegram(env, message.chat.id, reply, message.message_id, true);
    } else {
      await sendTelegram(env, message.chat.id, "ขออภัยค่ะ ไม่สามารถประมวลผลได้ในตอนนี้ ลองใหม่อีกครั้งนะคะ", message.message_id);
    }
  } catch (err) {
    console.error("handleMemberChat error:", err.message, err.stack);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดค่ะ ลองใหม่อีกครั้งนะคะ", message.message_id);
  }
}
