import { ALLOWED_TAGS } from './constants.js';

export function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function sanitizeHtml(text) {
  // Step 1: Convert or strip unsupported tags
  text = text.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g, (match, tagName) => {
    if (ALLOWED_TAGS.has(tagName.toLowerCase())) return match;
    // Convert headings to bold
    if (/^h[1-6]$/i.test(tagName)) return match.startsWith("</") ? "</b>" : "<b>";
    // Strip all other unsupported tags (keep content)
    return "";
  });

  // Step 2: Auto-close unclosed tags using a stack
  const tagStack = [];
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g;
  let m;
  while ((m = tagRegex.exec(text)) !== null) {
    const full = m[0];
    const tagName = m[1].toLowerCase();
    if (!ALLOWED_TAGS.has(tagName)) continue;
    if (full.endsWith("/>")) continue; // self-closing
    if (full.startsWith("</")) {
      // closing tag — pop matching from stack
      const idx = tagStack.lastIndexOf(tagName);
      if (idx !== -1) tagStack.splice(idx, 1);
    } else {
      tagStack.push(tagName);
    }
  }

  // Close remaining open tags in reverse order
  for (let i = tagStack.length - 1; i >= 0; i--) {
    text += `</${tagStack[i]}>`;
  }

  return text;
}

// stripHtmlTags: remove all HTML tags and unescape entities (fallback)
export function stripHtmlTags(text) {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// balanceHtmlTags: for splitMessage — returns { closeTags, reopenTags } for a chunk
export function balanceHtmlTags(chunk) {
  const tagStack = [];
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g;
  let m;
  while ((m = tagRegex.exec(chunk)) !== null) {
    const full = m[0];
    const tagName = m[1].toLowerCase();
    if (!ALLOWED_TAGS.has(tagName)) continue;
    if (full.endsWith("/>")) continue;
    if (full.startsWith("</")) {
      const idx = tagStack.lastIndexOf(tagName);
      if (idx !== -1) tagStack.splice(idx, 1);
    } else {
      tagStack.push(tagName);
    }
  }

  // Close open tags (reverse order) for current chunk
  const closeTags = tagStack.slice().reverse().map(t => `</${t}>`).join("");
  // Reopen tags for next chunk (original order)
  const reopenTags = tagStack.map(t => `<${t}>`).join("");

  return { closeTags, reopenTags };
}

export function splitMessage(text, maxLength = 4096, isHtml = false) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;
  let pendingReopenTags = "";

  while (remaining.length > maxLength) {
    let cutAt = -1;

    // ลำดับการตัด: \n\n → \n → space → hard cut
    cutAt = remaining.lastIndexOf("\n\n", maxLength);
    if (cutAt <= 0) cutAt = remaining.lastIndexOf("\n", maxLength);
    if (cutAt <= 0) cutAt = remaining.lastIndexOf(" ", maxLength);
    if (cutAt <= 0) cutAt = maxLength;

    // HTML: ไม่ตัดกลาง tag (ระหว่าง < กับ >)
    if (isHtml) {
      const lastOpen = remaining.lastIndexOf("<", cutAt);
      const lastClose = remaining.lastIndexOf(">", cutAt);
      if (lastOpen > lastClose && lastOpen > 0) {
        cutAt = lastOpen;
      }
    }

    let chunk = remaining.slice(0, cutAt);
    remaining = remaining.slice(cutAt).replace(/^[\s\n]+/, "");

    // HTML: balance tags across chunks
    if (isHtml) {
      chunk = pendingReopenTags + chunk;
      const { closeTags, reopenTags } = balanceHtmlTags(chunk);
      chunk += closeTags;
      pendingReopenTags = reopenTags;
    }

    chunks.push(chunk);
  }

  if (remaining.length > 0) {
    if (isHtml) remaining = pendingReopenTags + remaining;

    // ถ้า chunk สุดท้ายเหลือน้อยกว่า 30% ให้รวมกับ chunk ก่อนหน้า (ถ้าไม่เกิน maxLength)
    if (
      chunks.length > 0 &&
      remaining.length < maxLength * 0.3 &&
      chunks[chunks.length - 1].length + remaining.length + 1 <= maxLength
    ) {
      chunks[chunks.length - 1] += "\n" + remaining;
    } else {
      chunks.push(remaining);
    }
  }

  return chunks;
}

export function formatLocation(location) {
  const urlMatch = location.match(/(https?:\/\/[^\s,]+)/);
  if (!urlMatch) return escapeHtml(location);

  const url = urlMatch[1];
  const rest = location.replace(url, '').replace(/^[,\s]+|[,\s]+$/g, '').trim();

  const link = `<a href="${escapeHtml(url)}">แผนที่</a>`;
  return rest ? `${link} ${escapeHtml(rest)}` : link;
}

export function truncateDesc(desc, maxLen = 60) {
  if (!desc) return "";
  const firstLine = desc.split('\n')[0];
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen) + '…';
}

export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function extractMeta(html, regex) {
  const match = html.match(regex);
  return match ? match[1].trim() : null;
}
