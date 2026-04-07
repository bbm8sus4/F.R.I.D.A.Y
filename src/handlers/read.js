import { sendTelegram, sendTelegramWithKeyboard, sendTyping, textToSpeech, sendVoice } from "../lib/telegram.js";
import { downloadPhotoByFileId, downloadHtmlFile, getPhotoFileId } from "../lib/media.js";
import { askGemini } from "../lib/gemini.js";
import { htmlToText, extractMeta, sanitizeHtml } from "../lib/html-utils.js";
import { MAX_PDF_SIZE } from "../lib/constants.js";
import { getSmartContext } from "../lib/context.js";
import { parseAndExecuteActions } from "../lib/actions.js";

export async function handleReadhtmlCommand(env, message, args) {
  try {
    const htmlMime = "text/html";

    // ตรวจจาก mime_type หรือนามสกุลไฟล์ .html/.htm
    const isHtmlDoc = (doc) => {
      if (!doc) return false;
      if (doc.mime_type === htmlMime) return true;
      const name = (doc.file_name || "").toLowerCase();
      return name.endsWith(".html") || name.endsWith(".htm");
    };

    const doc = isHtmlDoc(message.document)
      ? message.document
      : isHtmlDoc(message.reply_to_message?.document)
        ? message.reply_to_message.document
        : null;

    if (!doc) {
      await sendTelegram(env, message.chat.id,
        "วิธีใช้:\n• ส่งไฟล์ .html แล้วพิมพ์ /readhtml ใน caption\n• หรือ reply ไฟล์ .html แล้วพิมพ์ /readhtml",
        message.message_id);
      return;
    }

    await sendTyping(env, message.chat.id);

    const htmlContent = await downloadHtmlFile(env, doc.file_id);
    if (!htmlContent?.text) {
      await sendTelegram(env, message.chat.id, "ไม่สามารถอ่านไฟล์ HTML ได้ค่ะนาย", message.message_id);
      return;
    }

    // If args provided, process directly (like old behavior)
    if (args) {
      const truncated = htmlContent.text.substring(0, 8000);
      const userMessage = `[ไฟล์ HTML: ${htmlContent.fileName}]\n${truncated}\n\n${args}`;
      const isDM = message.chat.type === "private";
      let context = "";
      try { context = await getSmartContext(env.DB, message.chat.id, isDM, args); } catch (e) { /* ignore */ }
      let reply = await askGemini(env, userMessage, context, null);
      const { cleanReply } = await parseAndExecuteActions(env, reply);
      if (cleanReply) {
        await sendTelegram(env, message.chat.id, cleanReply, message.message_id, true);
      } else {
        await sendTelegram(env, message.chat.id, "ขออภัยค่ะ ไม่สามารถประมวลผลไฟล์นี้ได้ ลองใหม่อีกครั้งนะคะ", message.message_id);
      }
      return;
    }

    // Cache content + show keyboard
    const { meta } = await env.DB.prepare(
      `INSERT INTO file_cache (chat_id, file_type, file_name, body_text) VALUES (?, ?, ?, ?)`
    ).bind(message.chat.id, "html", htmlContent.fileName || "file.html", htmlContent.text.substring(0, 15000)).run();
    const cacheId = meta.last_row_id;

    const previewText = htmlContent.text.substring(0, 200).replace(/\n+/g, " ");
    let preview = "📄 <b>HTML File</b>\n";
    preview += `📁 <b>${htmlContent.fileName}</b>\n`;
    preview += `📝 ${previewText}...\n\nเลือกสิ่งที่ต้องการค่ะนาย:`;

    await sendTelegramWithKeyboard(env, message.chat.id, preview, message.message_id, [
      [
        { text: "📋 สรุปแบบสั้น", callback_data: `fc:short:${cacheId}` },
        { text: "📝 สรุปละเอียด", callback_data: `fc:detail:${cacheId}` },
      ],
      [
        { text: "🔍 วิเคราะห์", callback_data: `fc:analyze:${cacheId}` },
        { text: "💬 ถามเอง", callback_data: `fc:ask:${cacheId}` },
      ],
    ]);
  } catch (err) {
    console.error("handleReadhtmlCommand error:", err.message, err.stack);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดในการอ่านไฟล์ HTML ค่ะนาย", message.message_id);
  }
}

