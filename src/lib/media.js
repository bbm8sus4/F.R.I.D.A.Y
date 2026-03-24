import { MAX_PDF_SIZE } from './constants.js';
import { htmlToText } from './html-utils.js';

export async function downloadPhotoByFileId(env, fileId) {
  try {
    const fileRes = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
    );
    const fileData = await fileRes.json();
    if (!fileData.ok) {
      console.error("getFile failed:", JSON.stringify(fileData));
      return null;
    }

    // เช็คขนาดไฟล์ก่อนดาวน์โหลด (สำหรับ PDF ขนาดใหญ่)
    if (fileData.result.file_size && fileData.result.file_size > MAX_PDF_SIZE) {
      return { error: "FILE_TOO_LARGE", size: fileData.result.file_size };
    }

    const filePath = fileData.result.file_path;
    const imageRes = await fetch(
      `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`
    );
    if (!imageRes.ok) {
      console.error("File download HTTP error:", imageRes.status);
      return null;
    }

    const arrayBuffer = await imageRes.arrayBuffer();
    // Chunked base64 conversion (faster than byte-by-byte)
    const bytes = new Uint8Array(arrayBuffer);
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 0x8000) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
    }
    const base64 = btoa(chunks.join(""));

    const ext = filePath.split(".").pop().toLowerCase();
    const mimeMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", pdf: "application/pdf" };
    return { base64, mimeType: mimeMap[ext] || "image/jpeg" };
  } catch (err) {
    console.error("Photo download error:", err.message, err.stack);
    return null;
  }
}

export async function downloadHtmlFile(env, fileId) {
  try {
    const fileRes = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
    );
    const fileData = await fileRes.json();
    if (!fileData.ok) {
      console.error("getFile failed (HTML):", JSON.stringify(fileData));
      return null;
    }

    const filePath = fileData.result.file_path;
    const fileResponse = await fetch(
      `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`
    );
    if (!fileResponse.ok) {
      console.error("HTML file download HTTP error:", fileResponse.status);
      return null;
    }

    const arrayBuffer = await fileResponse.arrayBuffer();
    const rawHtml = new TextDecoder("utf-8").decode(arrayBuffer);
    const text = htmlToText(rawHtml);
    const fileName = filePath.split("/").pop() || "file.html";
    return { text, fileName };
  } catch (err) {
    console.error("HTML download error:", err.message, err.stack);
    return null;
  }
}

export function getPhotoFileId(message) {
  if (!message) return null;
  // PDF ที่ส่งเป็นไฟล์
  if (message.document?.mime_type === "application/pdf") {
    return message.document.file_id;
  }
  // HTML document
  if (message.document?.mime_type === "text/html") {
    return message.document.file_id;
  }
  // รูปที่ส่งแบบ compressed (photo)
  if (message.photo?.length) {
    return message.photo[message.photo.length - 1].file_id;
  }
  // รูปที่ส่งเป็นไฟล์ (document) เช่น .png, .jpg
  if (message.document?.mime_type?.startsWith("image/")) {
    return message.document.file_id;
  }
  return null;
}

export async function getRecentPhoto(env, chatId, currentMsgId) {
  try {
    const { results } = await env.DB
      .prepare(
        `SELECT photo_file_id FROM messages
         WHERE chat_id = ? AND message_id < ? AND photo_file_id IS NOT NULL
         AND created_at > datetime('now', '-5 minutes')
         ORDER BY message_id DESC LIMIT 1`
      )
      .bind(chatId, currentMsgId)
      .all();

    if (!results.length || !results[0].photo_file_id) return null;
    return await downloadPhotoByFileId(env, results[0].photo_file_id);
  } catch (err) {
    console.error("getRecentPhoto error:", err);
    return null;
  }
}
