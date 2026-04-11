// Summary Alert — AI อ่าน daily summaries วันละ 1 ครั้ง (เช้า)
// ใช้ token น้อยมากเพราะอ่าน summary สั้นๆ แทนข้อความดิบ

import { sendTelegramWithKeyboard } from '../lib/telegram.js';
import { escapeHtml } from '../lib/html-utils.js';
import { logAIUsage } from '../secretary/ai-logger.js';

export async function summaryAlert(env) {
  try {
    // Only run between 8-10 AM Bangkok time
    const bangkokHour = new Date(Date.now() + 7 * 3600000).getUTCHours();
    if (bangkokHour < 7 || bangkokHour >= 10) return;

    // Dedup: check if already ran today
    const todayStr = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
    const alreadyRan = await env.DB.prepare(
      `SELECT id FROM alerts WHERE alert_hash = ? LIMIT 1`
    ).bind(`summary-alert-${todayStr}`).first();
    if (alreadyRan) return;

    const bossId = env.BOSS_USER_ID;
    const yesterday = new Date(Date.now() + 7 * 3600000 - 86400000).toISOString().slice(0, 10);

    // Get yesterday's daily summaries
    const { results: summaries } = await env.DB
      .prepare(
        `SELECT chat_id, chat_title, summary_text, message_count
         FROM summaries
         WHERE summary_type = 'daily' AND summary_date = ?
         ORDER BY message_count DESC`
      )
      .bind(yesterday)
      .all();

    if (summaries.length === 0) return;

    // Build compact context from summaries
    const summaryContext = summaries
      .map(s => `=== ${s.chat_title} (${s.message_count} msgs) ===\n${s.summary_text}`)
      .join("\n\n");

    // Ask Gemini Flash to find important items
    const prompt = `วิเคราะห์สรุปประจำวันจากทุกกลุ่ม หาเรื่องสำคัญที่บอสควรรู้

กฎ:
- เฉพาะเรื่องสำคัญจริงๆ เช่น ปัญหา, ตัวเลขผิดปกติ, เรื่องที่ต้องตัดสินใจ, ความเสี่ยง
- ถ้าไม่มีเรื่องสำคัญ ตอบแค่ "ไม่มี"
- ตอบ JSON array: [{"group":"ชื่อกลุ่ม","summary":"สรุปสั้นๆ","urgency":"high|medium|low"}]
- สูงสุด 5 รายการ
- ห้ามแต่งเรื่อง ต้องมาจากข้อมูลจริง`;

    const model = "gemini-2.5-flash";
    const startTime = Date.now();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: prompt }] },
        contents: [{ role: "user", parts: [{ text: summaryContext }] }],
        generationConfig: { maxOutputTokens: 1024 },
      }),
    });

    if (!response.ok) {
      console.error("Summary alert Gemini error:", response.status);
      return;
    }

    const data = await response.json();
    const usage = data.usageMetadata;
    const durationMs = Date.now() - startTime;

    // Log usage
    if (usage && env.DB) {
      logAIUsage(env.DB, {
        feature: 'summary_alert',
        model,
        inputTokens: usage.promptTokenCount || 0,
        outputTokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
        durationMs,
        success: true,
      });
    }

    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts) return;

    let text = "";
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].text && !parts[i].thought) { text = parts[i].text; break; }
    }
    if (!text) return;

    // Check if nothing important
    if (text.includes("ไม่มี") && text.length < 20) {
      // Mark as ran but don't send
      await env.DB.prepare(
        `INSERT INTO alerts (alert_hash, urgency, category, summary, status) VALUES (?, 'low', 'summary_alert', 'ไม่มีเรื่องสำคัญ', 'handled')`
      ).bind(`summary-alert-${todayStr}`).run();
      return;
    }

    // Parse JSON
    let alerts = [];
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) alerts = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error("Summary alert JSON parse error:", e.message);
      return;
    }

    if (alerts.length === 0) {
      await env.DB.prepare(
        `INSERT INTO alerts (alert_hash, urgency, category, summary, status) VALUES (?, 'low', 'summary_alert', 'ไม่มีเรื่องสำคัญ', 'handled')`
      ).bind(`summary-alert-${todayStr}`).run();
      return;
    }

    // Send alerts
    const esc = escapeHtml;
    const urgencyEmoji = { high: "🔴", medium: "🟡", low: "🟢" };

    let msg = `📋 <b>สรุปเรื่องสำคัญวันวาน</b> (${yesterday})\n\n`;
    for (const a of alerts) {
      const emoji = urgencyEmoji[a.urgency] || "🔵";
      msg += `${emoji} <b>${esc(a.group || "")}</b>\n${esc(a.summary || "")}\n\n`;
    }

    await sendTelegramWithKeyboard(env, bossId, msg, null, []);

    // Store dedup marker
    await env.DB.prepare(
      `INSERT INTO alerts (alert_hash, urgency, category, summary, status) VALUES (?, 'medium', 'summary_alert', ?, 'new')`
    ).bind(`summary-alert-${todayStr}`, msg.substring(0, 500)).run();

  } catch (err) {
    console.error("Summary alert error:", err);
  }
}