// ===== /readpdf — PDF Read with Inline Keyboard =====

export async function handleReadpdfCommand(env, message, args) {
  try {
    const doc = (message.document?.mime_type === "application/pdf")
      ? message.document
      : (message.reply_to_message?.document?.mime_type === "application/pdf")
        ? message.reply_to_message.document
        : null;

    if (!doc) {
      await sendTelegram(env, message.chat.id,
        "วิธีใช้:\n• ส่งไฟล์ PDF แล้วพิมพ์ /readpdf ใน caption\n• หรือ reply ไฟล์ PDF แล้วพิมพ์ /readpdf",
        message.message_id);
      return;
    }

    // Check file size
    if (doc.file_size && doc.file_size > MAX_PDF_SIZE) {
      await sendTelegram(env, message.chat.id,
        `❌ ไฟล์ PDF ใหญ่เกินไป (${(doc.file_size / 1024 / 1024).toFixed(1)}MB) รองรับสูงสุด 10MB ค่ะนาย`,
        message.message_id);
      return;
    }

    await sendTyping(env, message.chat.id);

    // If args provided, process directly
    if (args) {
      const imageData = await downloadPhotoByFileId(env, doc.file_id);
      if (!imageData || imageData.error) {
        const errMsg = imageData?.error === "FILE_TOO_LARGE"
          ? `❌ ไฟล์ PDF ใหญ่เกินไป รองรับสูงสุด 10MB ค่ะนาย`
          : "❌ ไม่สามารถดาวน์โหลดไฟล์ PDF ได้ค่ะนาย";
        await sendTelegram(env, message.chat.id, errMsg, message.message_id);
        return;
      }
      const userMessage = `[ไฟล์ PDF: ${doc.file_name || "file.pdf"}]\n\n${args}`;
      const isDM = message.chat.type === "private";
      let context = "";
      try { context = await getSmartContext(env.DB, message.chat.id, isDM, args); } catch (e) { /* ignore */ }
      let reply = await askGemini(env, userMessage, context, imageData);
      const { cleanReply } = await parseAndExecuteActions(env, reply);
      if (cleanReply) {
        await sendTelegram(env, message.chat.id, cleanReply, message.message_id, true);
      } else {
        await sendTelegram(env, message.chat.id, "ขออภัยค่ะ ไม่สามารถประมวลผลไฟล์ PDF ได้ ลองใหม่อีกครั้งนะคะ", message.message_id);
      }
      return;
    }

    // Cache file_id + show keyboard
    const { meta } = await env.DB.prepare(
      `INSERT INTO file_cache (chat_id, file_type, file_name, file_id) VALUES (?, ?, ?, ?)`
    ).bind(message.chat.id, "pdf", doc.file_name || "file.pdf", doc.file_id).run();
    const cacheId = meta.last_row_id;

    let preview = "📄 <b>PDF File</b>\n";
    preview += `📁 <b>${doc.file_name || "file.pdf"}</b>\n`;
    if (doc.file_size) preview += `📦 ${(doc.file_size / 1024).toFixed(0)} KB\n`;
    preview += `\nเลือกสิ่งที่ต้องการค่ะนาย:`;

    await sendTelegramWithKeyboard(env, message.chat.id, preview, message.message_id, [
      [
        { text: "📋 สรุปแบบสั้น", callback_data: `fc:short:${cacheId}` },
        { text: "📝 สรุปละเอียด", callback_data: `fc:detail:${cacheId}` },
      ],
      [
        { text: "🔍 วิเคราะห์", callback_data: `fc:analyze:${cacheId}` },
        { text: "💬 ถามเอง", callback_data: `fc:ask:${cacheId}` },
      ],
    ]);
  } catch (err) {
    console.error("handleReadpdfCommand error:", err.message, err.stack);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดในการอ่านไฟล์ PDF ค่ะนาย", message.message_id);
  }
}

// ===== /readimg — Image Read with Inline Keyboard =====

