import { sendTelegramWithKeyboard } from '../lib/telegram.js';
import { formatMessages } from '../lib/context.js';
import { escapeHtml } from '../lib/html-utils.js';

// Robust JSON parser: tries multiple strategies to extract JSON from AI response
export function parseAlertJson(text) {
  const strategies = [
    // Strategy 1: Direct JSON parse
    (t) => JSON.parse(t),
    // Strategy 2: Extract ```json ... ``` block
    (t) => {
      const m = t.match(/```json\s*([\s\S]*?)```/);
      return m ? JSON.parse(m[1]) : null;
    },
    // Strategy 3: Find first { ... } block
    (t) => {
      const start = t.indexOf("{");
      const end = t.lastIndexOf("}");
      if (start === -1 || end === -1 || end <= start) return null;
      return JSON.parse(t.substring(start, end + 1));
    },
    // Strategy 4: Fallback — parse legacy ALERT|pipe|format
    (t) => {
      const lines = t.split("\n").filter(l => l.startsWith("ALERT|"));
      if (lines.length === 0) return null;
      return {
        alerts: lines.map(line => {
          const parts = line.split("|");
          if (parts.length < 5) return null;
          const categoryMap = { "💰": "money", "⚠️": "problem", "💡": "info", "📋": "decision", "👥": "mention" };
          return {
            chat_id: null,
            urgency: "medium",
            category: categoryMap[parts[1].trim()] || "info",
            who: parts[2].trim(),
            summary: parts[3].trim(),
            group_title: parts[4].trim(),
            topic_fingerprint: parts[3].trim().substring(0, 50),
          };
        }).filter(Boolean)
      };
    },
  ];

  for (const strategy of strategies) {
    try {
      const result = strategy(text);
      if (result?.alerts?.length > 0) return result;
    } catch (e) { /* try next strategy */ }
  }
  return null;
}

