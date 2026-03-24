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
      context = await getSmartContext(env.DB, message.chat.id, isDM, cleanText);
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
    if (replyMsg && !htmlContent?.text) {
      const replyContent = replyMsg.text || replyMsg.caption || "";
      if (replyContent) {
        const replyFrom = replyMsg.from?.first_name || replyMsg.from?.username || "Unknown";
        userMessage = `[Reply ถึงข้อความของ ${replyFrom}: "${replyContent}"]\n\n${cleanText}`;
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
    }
  } catch (err) {
    console.error("handleMention error:", err.message, err.stack);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดค่ะนาย ลองใหม่อีกครั้งนะคะ", message.message_id);
  }
}

export async function handleMemberChat(env, message, botUsername, text, hasMedia) {
  try {
    const cleanText = text.replace(new RegExp(`@${botUsername}`, "g"), "").trim();
    if (!cleanText && !hasMedia) return;

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
    if (replyMsg && !htmlContent?.text) {
      const replyContent = replyMsg.text || replyMsg.caption || "";
      if (replyContent) {
        const replyFrom = replyMsg.from?.first_name || replyMsg.from?.username || "Unknown";
        userMessage = `[Reply ถึงข้อความของ ${replyFrom}: "${replyContent}"]\n\n${cleanText}`;
      }
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

    const model = "gemini-2.5-pro";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

    const parts = [];
    if (imageData) {
      parts.push({ inline_data: { mime_type: imageData.mimeType, data: imageData.base64 } });
    }
    parts.push({ text: userMessage || "อธิบายรูปนี้ให้หน่อย" });

    const reqBody = JSON.stringify({
      system_instruction: { parts: [{ text: memberSystemPrompt }] },
      contents: [{ role: "user", parts }],
      tools: [{ google_search: {} }],
      generationConfig: {
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingBudget: 2048 },
      },
    });

    let response, lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
      try {
        response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: reqBody });
        if (response.ok) break;
        if ([429, 500, 502, 503].includes(response.status) && attempt < 2) {
          lastError = `HTTP ${response.status}`;
          continue;
        }
        break;
      } catch (e) {
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
    }
  } catch (err) {
    console.error("handleMemberChat error:", err.message, err.stack);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดค่ะ ลองใหม่อีกครั้งนะคะ", message.message_id);
  }
}