export async function handleReadimgCommand(env, message, args) {
  try {
    const hasPhoto = !!(message.photo?.length > 0 || message.document?.mime_type?.startsWith("image/"));
    const replyHasPhoto = !!(message.reply_to_message?.photo?.length > 0 || message.reply_to_message?.document?.mime_type?.startsWith("image/"));

    const sourceMsg = hasPhoto ? message : replyHasPhoto ? message.reply_to_message : null;

    if (!sourceMsg) {
      await sendTelegram(env, message.chat.id,
        "วิธีใช้:\n• ส่งรูปแล้วพิมพ์ /readimg ใน caption\n• หรือ reply รูปแล้วพิมพ์ /readimg",
        message.message_id);
      return;
    }

    await sendTyping(env, message.chat.id);

    const fileId = getPhotoFileId(sourceMsg);
    if (!fileId) {
      await sendTelegram(env, message.chat.id, "❌ ไม่สามารถอ่านรูปภาพได้ค่ะนาย", message.message_id);
      return;
    }

    // If args provided, process directly
    if (args) {
      const imageData = await downloadPhotoByFileId(env, fileId);
      if (!imageData || imageData.error) {
        await sendTelegram(env, message.chat.id, "❌ ไม่สามารถดาวน์โหลดรูปภาพได้ค่ะนาย", message.message_id);
        return;
      }
      const userMessage = `[รูปภาพ]\n\n${args}`;
      const isDM = message.chat.type === "private";
      let context = "";
      try { context = await getSmartContext(env.DB, message.chat.id, isDM, args); } catch (e) { /* ignore */ }
      let reply = await askGemini(env, userMessage, context, imageData);
      const { cleanReply } = await parseAndExecuteActions(env, reply);
      if (cleanReply) {
        await sendTelegram(env, message.chat.id, cleanReply, message.message_id, true);
      } else {
        await sendTelegram(env, message.chat.id, "ขออภัยค่ะ ไม่สามารถประมวลผลรูปนี้ได้ ลองใหม่อีกครั้งนะคะ", message.message_id);
      }
      return;
    }

    // Get file name
    const fileName = sourceMsg.document?.file_name || "image.jpg";

    // Cache file_id + show keyboard
    const { meta } = await env.DB.prepare(
      `INSERT INTO file_cache (chat_id, file_type, file_name, file_id) VALUES (?, ?, ?, ?)`
    ).bind(message.chat.id, "image", fileName, fileId).run();
    const cacheId = meta.last_row_id;

    let preview = "🖼 <b>Image File</b>\n";
    preview += `📁 <b>${fileName}</b>\n`;
    preview += `\nเลือกสิ่งที่ต้องการค่ะนาย:`;

    await sendTelegramWithKeyboard(env, message.chat.id, preview, message.message_id, [
      [
        { text: "📋 สรุปแบบสั้น", callback_data: `fc:short:${cacheId}` },
        { text: "📝 สรุปละเอียด", callback_data: `fc:detail:${cacheId}` },
      ],
      [
        { text: "🔍 วิเคราะห์", callback_data: `fc:analyze:${cacheId}` },
        { text: "💬 ถามเอง", callback_data: `fc:ask:${cacheId}` },
      ],
    ]);
  } catch (err) {
    console.error("handleReadimgCommand error:", err.message, err.stack);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดในการอ่านรูปภาพค่ะนาย", message.message_id);
  }
}

// ===== File Callback Handler (fc:*) =====

