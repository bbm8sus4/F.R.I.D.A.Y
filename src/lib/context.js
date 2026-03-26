import { STOP_WORDS } from './constants.js';
import { getPhotoFileId } from './media.js';
import { listEvents, isCalendarConfigured } from './google-calendar.js';

export async function storeMessage(db, message, text, hasMedia) {
  try {
    const hasPdf = message.document?.mime_type === "application/pdf";
    const hasHtml = message.document?.mime_type === "text/html";
    const hasPhoto = !!(message.photo?.length > 0 || message.document?.mime_type?.startsWith("image/"));
    const storeText = hasHtml && !text ? "[HTML]" : hasHtml ? `[HTML] ${text}` : hasPdf && !text ? "[PDF]" : hasPdf ? `[PDF] ${text}` : hasPhoto && !text ? "[รูปภาพ]" : hasPhoto ? `[รูปภาพ] ${text}` : text;
    const photoFileId = hasMedia ? getPhotoFileId(message) : null;
    await db
      .prepare(
        `INSERT INTO messages (chat_id, chat_title, user_id, username, first_name, message_text, message_id, reply_to_message_id, photo_file_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        message.chat.id,
        message.chat.title || null,
        message.from.id,
        message.from.username || null,
        message.from.first_name || null,
        storeText,
        message.message_id,
        message.reply_to_message?.message_id || null,
        photoFileId
      )
      .run();

    // Upsert group_registry for group chats
    if (message.chat.title) {
      await db
        .prepare(
          `INSERT INTO group_registry (chat_id, chat_title, last_message_at, is_active)
           VALUES (?, ?, CURRENT_TIMESTAMP, 1)
           ON CONFLICT(chat_id) DO UPDATE SET
             chat_title = excluded.chat_title,
             last_message_at = CURRENT_TIMESTAMP,
             is_active = 1`
        )
        .bind(message.chat.id, message.chat.title)
        .run();
    }
  } catch (err) {
    console.error("DB insert error:", err);
  }
}

export function extractKeywords(text) {
  const words = text
    .toLowerCase()
    .replace(/[^\u0E00-\u0E7Fa-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
  return [...new Set(words)].slice(0, 5);
}

export function parseDateRange(text) {
  const thaiMonths = {
    'มกรา': '01', 'มกราคม': '01', 'ม.ค.': '01', 'ม.ค': '01',
    'กุมภา': '02', 'กุมภาพันธ์': '02', 'ก.พ.': '02', 'ก.พ': '02',
    'มีนา': '03', 'มีนาคม': '03', 'มี.ค.': '03', 'มี.ค': '03',
    'เมษา': '04', 'เมษายน': '04', 'เม.ย.': '04', 'เม.ย': '04',
    'พฤษภา': '05', 'พฤษภาคม': '05', 'พ.ค.': '05', 'พ.ค': '05',
    'มิถุนา': '06', 'มิถุนายน': '06', 'มิ.ย.': '06', 'มิ.ย': '06',
    'กรกฎา': '07', 'กรกฎาคม': '07', 'ก.ค.': '07', 'ก.ค': '07',
    'สิงหา': '08', 'สิงหาคม': '08', 'ส.ค.': '08', 'ส.ค': '08',
    'กันยา': '09', 'กันยายน': '09', 'ก.ย.': '09', 'ก.ย': '09',
    'ตุลา': '10', 'ตุลาคม': '10', 'ต.ค.': '10', 'ต.ค': '10',
    'พฤศจิกา': '11', 'พฤศจิกายน': '11', 'พ.ย.': '11', 'พ.ย': '11',
    'ธันวา': '12', 'ธันวาคม': '12', 'ธ.ค.': '12', 'ธ.ค': '12',
  };
  const monthNames = Object.keys(thaiMonths).sort((a, b) => b.length - a.length);
  const monthPattern = monthNames.map(m => m.replace(/\./g, '\\.')).join('|');

  // Range: "18 ถึง 23 มีนาคม" or "18-23 มี.ค."
  const rangeRegex = new RegExp(`(\\d{1,2})\\s*(?:ถึง|-|–|~)\\s*(\\d{1,2})\\s*(${monthPattern})`);
  const rangeMatch = text.match(rangeRegex);
  if (rangeMatch) {
    const month = thaiMonths[rangeMatch[3]];
    const year = new Date().getFullYear();
    return {
      startDate: `${year}-${month}-${rangeMatch[1].padStart(2, '0')}`,
      endDate: `${year}-${month}-${rangeMatch[2].padStart(2, '0')}`,
    };
  }

  // Single date: "18 มีนาคม"
  const singleRegex = new RegExp(`(\\d{1,2})\\s*(${monthPattern})`);
  const singleMatch = text.match(singleRegex);
  if (singleMatch) {
    const month = thaiMonths[singleMatch[2]];
    const year = new Date().getFullYear();
    const date = `${year}-${month}-${singleMatch[1].padStart(2, '0')}`;
    return { startDate: date, endDate: date };
  }

  return null;
}

export function formatMessages(rows) {
  return rows
    .map((row) => {
      const name = row.username ? `@${row.username}` : row.first_name || "Unknown";
      const group = row.chat_title ? `[${row.chat_title}]` : "[DM]";
      return `[${row.created_at}] ${group} ${name}: ${row.message_text}`;
    })
    .join("\n");
}

export async function getSmartContext(db, chatId, isDM, userQuery, env) {
  // ===== Batch 1 — ดึงทุกครั้ง (1 round-trip) =====
  const memoriesStmt = db.prepare(
    `SELECT id, content, category, priority, created_at FROM memories
     WHERE priority = 'hot'
     ORDER BY created_at DESC LIMIT 50`
  );
  const tasksStmt = db.prepare(
    `SELECT id, description, status, due_on, datetime(created_at, '+7 hours') as created_at
     FROM tasks WHERE status = 'pending'
     ORDER BY
       CASE WHEN due_on IS NOT NULL THEN 0 ELSE 1 END,
       due_on ASC, created_at ASC
     LIMIT 10`
  );
  const recentDoneStmt = db.prepare(
    `SELECT id, description, result, datetime(completed_at, '+7 hours') as completed_at
     FROM tasks WHERE status = 'done' AND completed_at > datetime('now', '-24 hours')
     ORDER BY completed_at DESC LIMIT 5`
  );

  let batchStmts;
  if (isDM) {
    batchStmts = [
      memoriesStmt,
      // DM: ข้อความล่าสุด 2 ชม. จากทุกกลุ่ม
      db.prepare(
        `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at, chat_title, chat_id
         FROM messages
         WHERE chat_title IS NOT NULL AND created_at > datetime('now', '-2 hours')
         ORDER BY created_at ASC
         LIMIT 100`
      ),
      tasksStmt,
      recentDoneStmt,
    ];
  } else {
    batchStmts = [
      memoriesStmt,
      // Group: ข้อความล่าสุด 2 ชม. กลุ่มนี้
      db.prepare(
        `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at, chat_title FROM messages
         WHERE chat_id = ? AND created_at > datetime('now', '-2 hours')
         ORDER BY created_at ASC LIMIT 100`
      ).bind(chatId),
      tasksStmt,
      recentDoneStmt,
    ];
  }

  const batchResults = await db.batch(batchStmts);

  const memories = batchResults[0].results;

  let context = "";

  if (memories.length > 0) {
    context += "=== คำสั่ง/ความจำถาวรจากบอส (hot) ===\n";
    context += memories.map((m) => `[#${m.id}] (${m.category}) ${m.content}`).join("\n");
    context += "\n\n";
  }

  if (isDM) {
    const allRecent = batchResults[1].results;
    if (allRecent.length > 0) {
      const byGroup = {};
      for (const msg of allRecent) {
        const key = msg.chat_id;
        if (!byGroup[key]) byGroup[key] = { title: msg.chat_title, chatId: msg.chat_id, msgs: [] };
        byGroup[key].msgs.push(msg);
      }
      for (const group of Object.values(byGroup)) {
        context += `=== กลุ่ม: ${group.title} (chat_id: ${group.chatId}) (ล่าสุด 2 ชม.) ===\n`;
        context += formatMessages(group.msgs);
        context += "\n\n";
      }
    }
  } else {
    const recent = batchResults[1].results;
    if (recent.length > 0) {
      context += "=== บทสนทนาล่าสุด 2 ชม. (กลุ่มนี้) ===\n";
      context += formatMessages(recent);
      context += "\n\n";
    }
  }

  // Tasks — เฉพาะ DM เท่านั้น ห้ามโชว์ในกลุ่ม
  if (isDM) {
    const todayStr = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
    const activeTasks = batchResults[2].results;
    if (activeTasks.length > 0) {
      context += "=== Tasks ที่ยังไม่เสร็จ ===\n";
      context += activeTasks
        .map(t => {
          let line = `- Task #${t.id} (สร้าง: ${t.created_at}): "${t.description}"`;
          if (t.due_on) {
            if (t.due_on < todayStr) line += ` [🔴 เลยกำหนด: ${t.due_on}]`;
            else line += ` [📅 กำหนด: ${t.due_on}]`;
          }
          return line;
        })
        .join("\n");
      context += "\n\n";
    }

    const recentDone = batchResults[3].results;
    if (recentDone.length > 0) {
      context += "=== Tasks ที่เสร็จล่าสุด (24 ชม.) ===\n";
      context += recentDone
        .map(t => {
          let line = `- Task #${t.id}: "${t.description}"`;
          if (t.result) line += ` → "${t.result}"`;
          line += ` (เสร็จ: ${t.completed_at})`;
          return line;
        })
        .join("\n");
      context += "\n\n";
    }
  }

  // ===== Calendar — ดึงนัดหมาย 7 วันข้างหน้า (ถ้า configured) =====
  if (isDM && env && isCalendarConfigured(env)) {
    try {
      const now = new Date();
      const bangkokNow = new Date(now.getTime() + 7 * 3600000);
      const todayStr = bangkokNow.toISOString().slice(0, 10);
      const next7 = new Date(bangkokNow);
      next7.setUTCDate(next7.getUTCDate() + 7);
      const endStr = next7.toISOString().slice(0, 10);
      const events = await listEvents(env, `${todayStr}T00:00:00+07:00`, `${endStr}T23:59:59+07:00`, 15);
      if (events.length > 0) {
        context += "=== ปฏิทินนัดหมาย (7 วันข้างหน้า) ===\n";
        for (const e of events) {
          const timeStr = e.time === "ทั้งวัน" ? "ทั้งวัน" : `${e.time}-${e.endTime}`;
          context += `📅 ${e.date} ${timeStr} — ${e.title} [eventId:${e.id}]\n`;
        }
        context += "\n";
      }
    } catch (calErr) {
      console.error("Calendar context fetch failed (non-fatal):", calErr.message);
    }
  }

  // ===== Batch 2 — ดึงเมื่อมี keywords (1 round-trip) =====
  try {
    const keywords = extractKeywords(userQuery || "");
    if (keywords.length > 0) {
      const likeConditions = keywords.map(() => "message_text LIKE ?").join(" OR ");
      const likeParams = keywords.map(k => `%${k}%`);

      const memLikeConditions = keywords.map(() => "content LIKE ?").join(" OR ");
      const sumLikeConditions = keywords.map(() => "summary_text LIKE ?").join(" OR ");

      const batch2Stmts = [];

      // keyword-matched messages ใน 7 วัน (สูงสุด 30 แถว)
      if (isDM) {
        batch2Stmts.push(
          db.prepare(
            `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at, chat_title
             FROM messages
             WHERE chat_title IS NOT NULL AND created_at > datetime('now', '-7 days')
               AND created_at <= datetime('now', '-2 hours')
               AND (${likeConditions})
             ORDER BY created_at DESC LIMIT 30`
          ).bind(...likeParams)
        );
      } else {
        batch2Stmts.push(
          db.prepare(
            `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at, chat_title
             FROM messages
             WHERE chat_id = ? AND created_at > datetime('now', '-7 days')
               AND created_at <= datetime('now', '-2 hours')
               AND (${likeConditions})
             ORDER BY created_at DESC LIMIT 30`
          ).bind(chatId, ...likeParams)
        );
      }

      // warm/cold memories ที่เกี่ยว (สูงสุด 20 อัน)
      batch2Stmts.push(
        db.prepare(
          `SELECT id, content, category, priority, created_at FROM memories
           WHERE priority != 'hot' AND (${memLikeConditions})
           ORDER BY created_at DESC LIMIT 20`
        ).bind(...likeParams)
      );

      // summaries ที่เกี่ยว (สูงสุด 8 อัน)
      if (isDM) {
        batch2Stmts.push(
          db.prepare(
            `SELECT chat_title, week_start, week_end, summary_text,
                    COALESCE(summary_date, week_end) as summary_date,
                    COALESCE(summary_type, 'weekly') as summary_type
             FROM summaries
             WHERE (${sumLikeConditions})
             ORDER BY COALESCE(summary_date, week_end) DESC LIMIT 8`
          ).bind(...likeParams)
        );
      } else {
        batch2Stmts.push(
          db.prepare(
            `SELECT chat_title, week_start, week_end, summary_text,
                    COALESCE(summary_date, week_end) as summary_date,
                    COALESCE(summary_type, 'weekly') as summary_type
             FROM summaries
             WHERE (${sumLikeConditions}) AND chat_id = ?
             ORDER BY COALESCE(summary_date, week_end) DESC LIMIT 8`
          ).bind(...likeParams, chatId)
        );
      }

      const batch2Results = await db.batch(batch2Stmts);

      const keywordMessages = batch2Results[0].results;
      const warmColdMemories = batch2Results[1].results;
      const relatedSummaries = batch2Results[2].results;

      if (keywordMessages.length > 0) {
        context += "=== ข้อความที่เกี่ยวข้อง (keyword search) ===\n";
        context += formatMessages(keywordMessages.reverse());
        context += "\n\n";
      }

      if (warmColdMemories.length > 0) {
        context += "=== ความจำเพิ่มเติม (warm/cold) ===\n";
        context += warmColdMemories.map((m) => `[#${m.id}] (${m.category}|${m.priority}) ${m.content}`).join("\n");
        context += "\n\n";
      }

      if (relatedSummaries.length > 0) {
        context += "=== สรุปบทสนทนาย้อนหลัง ===\n";
        context += relatedSummaries
          .map((s) => {
            const typeLabel = s.summary_type === "daily" ? "daily" : "weekly";
            return `[${s.chat_title} | ${s.summary_date} (${typeLabel})]\n${s.summary_text}`;
          })
          .join("\n\n");
        context += "\n\n";
      }
    }
  } catch (kwErr) {
    console.error("Keyword search failed (non-fatal):", kwErr.message);
  }

  // ===== Batch 3 — ดึงตามช่วงวันที่ถ้าผู้ใช้ระบุ =====
  try {
    const dateRange = parseDateRange(userQuery || "");
    if (dateRange) {
      const dateStmts = [];
      if (isDM) {
        dateStmts.push(
          db.prepare(
            `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at, chat_title
             FROM messages
             WHERE chat_title IS NOT NULL
               AND date(created_at, '+7 hours') >= ? AND date(created_at, '+7 hours') <= ?
             ORDER BY created_at ASC LIMIT 200`
          ).bind(dateRange.startDate, dateRange.endDate)
        );
        dateStmts.push(
          db.prepare(
            `SELECT chat_title, summary_text, COALESCE(summary_date, week_end) as summary_date,
                    COALESCE(summary_type, 'weekly') as summary_type
             FROM summaries
             WHERE COALESCE(summary_date, week_end) >= ? AND COALESCE(summary_date, week_end) <= ?
             ORDER BY COALESCE(summary_date, week_end) ASC LIMIT 20`
          ).bind(dateRange.startDate, dateRange.endDate)
        );
      } else {
        dateStmts.push(
          db.prepare(
            `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at, chat_title
             FROM messages
             WHERE chat_id = ?
               AND date(created_at, '+7 hours') >= ? AND date(created_at, '+7 hours') <= ?
             ORDER BY created_at ASC LIMIT 200`
          ).bind(chatId, dateRange.startDate, dateRange.endDate)
        );
        dateStmts.push(
          db.prepare(
            `SELECT chat_title, summary_text, COALESCE(summary_date, week_end) as summary_date,
                    COALESCE(summary_type, 'weekly') as summary_type
             FROM summaries
             WHERE chat_id = ? AND COALESCE(summary_date, week_end) >= ? AND COALESCE(summary_date, week_end) <= ?
             ORDER BY COALESCE(summary_date, week_end) ASC LIMIT 20`
          ).bind(chatId, dateRange.startDate, dateRange.endDate)
        );
      }

      const dateResults = await db.batch(dateStmts);
      const dateMessages = dateResults[0].results;
      const dateSummaries = dateResults[1].results;

      if (dateMessages.length > 0) {
        context += `=== ข้อความในช่วง ${dateRange.startDate} ถึง ${dateRange.endDate} ===\n`;
        context += formatMessages(dateMessages);
        context += "\n\n";
      }
      if (dateSummaries.length > 0) {
        context += `=== สรุปบทสนทนาช่วง ${dateRange.startDate} ถึง ${dateRange.endDate} ===\n`;
        context += dateSummaries.map(s => {
          const typeLabel = s.summary_type === "daily" ? "daily" : "weekly";
          return `[${s.chat_title} | ${s.summary_date} (${typeLabel})]\n${s.summary_text}`;
        }).join("\n\n");
        context += "\n\n";
      }
    }
  } catch (dateErr) {
    console.error("Date range search failed (non-fatal):", dateErr.message);
  }

  return context;
}

/**
 * getTargetGroupContext — ดึงบริบทเฉพาะกลุ่มเป้าหมายสำหรับ /send
 * Single batch, 1 round-trip to D1
 * Returns: { context, groupName, companyName, participants }
 */
export async function getTargetGroupContext(db, targetChatId) {
  const batchStmts = [
    // 0: ข้อความล่าสุด 24 ชม. ของกลุ่มเป้าหมาย (80 rows)
    db.prepare(
      `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at, chat_title
       FROM messages
       WHERE chat_id = ? AND created_at > datetime('now', '-24 hours')
       ORDER BY created_at ASC LIMIT 80`
    ).bind(targetChatId),
    // 1: สมาชิก active 7 วัน (15 คน)
    db.prepare(
      `SELECT username, first_name, COUNT(*) as msg_count
       FROM messages
       WHERE chat_id = ? AND created_at > datetime('now', '-7 days') AND username IS NOT NULL
       GROUP BY username
       ORDER BY msg_count DESC LIMIT 15`
    ).bind(targetChatId),
    // 2: สรุปล่าสุดของกลุ่ม (1 row)
    db.prepare(
      `SELECT summary_text, COALESCE(summary_date, week_end) as summary_date,
              COALESCE(summary_type, 'weekly') as summary_type
       FROM summaries
       WHERE chat_id = ?
       ORDER BY COALESCE(summary_date, week_end) DESC LIMIT 1`
    ).bind(targetChatId),
    // 3: ข้อมูลกลุ่มจาก group_registry + companies
    db.prepare(
      `SELECT g.chat_title, c.name as company_name
       FROM group_registry g
       LEFT JOIN companies c ON g.company_id = c.id
       WHERE g.chat_id = ?`
    ).bind(targetChatId),
    // 4: Hot memories (20 rows)
    db.prepare(
      `SELECT id, content, category FROM memories
       WHERE priority = 'hot'
       ORDER BY created_at DESC LIMIT 20`
    ),
  ];

  const results = await db.batch(batchStmts);

  const recentMessages = results[0].results;
  const activeMembers = results[1].results;
  const latestSummary = results[2].results;
  const groupInfo = results[3].results[0];
  const hotMemories = results[4].results;

  const groupName = groupInfo?.chat_title || recentMessages[0]?.chat_title || `Group ${targetChatId}`;
  const companyName = groupInfo?.company_name || null;
  const participants = activeMembers.map(m => m.username ? `@${m.username}` : m.first_name).filter(Boolean);

  let context = "";

  if (hotMemories.length > 0) {
    context += "=== คำสั่ง/ความจำถาวรจากบอส ===\n";
    context += hotMemories.map(m => `[#${m.id}] (${m.category}) ${m.content}`).join("\n");
    context += "\n\n";
  }

  if (recentMessages.length > 0) {
    context += `=== บทสนทนาล่าสุด 24 ชม. ของกลุ่ม "${groupName}" ===\n`;
    context += formatMessages(recentMessages);
    context += "\n\n";
  }

  if (latestSummary.length > 0) {
    const s = latestSummary[0];
    context += `=== สรุปล่าสุดของกลุ่ม (${s.summary_type} ${s.summary_date}) ===\n`;
    context += s.summary_text;
    context += "\n\n";
  }

  if (activeMembers.length > 0) {
    context += "=== สมาชิก active 7 วัน ===\n";
    context += activeMembers.map(m => {
      const name = m.username ? `@${m.username}` : m.first_name;
      return `${name} (${m.msg_count} ข้อความ)`;
    }).join(", ");
    context += "\n\n";
  }

  return { context, groupName, companyName, participants };
}
