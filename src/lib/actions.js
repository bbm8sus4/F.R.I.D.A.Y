import { sendTelegram } from './telegram.js';
import { createEvent, deleteEvent, isCalendarConfigured } from './google-calendar.js';

export async function parseAndExecuteActions(env, reply) {
  let actionsExecuted = 0;

  // 1. Execute SEND actions
  const sendRegex = /\[SEND:(-?\d+):([^\]]+)\]/g;
  let match;
  while ((match = sendRegex.exec(reply)) !== null) {
    await sendTelegram(env, match[1], match[2], null, true);
    actionsExecuted++;
  }

  // 2. Execute REMEMBER actions
  const rememberRegex = /\[REMEMBER:(\w+):([^\]]+)\]/g;
  while ((match = rememberRegex.exec(reply)) !== null) {
    const category = match[1];
    const content = match[2];
    await env.DB.prepare(`INSERT INTO memories (content, category) VALUES (?, ?)`)
      .bind(content, category)
      .run();
    actionsExecuted++;
  }

  // 3. Execute FORGET actions
  const forgetRegex = /\[FORGET:(\d+)\]/g;
  while ((match = forgetRegex.exec(reply)) !== null) {
    await env.DB.prepare(`DELETE FROM memories WHERE id = ?`)
      .bind(Number(match[1]))
      .run();
    actionsExecuted++;
  }

  // 4. Execute TASK_DONE actions
  const taskDoneRegex = /\[TASK_DONE:(\d+):([^\]]+)\]/g;
  while ((match = taskDoneRegex.exec(reply)) !== null) {
    const task = await env.DB
      .prepare(`SELECT id FROM tasks WHERE id = ? AND status = 'pending'`)
      .bind(Number(match[1])).first();
    if (task) {
      await env.DB
        .prepare(`UPDATE tasks SET status='done', result=?, completed_at=datetime('now') WHERE id=?`)
        .bind(match[2], Number(match[1])).run();
    }
    actionsExecuted++;
  }

  // 5. Execute TASK_CREATE actions
  const taskCreateRegex = /\[TASK_CREATE:([^\]:\n]+?)(?::(\d{4}-\d{2}-\d{2}))?\]/g;
  while ((match = taskCreateRegex.exec(reply)) !== null) {
    const desc = match[1].trim();
    const dueOn = match[2] || null;
    await env.DB.prepare(
      `INSERT INTO tasks (description, due_on) VALUES (?, ?)`
    ).bind(desc, dueOn).run();
    actionsExecuted++;
  }

  // 6. Execute TASK_CANCEL actions
  const taskCancelRegex = /\[TASK_CANCEL:(\d+)\]/g;
  while ((match = taskCancelRegex.exec(reply)) !== null) {
    await env.DB.prepare(
      `UPDATE tasks SET status='cancelled', completed_at=datetime('now') WHERE id=? AND status='pending'`
    ).bind(Number(match[1])).run();
    actionsExecuted++;
  }

  // 7. Execute CAL_ADD actions — [CAL_ADD:title|YYYY-MM-DD|HH:MM|duration_minutes]
  if (isCalendarConfigured(env)) {
    const calAddRegex = /\[CAL_ADD:([^|\]]+)\|(\d{4}-\d{2}-\d{2})\|(\d{2}:\d{2})\|?(\d+)?\]/g;
    while ((match = calAddRegex.exec(reply)) !== null) {
      try {
        await createEvent(env, {
          title: match[1],
          date: match[2],
          time: match[3],
          duration: match[4] ? Number(match[4]) : 60,
        });
        actionsExecuted++;
      } catch (e) {
        console.error("CAL_ADD action failed:", e);
      }
    }

    // 8. Execute CAL_DELETE actions — [CAL_DELETE:eventId]
    const calDeleteRegex = /\[CAL_DELETE:([^\]]+)\]/g;
    while ((match = calDeleteRegex.exec(reply)) !== null) {
      try {
        await deleteEvent(env, match[1]);
        actionsExecuted++;
      } catch (e) {
        console.error("CAL_DELETE action failed:", e);
      }
    }
  }

  // ตรวจว่ามี action tags ไหม (ก่อน strip) — รวม tag ที่ Gemini ใส่ชื่อกลุ่มแทน chat_id ด้วย
  const hasActionTags = /\[(SEND|REMEMBER|FORGET|TASK_DONE|TASK_CREATE|TASK_CANCEL|CAL_ADD|CAL_DELETE):/.test(reply);

  // Strip all action tags from reply text (boss sees clean text)
  // SEND: match ทุกรูปแบบ (ทั้ง chat_id ตัวเลข และชื่อกลุ่ม)
  const cleanReply = reply
    .replace(/\[SEND:[^\]]+\]/g, '')
    .replace(/\[REMEMBER:\w+:[^\]]+\]/g, '')
    .replace(/\[FORGET:\d+\]/g, '')
    .replace(/\[TASK_DONE:\d+:[^\]]+\]/g, '')
    .replace(/\[TASK_CREATE:[^\]]+\]/g, '')
    .replace(/\[TASK_CANCEL:\d+\]/g, '')
    .replace(/\[CAL_ADD:[^\]]+\]/g, '')
    .replace(/\[CAL_DELETE:[^\]]+\]/g, '')
    .trim();

  return { cleanReply, actionsExecuted, hasActionTags };
}