export async function handleFileCallback(env, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  // Parse callback data: "fc:<mode>:<cacheId>"
  const parts = callbackQuery.data.split(":");
  const mode = parts[1];
  const cacheId = Number(parts[2]);

  const modeLabels = { short: "สรุปแบบสั้น", detail: "สรุปละเอียด", analyze: "วิเคราะห์", ask: "ถามเอง" };

  // Answer callback query
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQuery.id,
      text: `⏳ กำลัง${modeLabels[mode]}...`,
    }),
  });

  // Escape originalText for HTML
  const originalText = (callbackQuery.message.text || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Helper: editMessageText
  const editPreview = async (html) => {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: sanitizeHtml(html),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [] },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("editPreview failed:", err);
    }
    return res.ok;
  };

  // Update preview status + remove buttons
  const statusText = mode === "ask"
    ? `${originalText}\n\n💬 <b>โหมดถามเอง</b> — reply ข้อความถัดไปเพื่อถามค่ะ`
    : `${originalText}\n\n⏳ <b>กำลัง${modeLabels[mode]}...</b>`;
  const editOk = await editPreview(statusText);
  if (!editOk) return;

  // Load cache
  const { results } = await env.DB.prepare(
    `SELECT file_type, file_name, body_text, file_id FROM file_cache WHERE id = ?`
  ).bind(cacheId).all();

  if (!results.length) {
    await editPreview(`${originalText}\n\n❌ <b>ไม่พบข้อมูลไฟล์ อาจหมดอายุแล้ว</b>`);
    await sendTelegram(env, chatId, "❌ ไม่พบข้อมูลไฟล์ อาจหมดอายุแล้ว กรุณาส่งไฟล์ใหม่ค่ะนาย", messageId);
    return;
  }

  const cache = results[0];

  // Mode: ถามเอง → send message for reply
  if (mode === "ask") {
    await sendTelegram(env, chatId,
      `💬 พิมพ์คำถามเกี่ยวกับไฟล์นี้ได้เลยค่ะนาย (reply ข้อความนี้)\n\n[fc:${cacheId}]`,
      messageId);
    return;
  }

  const noIntro = "[คำสั่งสำคัญ: ห้ามขึ้นต้นด้วย 'รับทราบ' 'สรุปให้ดังนี้' หรือเกริ่นนำใดๆ — เริ่มเนื้อหาทันที]";
  const fileLabel = `ไฟล์ ${cache.file_type.toUpperCase()}: ${cache.file_name || "unknown"}`;

  let prompt;
  let imageData = null;

  if (cache.file_type === "html") {
    const bodyText = cache.body_text || "";
    const prompts = {
      short: `${noIntro}\nสรุปเนื้อหาจากไฟล์นี้แบบกระชับ สั้นที่สุด 2-3 ประโยค:\n\n[${fileLabel}]\n\n--- เนื้อหา ---\n${bodyText}`,
      detail: `${noIntro}\nสรุปเนื้อหาจากไฟล์นี้อย่างละเอียดครบทุกประเด็นสำคัญ:\n\n[${fileLabel}]\n\n--- เนื้อหา ---\n${bodyText}`,
      analyze: `${noIntro}\nวิเคราะห์เนื้อหาจากไฟล์นี้เชิงลึก ระบุจุดแข็ง จุดอ่อน ข้อสังเกต และข้อควรระวัง:\n\n[${fileLabel}]\n\n--- เนื้อหา ---\n${bodyText}`,
    };
    prompt = prompts[mode];
  } else {
    // PDF / Image: re-download
    imageData = await downloadPhotoByFileId(env, cache.file_id);
    if (!imageData || imageData.error) {
      const typeLabel = cache.file_type === "image" ? "รูปภาพ" : "ไฟล์ PDF";
      await editPreview(`${originalText}\n\n❌ <b>ไม่สามารถดาวน์โหลด${typeLabel}ได้</b>`);
      await sendTelegram(env, chatId, `❌ ไม่สามารถดาวน์โหลด${typeLabel}ได้ค่ะนาย กรุณาส่งไฟล์ใหม่`, messageId);
      return;
    }
    const typeDesc = cache.file_type === "image" ? "รูปภาพ" : "ไฟล์ PDF";
    const prompts = {
      short: `${noIntro}\nสรุปเนื้อหาจาก${typeDesc}นี้แบบกระชับ สั้นที่สุด 2-3 ประโยค:\n\n[${fileLabel}]`,
      detail: `${noIntro}\nสรุปเนื้อหาจาก${typeDesc}นี้อย่างละเอียดครบทุกประเด็นสำคัญ:\n\n[${fileLabel}]`,
      analyze: `${noIntro}\nวิเคราะห์เนื้อหาจาก${typeDesc}นี้เชิงลึก ระบุจุดแข็ง จุดอ่อน ข้อสังเกต และข้อควรระวัง:\n\n[${fileLabel}]`,
    };
    prompt = prompts[mode];
  }

  try {
    await sendTyping(env, chatId);
    const context = await getSmartContext(env.DB, chatId, callbackQuery.message.chat.type === "private", "");
    const reply = await askGemini(env, prompt, context, imageData);
    const { cleanReply } = await parseAndExecuteActions(env, reply);
    if (cleanReply) {
      await sendTelegram(env, chatId, cleanReply, null, true);
    } else {
      await sendTelegram(env, chatId, "ขออภัยค่ะ ไม่สามารถประมวลผลไฟล์นี้ได้ กรุณาลองใหม่อีกครั้ง", null);
    }
    await editPreview(`${originalText}\n\n✅ <b>${modeLabels[mode]}แล้ว</b>`);
  } catch (err) {
    console.error("handleFileCallback Gemini error:", err.message, err.stack);
    await editPreview(`${originalText}\n\n❌ <b>เกิดข้อผิดพลาด</b> — ลองส่งไฟล์ใหม่ค่ะ`);
    await sendTelegram(env, chatId, "❌ เกิดข้อผิดพลาดในการประมวลผลค่ะนาย กรุณาลองใหม่", messageId);
  }
}

