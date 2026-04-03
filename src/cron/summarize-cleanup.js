import { sendTelegram } from '../lib/telegram.js';
import { formatMessages } from '../lib/context.js';
import { generateDailySummary, generateSummary } from '../handlers/summary.js';

export async function summarizeAndCleanup(env) {
  try {
    const bossId = env.BOSS_USER_ID;
    let totalDeletedMessages = 0;
    let totalSummaries = 0;
    let totalDailySummaries = 0;

    // === Daily summaries: สร้าง daily summary สำหรับข้อความเก่ากว่า 24 ชม. ===
    const { results: dailyGroups } = await env.DB
      .prepare(
        `SELECT DISTINCT chat_id, chat_title, date(created_at, '+7 hours') as msg_date
         FROM messages
         WHERE created_at < datetime('now', '-24 hours') AND chat_title IS NOT NULL
         AND date(created_at, '+7 hours') NOT IN (
           SELECT summary_date FROM summaries WHERE chat_id = messages.chat_id AND summary_type = 'daily' AND summary_date IS NOT NULL
         )
         LIMIT 15`
      )
      .all();

    for (const dg of dailyGroups) {
      // เช็คซ้ำอีกครั้ง (idempotency)
      const dup = await env.DB.prepare(
        `SELECT id FROM summaries WHERE chat_id = ? AND summary_type = 'daily' AND summary_date = ?`
      ).bind(dg.chat_id, dg.msg_date).first();
      if (dup) continue;

      const { results: dayMessages } = await env.DB
        .prepare(
          `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at
           FROM messages
           WHERE chat_id = ? AND date(created_at, '+7 hours') = ?
           ORDER BY created_at ASC LIMIT 500`
        )
        .bind(dg.chat_id, dg.msg_date)
        .all();

      if (dayMessages.length === 0) continue;

      const conversationText = dayMessages
        .map(m => {
          const name = m.username ? `@${m.username}` : m.first_name || "Unknown";
          return `[${m.created_at}] ${name}: ${m.message_text}`;
        })
        .join("\n");

      const summary = await generateDailySummary(env, dg.chat_title || "Unknown", conversationText, dg.msg_date);

      if (summary) {
        await env.DB
          .prepare(
            `INSERT INTO summaries (chat_id, chat_title, week_start, week_end, summary_text, message_count, summary_type, summary_date)
             VALUES (?, ?, ?, ?, ?, ?, 'daily', ?)`
          )
          .bind(dg.chat_id, dg.chat_title, dg.msg_date, dg.msg_date, summary, dayMessages.length, dg.msg_date)
          .run();
        totalDailySummaries++;
      }
    }

    // === Weekly summaries + message cleanup (เก่ากว่า 30 วัน) ===

    // 1. หากลุ่มที่มีข้อความเก่ากว่า 30 วัน (LIMIT 10 กลุ่มต่อ cron run)
    const { results: groups } = await env.DB
      .prepare(
        `SELECT DISTINCT chat_id, chat_title FROM messages
         WHERE created_at < datetime('now', '-30 days') AND chat_title IS NOT NULL
         LIMIT 10`
      )
      .all();

    for (const group of groups) {
      // 2. ดึงข้อความเก่าของกลุ่มนี้ (LIMIT 500)
      const { results: oldMessages } = await env.DB
        .prepare(
          `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at
           FROM messages
           WHERE chat_id = ? AND created_at < datetime('now', '-30 days')
           ORDER BY created_at ASC LIMIT 500`
        )
        .bind(group.chat_id)
        .all();

      if (oldMessages.length === 0) continue;

      // คำนวณ week range จากข้อความ
      const weekStart = oldMessages[0].created_at.substring(0, 10);
      const weekEnd = oldMessages[oldMessages.length - 1].created_at.substring(0, 10);

      // 3. เช็ค idempotency — ถ้า summary ซ้ำ skip
      const { results: existing } = await env.DB
        .prepare(
          `SELECT id FROM summaries
           WHERE chat_id = ? AND week_start = ? AND week_end = ?`
        )
        .bind(group.chat_id, weekStart, weekEnd)
        .all();

      if (existing.length > 0) {
        // summary มีอยู่แล้ว ข้ามไปลบข้อความเลย
      } else {
        // 4. ส่งให้ Gemini Flash สรุป
        const conversationText = oldMessages
          .map(m => {
            const name = m.username ? `@${m.username}` : m.first_name || "Unknown";
            return `[${m.created_at}] ${name}: ${m.message_text}`;
          })
          .join("\n");

        const summary = await generateSummary(env, group.chat_title || "Unknown", conversationText);

        if (summary) {
          await env.DB
            .prepare(
              `INSERT INTO summaries (chat_id, chat_title, week_start, week_end, summary_text, message_count, summary_type, summary_date)
               VALUES (?, ?, ?, ?, ?, ?, 'weekly', ?)`
            )
            .bind(group.chat_id, group.chat_title, weekStart, weekEnd, summary, oldMessages.length, weekEnd)
            .run();
          totalSummaries++;
        }
      }

      // 5. ลบข้อความเก่าหลังสรุปเสร็จ (batch 500 × 5 รอบต่อกลุ่ม)
      for (let round = 0; round < 5; round++) {
        const result = await env.DB
          .prepare(
            `DELETE FROM messages WHERE id IN (
               SELECT id FROM messages WHERE chat_id = ? AND created_at < datetime('now', '-30 days') LIMIT 500
             )`
          )
          .bind(group.chat_id)
          .run();
        const deleted = result.meta.changes;
        totalDeletedMessages += deleted;
        if (deleted < 500) break;
      }
    }

    // 6. Auto-archive completed tasks > 7 days, delete > 30 days
    let tasksArchived = 0;
    let tasksDeleted = 0;
    const { results: doneTasks } = await env.DB.prepare(
      `SELECT id, description, result FROM tasks
       WHERE status = 'done' AND completed_at < datetime('now', '-7 days')
         AND archived_to_memory_id IS NULL LIMIT 10`
    ).all();

    for (const task of doneTasks) {
      if (task.result && task.result.length > 50) {
        const { meta } = await env.DB.prepare(
          `INSERT INTO memories (content, category, priority) VALUES (?, 'task_result', 'warm')`
        ).bind(`[Task #${task.id}: ${task.description}] ${task.result}`).run();
        await env.DB.prepare(
          `UPDATE tasks SET archived_to_memory_id = ? WHERE id = ?`
        ).bind(meta.last_row_id, task.id).run();
        tasksArchived++;
      }
    }

    const taskDeleteResult = await env.DB.prepare(
      `DELETE FROM tasks
       WHERE (status IN ('done','cancelled')) AND completed_at < datetime('now', '-30 days')
         AND (archived_to_memory_id IS NOT NULL OR result IS NULL OR LENGTH(result) <= 50)`
    ).run();
    tasksDeleted = taskDeleteResult.meta.changes;

    // 8. Auto-decay memories (category-aware)
    // rule, person, preference → NEVER auto-decay (permanent knowledge)
    // general, project, task, task_result → hot→warm after 30 days, warm→cold after 60 days
    const DECAY_EXEMPT = "'rule','person','preference'";
    const decayHotToWarm = await env.DB.prepare(
      `UPDATE memories SET priority = 'warm'
       WHERE priority = 'hot'
         AND category NOT IN (${DECAY_EXEMPT})
         AND COALESCE(last_accessed, created_at) < datetime('now', '-30 days')`
    ).run();
    const decayWarmToCold = await env.DB.prepare(
      `UPDATE memories SET priority = 'cold'
       WHERE priority = 'warm'
         AND category NOT IN (${DECAY_EXEMPT})
         AND COALESCE(last_accessed, created_at) < datetime('now', '-60 days')`
    ).run();
    const decayed = (decayHotToWarm.meta.changes || 0) + (decayWarmToCold.meta.changes || 0);
    if (decayed > 0) {
      console.log(`Memory auto-decay: ${decayHotToWarm.meta.changes || 0} hot→warm, ${decayWarmToCold.meta.changes || 0} warm→cold`);
    }

    // ลบ readlink cache เก่ากว่า 24 ชม.
    await env.DB.prepare(
      `DELETE FROM readlink_cache WHERE created_at < datetime('now', '-24 hours')`
    ).run();

    // ลบ file_cache เก่ากว่า 24 ชม.
    await env.DB.prepare(
      `DELETE FROM file_cache WHERE created_at < datetime('now', '-24 hours')`
    ).run();

    // ลบ bot_messages เก่ากว่า 48 ชม.
    await env.DB.prepare(
      `DELETE FROM bot_messages WHERE created_at < datetime('now', '-48 hours')`
    ).run();

    // ลบ summaries เก่ากว่า 365 วัน
    await env.DB.prepare(
      `DELETE FROM summaries WHERE created_at < datetime('now', '-365 days')`
    ).run();

    if (totalDeletedMessages > 0 || totalSummaries > 0 || totalDailySummaries > 0 || tasksDeleted > 0) {
      console.log(
        `Cleanup done: ${totalDeletedMessages} msgs deleted, ${totalSummaries} weekly + ${totalDailySummaries} daily summaries, ${tasksDeleted} tasks deleted (${tasksArchived} archived)`
      );
    }
  } catch (err) {
    console.error("Summarize & cleanup error:", err);
  }
}