export async function proactiveInsightAlert(env) {
  try {
    const bossId = env.BOSS_USER_ID;

    // Per-group message gathering: query groups from group_registry with priority_weight
    let groups;
    try {
      const { results: registeredGroups } = await env.DB
        .prepare(
          `SELECT chat_id, chat_title, priority_weight
           FROM group_registry
           WHERE is_active = 1 AND last_message_at > datetime('now', '-24 hours')
           ORDER BY priority_weight DESC`
        )
        .all();
      groups = registeredGroups;
    } catch (e) {
      // Fallback if group_registry doesn't exist yet (pre-migration)
      groups = null;
    }

    let messageContext = "";
    const chatIdMap = {}; // chat_id → title mapping

    if (groups && groups.length > 0) {
      // Per-group gathering with priority-based limits
      for (const group of groups) {
        const weight = group.priority_weight || 1.0;
        const limit = weight >= 2.0 ? 150 : weight >= 1.0 ? 80 : 30;
        const { results: msgs } = await env.DB
          .prepare(
            `SELECT username, first_name, message_text, chat_title, chat_id,
                    datetime(created_at, '+7 hours') as created_at
             FROM messages
             WHERE chat_id = ? AND created_at > datetime('now', '-4 hours')
             ORDER BY created_at ASC LIMIT ?`
          )
          .bind(group.chat_id, limit)
          .all();

        if (msgs.length === 0) continue;

        const title = msgs[0].chat_title || group.chat_title || "Unknown";
        chatIdMap[group.chat_id] = title;
        messageContext += `=== กลุ่ม: ${title} (chat_id: ${group.chat_id}) ===\n`;
        for (const msg of msgs) {
          const name = msg.username ? `@${msg.username}` : msg.first_name || "Unknown";
          messageContext += `[${msg.created_at}] ${name}: ${msg.message_text}\n`;
        }
        messageContext += "\n";
      }
    } else {
      // Fallback: flat query (pre-migration compatibility)
      const { results } = await env.DB
        .prepare(
          `SELECT username, first_name, message_text, chat_title, chat_id,
                  datetime(created_at, '+7 hours') as created_at
           FROM messages
           WHERE chat_title IS NOT NULL AND created_at > datetime('now', '-4 hours')
           ORDER BY created_at ASC LIMIT 300`
        )
        .all();

      if (results.length === 0) return;

      const byGroup = {};
      for (const msg of results) {
        if (!byGroup[msg.chat_id]) byGroup[msg.chat_id] = { title: msg.chat_title, msgs: [] };
        byGroup[msg.chat_id].msgs.push(msg);
      }

      for (const [cid, group] of Object.entries(byGroup)) {
        chatIdMap[cid] = group.title;
        messageContext += `=== กลุ่ม: ${group.title} (chat_id: ${cid}) ===\n`;
        for (const msg of group.msgs) {
          const name = msg.username ? `@${msg.username}` : msg.first_name || "Unknown";
          messageContext += `[${msg.created_at}] ${name}: ${msg.message_text}\n`;
        }
        messageContext += "\n";
      }
    }

    if (!messageContext) return;

    // ดึง memories เป็น context เสริม
    const { results: memories } = await env.DB
      .prepare(`SELECT content, category FROM memories WHERE priority = 'hot' ORDER BY created_at DESC LIMIT 30`)
      .all();

    if (memories.length > 0) {
      messageContext += "=== ความจำถาวร ===\n";
      messageContext += memories.map((m) => `(${m.category}) ${m.content}`).join("\n");
    }

    // ดึง recent alerts เพื่อป้องกัน dedup
    let recentAlertContext = "";
    try {
      const { results: recentAlerts } = await env.DB
        .prepare(
          `SELECT topic_fingerprint, summary, chat_title, created_at
           FROM alerts
           WHERE created_at > datetime('now', '-12 hours')
           ORDER BY created_at DESC LIMIT 20`
        )
        .all();
      if (recentAlerts.length > 0) {
        recentAlertContext = "\n\n=== ALERTS ที่แจ้งไปแล้ว (ห้ามแจ้งซ้ำ) ===\n";
        recentAlertContext += recentAlerts.map(a =>
          `- [${a.chat_title}] ${a.summary} (fingerprint: ${a.topic_fingerprint})`
        ).join("\n");
      }
    } catch (e) { /* alerts table may not exist yet */ }

    // ดึง boss feedback context
    let feedbackContext = "";
    try {
      const { results: groupStats } = await env.DB
        .prepare(
          `SELECT g.chat_title, g.priority_weight,
                  COUNT(CASE WHEN a.status IN ('analyzing','handled') THEN 1 END) as analyzed,
                  COUNT(CASE WHEN a.status = 'dismissed' THEN 1 END) as dismissed
           FROM group_registry g
           LEFT JOIN alerts a ON g.chat_id = a.chat_id AND a.created_at > datetime('now', '-7 days')
           WHERE g.is_active = 1
           GROUP BY g.chat_id
           HAVING analyzed + dismissed > 0
           ORDER BY g.priority_weight DESC`
        )
        .all();
      if (groupStats.length > 0) {
        feedbackContext = "\n\n=== Boss feedback pattern ===\n";
        feedbackContext += groupStats.map(s =>
          `${s.chat_title}: weight=${s.priority_weight}, วิเคราะห์=${s.analyzed}ครั้ง, ปัดทิ้ง=${s.dismissed}ครั้ง`
        ).join("\n");
      }
    } catch (e) { /* ignore */ }

    // ใช้ Gemini วิเคราะห์หาเรื่องสำคัญ — JSON output format
    const insightBossTitle = env.BOSS_TITLE || "นาย";
    const analysisPrompt = `คุณคือ ${env.BOT_NAME || "Friday"} AI ผู้ช่วยส่วนตัว ทำหน้าที่เฝ้าดูบทสนทนาในกลุ่มต่างๆ ของ${insightBossTitle} (บอส)

วิเคราะห์ข้อความล่าสุดด้านล่าง หาเรื่องสำคัญที่${insightBossTitle}ควรรู้

ประเภทและ urgency:
- 🔴 critical — ระบบล่ม, เงินหาย, เรื่องด่วนสุด (category: "problem" หรือ "money")
- 🟠 high — deadline, ลูกค้าร้องเรียน, ต้องตัดสินใจเร่ง (category: "decision" หรือ "problem")
- 🟡 medium — update สำคัญ, รอตัดสินใจ (category: "info" หรือ "decision")
- 🟢 low — FYI, ข้อมูลทั่วไปที่ควรรู้ (category: "info" หรือ "mention")

ถ้าไม่มีเรื่องสำคัญเลย ตอบแค่ NONE

ถ้ามี ตอบเป็น JSON เท่านั้น:
\`\`\`json
{
  "alerts": [
    {
      "chat_id": -100xxx,
      "urgency": "critical|high|medium|low",
      "category": "money|problem|decision|info|mention",
      "who": "username",
      "summary": "สรุปสั้นๆ",
      "topic_fingerprint": "คำสำคัญ 3-5 คำ เช่น server-down-db-replica"
    }
  ]
}
\`\`\`

กฎ:
- chat_id ต้องตรงกับที่ระบุใน header ของแต่ละกลุ่ม
- สรุปให้กระชับ ไม่เกิน 2 ประโยค
- เฉพาะเรื่องที่${insightBossTitle}ต้องรู้จริงๆ ไม่ใช่บทสนทนาทั่วไป
- ห้ามแต่งเรื่อง ต้องอ้างอิงจากข้อมูลจริง
- ชื่อคนให้ใช้ username หรือ first_name ตามที่ปรากฏ
- topic_fingerprint ต้องเป็น keyword ภาษาอังกฤษ ใช้ - คั่น
- ห้ามแจ้งเรื่องที่อยู่ในรายการ "ALERTS ที่แจ้งไปแล้ว"`;

    const model = "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: analysisPrompt }] },
        contents: [{ role: "user", parts: [{ text: messageContext + recentAlertContext + feedbackContext }] }],
        generationConfig: { maxOutputTokens: 2048 },
      }),
    });

    if (!response.ok) {
      console.error("Proactive insight Gemini error:", response.status);
      return;
    }

    const data = await response.json();
    const responseParts = data.candidates?.[0]?.content?.parts;
    if (!responseParts) return;

    // หา text part ที่ไม่ใช่ thought
    let replyText = null;
    for (let i = responseParts.length - 1; i >= 0; i--) {
      if (responseParts[i].text && !responseParts[i].thought) {
        replyText = responseParts[i].text;
        break;
      }
    }

    if (!replyText || replyText.trim() === "NONE") return;

    // Parse JSON response (with fallback strategies)
    const parsed = parseAlertJson(replyText);
    if (!parsed?.alerts?.length) return;

    // Urgency sorting: critical → high → medium → low
    const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    parsed.alerts.sort((a, b) => (urgencyOrder[a.urgency] ?? 3) - (urgencyOrder[b.urgency] ?? 3));

    const urgencyEmoji = { critical: "🔴", high: "🟠", medium: "🟡", low: "🟢" };
    const categoryEmoji = { money: "💰", problem: "⚠️", decision: "📋", info: "💡", mention: "👥" };
    const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    for (const alert of parsed.alerts) {
      // Resolve chat_id: use AI-provided or try to match group_title
      let groupChatId = alert.chat_id ? String(alert.chat_id) : null;
      let groupTitle = "";

      if (groupChatId && chatIdMap[groupChatId]) {
        groupTitle = chatIdMap[groupChatId];
      } else if (alert.group_title) {
        // Legacy fallback: try to match by title
        for (const [cid, title] of Object.entries(chatIdMap)) {
          if (title === alert.group_title) {
            groupChatId = cid;
            groupTitle = title;
            break;
          }
        }
      }

      if (!groupChatId) continue;
      if (!groupTitle) groupTitle = alert.group_title || "Unknown";

      // Dedup: check topic_fingerprint in last 12 hours
      if (alert.topic_fingerprint) {
        try {
          const { results: dupes } = await env.DB
            .prepare(
              `SELECT id FROM alerts
               WHERE topic_fingerprint = ? AND created_at > datetime('now', '-12 hours')
               LIMIT 1`
            )
            .bind(alert.topic_fingerprint)
            .all();
          if (dupes.length > 0) continue; // skip duplicate
        } catch (e) { /* alerts table may not exist yet */ }
      }

      // Store alert in DB
      let alertId = 0;
      const alertHash = `insight-${groupChatId}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      try {
        const insertResult = await env.DB
          .prepare(
            `INSERT INTO alerts (alert_hash, chat_id, chat_title, urgency, category, who, summary, topic_fingerprint, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')`
          )
          .bind(
            alertHash,
            Number(groupChatId),
            groupTitle,
            alert.urgency || "medium",
            alert.category || "info",
            alert.who || null,
            alert.summary,
            alert.topic_fingerprint || null,
          )
          .run();
        alertId = insertResult.meta?.last_row_id || 0;
      } catch (e) { console.error("Alert insert error:", e); }

      // Build alert message with urgency visual
      const uEmoji = urgencyEmoji[alert.urgency] || "🟡";
      const cEmoji = categoryEmoji[alert.category] || "💡";
      const urgencyLabel = alert.urgency === "critical" ? " <b>URGENT</b>" : "";
      const alertMsg = `${uEmoji}${urgencyLabel} Proactive Alert ${cEmoji}\n\n${cEmoji} ${esc(alert.who || "")}: ${esc(alert.summary)}\n\n📁 กลุ่ม: ${esc(groupTitle)}`;

      await sendTelegramWithKeyboard(env, bossId, alertMsg, null, [
        [
          { text: "📋 วิเคราะห์สั้น", callback_data: `pa:s:${groupChatId}:${alertId}` },
          { text: "📝 วิเคราะห์ละเอียด", callback_data: `pa:d:${groupChatId}:${alertId}` },
        ],
        [
          { text: "✅ จัดการแล้ว", callback_data: `pa:h:${groupChatId}:${alertId}` },
          { text: "❌ ไม่สำคัญ", callback_data: `pa:x:${groupChatId}:${alertId}` },
        ],
      ]);
    }

    // Expire old unhandled alerts (>24h)
    try {
      await env.DB.prepare(
        `UPDATE alerts SET status = 'expired' WHERE status = 'new' AND created_at < datetime('now', '-24 hours')`
      ).run();
    } catch (e) { /* ignore */ }

  } catch (err) {
    console.error("Proactive insight alert error:", err);
  }
}