// ===== File Ask Handler (reply ถามเอง) =====

export async function handleFileAsk(env, message, cacheId, question) {
  const { results } = await env.DB.prepare(
    `SELECT file_type, file_name, body_text, file_id FROM file_cache WHERE id = ?`
  ).bind(cacheId).all();

  if (!results.length) {
    await sendTelegram(env, message.chat.id, "❌ ไม่พบข้อมูลไฟล์ อาจหมดอายุแล้ว กรุณาส่งไฟล์ใหม่ค่ะนาย", message.message_id);
    return;
  }

  const cache = results[0];
  await sendTyping(env, message.chat.id);

  const fileLabel = `ไฟล์ ${cache.file_type.toUpperCase()}: ${cache.file_name || "unknown"}`;
  let prompt;
  let imageData = null;

  if (cache.file_type === "html") {
    prompt = `ตอบคำถามเกี่ยวกับเนื้อหาไฟล์นี้:\n\n[${fileLabel}]\n\nคำถาม: ${question}\n\n--- เนื้อหา ---\n${cache.body_text || ""}`;
  } else {
    // PDF / Image: re-download
    imageData = await downloadPhotoByFileId(env, cache.file_id);
    if (!imageData || imageData.error) {
      const typeLabel = cache.file_type === "image" ? "รูปภาพ" : "ไฟล์ PDF";
      await sendTelegram(env, message.chat.id, `❌ ไม่สามารถดาวน์โหลด${typeLabel}ได้ค่ะนาย กรุณาส่งไฟล์ใหม่`, message.message_id);
      return;
    }
    const typeDesc = cache.file_type === "image" ? "รูปภาพ" : "ไฟล์ PDF";
    prompt = `ตอบคำถามเกี่ยวกับ${typeDesc}นี้:\n\n[${fileLabel}]\n\nคำถาม: ${question}`;
  }

  const context = await getSmartContext(env.DB, message.chat.id, message.chat.type === "private", "");
  const reply = await askGemini(env, prompt, context, imageData);
  const { cleanReply } = await parseAndExecuteActions(env, reply);
  if (cleanReply) {
    await sendTelegram(env, message.chat.id, cleanReply, message.message_id, true);
  } else {
    await sendTelegram(env, message.chat.id, "ขออภัยค่ะ ไม่สามารถตอบคำถามนี้ได้ ลองถามใหม่อีกครั้งนะคะ", message.message_id);
  }
}

// ===== /readvoice — Text-to-Speech Command =====

export async function handleReadvoiceCommand(env, message, args) {
  let ttsText = "";
  if (args) {
    ttsText = args;
  } else if (message.reply_to_message) {
    ttsText = message.reply_to_message.text || message.reply_to_message.caption || "";
  }
  if (!ttsText) {
    await sendTelegram(env, message.chat.id, "วิธีใช้:\n• /readvoice ข้อความ — พิมพ์ข้อความที่ต้องการให้อ่าน\n• reply ข้อความ แล้วพิมพ์ /readvoice — อ่านข้อความที่ reply", message.message_id);
    return;
  }
  await sendTyping(env, message.chat.id);
  const audio = await textToSpeech(env, ttsText);
  if (audio) {
    await sendVoice(env, message.chat.id, audio, message.message_id);
  } else {
    await sendTelegram(env, message.chat.id, "ไม่สามารถแปลงเป็นเสียงได้ค่ะนาย กรุณาตรวจสอบว่าเปิด Cloud TTS API แล้ว", message.message_id);
  }
}

