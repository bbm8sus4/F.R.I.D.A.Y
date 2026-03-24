import { sendTelegram } from './telegram.js';

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

  // ตรวจว่ามี action tags ไหม (ก่อน strip) — รวม tag ที่ Gemini ใส่ชื่อกลุ่มแทน chat_id ด้วย
  const hasActionTags = /\[(SEND|REMEMBER|FORGET|TASK_DONE|TASK_CREATE|TASK_CANCEL):/.test(reply);

  // Strip all action tags from reply text (boss sees clean text)
  // SEND: match ทุกรูปแบบ (ทั้ง chat_id ตัวเลข และชื่อกลุ่ม)
  const cleanReply = reply
    .replace(/\[SEND:[^\]]+\]/g, '')
    .replace(/\[REMEMBER:\w+:[^\]]+\]/g, '')
    .replace(/\[FORGET:\d+\]/g, '')
    .replace(/\[TASK_DONE:\d+:[^\]]+\]/g, '')
    .replace(/\[TASK_CREATE:[^\]]+\]/g, '')
    .replace(/\[TASK_CANCEL:\d+\]/g, '')
    .trim();

  return { cleanReply, actionsExecuted, hasActionTags };
}