// ===== /readlink — ดึงเนื้อหาจาก URL =====

function isPrivateUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase();
    // Only allow http/https schemes
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
    // Block private/internal hostnames
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
    if (hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
    // Block metadata endpoints
    if (hostname === "169.254.169.254" || hostname === "metadata.google.internal") return true;
    // Block IPv6 private ranges
    const bare = hostname.replace(/^\[|\]$/g, "");
    if (bare === "::1" || bare === "::") return true;
    if (bare.startsWith("fe80:")) return true;
    if ((bare.startsWith("fc") || bare.startsWith("fd")) && bare.includes(":")) return true;
    if (bare.startsWith("::ffff:")) return true; // IPv4-mapped IPv6
    // Block private IPv4 ranges
    const parts = hostname.split(".").map(Number);
    if (parts.length === 4 && parts.every(p => p >= 0 && p <= 255)) {
      if (parts[0] === 127) return true; // 127.0.0.0/8
      if (parts[0] === 10) return true; // 10.0.0.0/8
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
      if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16
      if (parts[0] === 169 && parts[1] === 254) return true; // 169.254.0.0/16
      if (parts[0] === 0) return true; // 0.0.0.0/8
    }
    return false;
  } catch { return true; }
}

export async function fetchUrlContent(url, _redirectCount = 0) {
  if (isPrivateUrl(url)) return { error: "URL ที่ระบุไม่อนุญาตค่ะ" };
  if (_redirectCount > 3) return { error: "Redirect มากเกินไปค่ะ" };

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; AIBot/1.0)",
      "Accept": "text/html,application/xhtml+xml,*/*",
    },
    redirect: "manual",
  });

  // Handle redirects — validate target before following
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location");
    if (!location) return { error: "Redirect ไม่มีปลายทางค่ะ" };
    const redirectUrl = new URL(location, url).href;
    if (isPrivateUrl(redirectUrl)) return { error: "URL ที่ระบุไม่อนุญาตค่ะ" };
    return fetchUrlContent(redirectUrl, _redirectCount + 1);
  }

  if (!response.ok) return { error: `HTTP ${response.status}` };

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    return { error: `ไม่รองรับ content-type: ${contentType}` };
  }

  const html = await response.text();
  const trimmedHtml = html.substring(0, 500_000);

  const title = extractMeta(trimmedHtml, /<title[^>]*>([^<]*)<\/title>/i)
    || extractMeta(trimmedHtml, /property="og:title"\s+content="([^"]*)"/i);
  const description = extractMeta(trimmedHtml, /property="og:description"\s+content="([^"]*)"/i)
    || extractMeta(trimmedHtml, /name="description"\s+content="([^"]*)"/i);
  const ogImage = extractMeta(trimmedHtml, /property="og:image"\s+content="([^"]*)"/i);
  const siteName = extractMeta(trimmedHtml, /property="og:site_name"\s+content="([^"]*)"/i);

  const bodyText = htmlToText(trimmedHtml);
  const truncatedText = bodyText.substring(0, 8000);

  return { title, description, ogImage, siteName, bodyText: truncatedText, url };
}

export async function handleReadlinkCommand(env, message, args) {
  try {
    let url = args.trim();
    if (!url && message.reply_to_message) {
      const replyText = message.reply_to_message.text || message.reply_to_message.caption || "";
      const urlMatch = replyText.match(/https?:\/\/[^\s]+/);
      if (urlMatch) url = urlMatch[0];
    }

    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      await sendTelegram(env, message.chat.id,
        "Usage: /readlink <url>\nหรือ reply ข้อความที่มีลิงก์แล้วพิมพ์ /readlink", message.message_id);
      return;
    }

    await sendTyping(env, message.chat.id);

    const result = await fetchUrlContent(url);
    if (result.error) {
      await sendTelegram(env, message.chat.id, `❌ ไม่สามารถอ่านลิงก์ได้: ${result.error}`, message.message_id);
      return;
    }

    if (!result.bodyText || result.bodyText.length <= 50) {
      await sendTelegram(env, message.chat.id,
        "⚠️ เว็บไซต์นี้มีเนื้อหาน้อยเกินไปหรือต้องล็อกอินก่อนค่ะนาย ไม่สามารถวิเคราะห์เพิ่มเติมได้", message.message_id);
      return;
    }

    // บันทึก cache
    const { meta } = await env.DB.prepare(
      `INSERT INTO readlink_cache (chat_id, url, title, body_text) VALUES (?, ?, ?, ?)`
    ).bind(message.chat.id, url, result.title || "", result.bodyText || "").run();
    const cacheId = meta.last_row_id;

    // แสดง preview + ปุ่มเลือก
    let preview = "🔗 <b>Link Preview</b>\n";
    if (result.title) preview += `📄 <b>${result.title}</b>\n`;
    if (result.siteName) preview += `🌐 ${result.siteName}\n`;
    if (result.description) preview += `📝 ${result.description}\n`;
    preview += `🔗 ${url}\n\nเลือกสิ่งที่ต้องการค่ะนาย:`;

    await sendTelegramWithKeyboard(env, message.chat.id, preview, message.message_id, [
      [
        { text: "📋 สรุปแบบสั้น", callback_data: `rl:short:${cacheId}` },
        { text: "📝 สรุปละเอียด", callback_data: `rl:detail:${cacheId}` },
      ],
      [
        { text: "🔍 วิเคราะห์", callback_data: `rl:analyze:${cacheId}` },
        { text: "💬 ถามเอง", callback_data: `rl:ask:${cacheId}` },
      ],
    ]);
  } catch (err) {
    console.error("handleReadlinkCommand error:", err.message, err.stack);
    await sendTelegram(env, message.chat.id, "❌ เกิดข้อผิดพลาดในการอ่านลิงก์ค่ะนาย", message.message_id);
  }
}

export async function handleReadlinkCallback(env, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  // Parse callback data: "rl:<mode>:<cacheId>"
  const parts = callbackQuery.data.split(":");
  const mode = parts[1];
  const cacheId = Number(parts[2]);

  const modeLabels = { short: "สรุปแบบสั้น", detail: "สรุปละเอียด", analyze: "วิเคราะห์", ask: "ถามเอง" };

  // Answer callback query พร้อมแสดง toast
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQuery.id,
      text: `⏳ กำลัง${modeLabels[mode]}...`,
    }),
  });

  // Escape originalText สำหรับ HTML (เพราะ .text เป็น plain text อาจมี & < > ใน URL/title)
  const originalText = (callbackQuery.message.text || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Helper: editMessageText สำหรับ update สถานะบน preview
  const editPreview = async (html) => {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: sanitizeHtml(html),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [] },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("editPreview failed:", err);
    }
    return res.ok;
  };

  // แก้ข้อความ preview — เปลี่ยนสถานะ + ลบปุ่ม (กันกดซ้ำ)
  const statusText = mode === "ask"
    ? `${originalText}\n\n💬 <b>โหมดถามเอง</b> — reply ข้อความถัดไปเพื่อถามค่ะ`
    : `${originalText}\n\n⏳ <b>กำลัง${modeLabels[mode]}...</b>`;
  const editOk = await editPreview(statusText);

  // ถ้า edit ไม่สำเร็จ = callback อื่นแก้ไปแล้ว (กดซ้ำ) → abort
  if (!editOk) return;

  // โหลด cache
  const { results } = await env.DB.prepare(
    `SELECT url, title, body_text FROM readlink_cache WHERE id = ?`
  ).bind(cacheId).all();

  if (!results.length || !results[0].body_text) {
    await editPreview(`${originalText}\n\n❌ <b>ไม่พบข้อมูลลิงก์ อาจหมดอายุแล้ว</b>`);
    await sendTelegram(env, chatId, "❌ ไม่พบข้อมูลลิงก์ อาจหมดอายุแล้ว กรุณาใช้ /readlink ใหม่ค่ะนาย", messageId);
    return;
  }

  const { url, title, body_text } = results[0];

  // Mode: ถามเอง → ส่งข้อความให้ reply
  if (mode === "ask") {
    await sendTelegram(env, chatId,
      `💬 พิมพ์คำถามเกี่ยวกับเนื้อหาลิงก์นี้ได้เลยค่ะนาย (reply ข้อความนี้)\n\n[rl:${cacheId}]`,
      messageId);
    return;
  }

  const noIntro = "[คำสั่งสำคัญ: ห้ามขึ้นต้นด้วย 'รับทราบ' 'สรุปให้ดังนี้' หรือเกริ่นนำใดๆ — เริ่มเนื้อหาทันที]";
  const prompts = {
    short: `${noIntro}\nสรุปเนื้อหาจากเว็บไซต์นี้แบบกระชับ สั้นที่สุด 2-3 ประโยค:\n\nURL: ${url}\nTitle: ${title || "N/A"}\n\n--- เนื้อหา ---\n${body_text}`,
    detail: `${noIntro}\nสรุปเนื้อหาจากเว็บไซต์นี้อย่างละเอียดครบทุกประเด็นสำคัญ:\n\nURL: ${url}\nTitle: ${title || "N/A"}\n\n--- เนื้อหา ---\n${body_text}`,
    analyze: `${noIntro}\nวิเคราะห์เนื้อหาจากเว็บไซต์นี้เชิงลึก ระบุจุดแข็ง จุดอ่อน ข้อสังเกต และข้อควรระวัง:\n\nURL: ${url}\nTitle: ${title || "N/A"}\n\n--- เนื้อหา ---\n${body_text}`,
  };

  try {
    await sendTyping(env, chatId);
    const context = await getSmartContext(env.DB, chatId, callbackQuery.message.chat.type === "private", "");
    const reply = await askGemini(env, prompts[mode], context, null);
    const { cleanReply } = await parseAndExecuteActions(env, reply);
    if (cleanReply) {
      await sendTelegram(env, chatId, cleanReply, null, true);
    } else {
      await sendTelegram(env, chatId, "ขออภัยค่ะ ไม่สามารถประมวลผลเนื้อหาลิงก์นี้ได้ กรุณาลองใหม่อีกครั้ง", null);
    }

    // อัพเดทสถานะเป็นเสร็จ
    await editPreview(`${originalText}\n\n✅ <b>${modeLabels[mode]}แล้ว</b>`);
  } catch (err) {
    console.error("handleReadlinkCallback Gemini error:", err.message, err.stack);
    await editPreview(`${originalText}\n\n❌ <b>เกิดข้อผิดพลาด</b> — ลองใช้ /readlink ใหม่ค่ะ`);
    await sendTelegram(env, chatId, "❌ เกิดข้อผิดพลาดในการประมวลผลค่ะนาย กรุณาลองใหม่", messageId);
  }
}

export async function handleReadlinkAsk(env, message, cacheId, question) {
  const { results } = await env.DB.prepare(
    `SELECT url, title, body_text FROM readlink_cache WHERE id = ?`
  ).bind(cacheId).all();

  if (!results.length || !results[0].body_text) {
    await sendTelegram(env, message.chat.id, "❌ ไม่พบข้อมูลลิงก์ อาจหมดอายุแล้ว กรุณาใช้ /readlink ใหม่ค่ะนาย", message.message_id);
    return;
  }

  const { url, title, body_text } = results[0];
  await sendTyping(env, message.chat.id);
  const prompt = `ตอบคำถามเกี่ยวกับเนื้อหาเว็บไซต์นี้:\n\nURL: ${url}\nTitle: ${title || "N/A"}\n\nคำถาม: ${question}\n\n--- เนื้อหา ---\n${body_text}`;
  const context = await getSmartContext(env.DB, message.chat.id, message.chat.type === "private", "");
  const reply = await askGemini(env, prompt, context, null);
  const { cleanReply } = await parseAndExecuteActions(env, reply);
  if (cleanReply) {
    await sendTelegram(env, message.chat.id, cleanReply, message.message_id, true);
  } else {
    await sendTelegram(env, message.chat.id, "ขออภัยค่ะ ไม่สามารถตอบคำถามนี้ได้ ลองถามใหม่อีกครั้งนะคะ", message.message_id);
  }
}
