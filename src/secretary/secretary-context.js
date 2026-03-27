// Secretary Context — builds work-management context for secretary prompts

import { formatMessages } from '../lib/context.js';
import { listEvents, isCalendarConfigured } from '../lib/google-calendar.js';

export async function buildSecretaryContext(env, chatId, isDM, userQuery) {
  const db = env.DB;
  const todayStr = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

  // Batch 1: workspace members, pending tasks, blocked tasks, recent done, recent messages
  const batchStmts = [
    // 0: workspace members
    db.prepare(
      `SELECT id, display_name, nicknames, role, department FROM workspace_members
       WHERE is_active = 1 ORDER BY display_name ASC`
    ),
    // 1: pending/in-progress tasks with richer info
    db.prepare(
      `SELECT id, title, description, status, assignee_name, priority, due_on, category, expected_output,
              datetime(created_at, '+7 hours') as created_at
       FROM tasks WHERE status IN ('pending', 'in_progress')
       ORDER BY
         CASE WHEN due_on IS NOT NULL AND due_on < '${todayStr}' THEN 0
              WHEN priority = 'critical' THEN 1
              WHEN priority = 'high' THEN 2
              ELSE 3 END,
         due_on ASC NULLS LAST, created_at ASC
       LIMIT 20`
    ),
    // 2: blocked tasks
    db.prepare(
      `SELECT t.id, t.title, t.description, t.assignee_name, tb.blocker_description
       FROM tasks t LEFT JOIN task_blockers tb ON t.id = tb.task_id AND tb.resolved = 0
       WHERE t.status = 'blocked'
       ORDER BY t.created_at DESC LIMIT 10`
    ),
    // 3: recently completed (24h)
    db.prepare(
      `SELECT id, title, description, assignee_name, result,
              datetime(completed_at, '+7 hours') as completed_at
       FROM tasks WHERE status = 'done' AND completed_at > datetime('now', '-24 hours')
       ORDER BY completed_at DESC LIMIT 5`
    ),
    // 4: hot memories
    db.prepare(
      `SELECT id, content, category FROM memories
       WHERE priority = 'hot' ORDER BY created_at DESC LIMIT 30`
    ),
  ];

  // 5: recent messages (DM vs group)
  if (isDM) {
    batchStmts.push(
      db.prepare(
        `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at, chat_title, chat_id
         FROM messages
         WHERE chat_title IS NOT NULL AND created_at > datetime('now', '-2 hours')
         ORDER BY created_at ASC LIMIT 60`
      )
    );
  } else {
    batchStmts.push(
      db.prepare(
        `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at, chat_title
         FROM messages
         WHERE chat_id = ? AND created_at > datetime('now', '-2 hours')
         ORDER BY created_at ASC LIMIT 60`
      ).bind(chatId)
    );
  }

  const results = await db.batch(batchStmts);

  const members = results[0].results;
  const pendingTasks = results[1].results;
  const blockedTasks = results[2].results;
  const recentDone = results[3].results;
  const hotMemories = results[4].results;
  const recentMessages = results[5].results;

  let context = '';

  // Workspace members
  if (members.length > 0) {
    context += '=== สมาชิกในทีม ===\n';
    context += members.map(m => {
      const nicks = JSON.parse(m.nicknames || '[]');
      let line = `- ${m.display_name}`;
      if (nicks.length) line += ` (ชื่อเล่น: ${nicks.join(', ')})`;
      if (m.role) line += ` [${m.role}]`;
      if (m.department) line += ` แผนก: ${m.department}`;
      return line;
    }).join('\n');
    context += '\n\n';
  }

  // Hot memories
  if (hotMemories.length > 0) {
    context += '=== คำสั่ง/ความจำถาวรจากบอส ===\n';
    context += hotMemories.map(m => `[#${m.id}] (${m.category}) ${m.content}`).join('\n');
    context += '\n\n';
  }

  // Pending tasks
  if (pendingTasks.length > 0) {
    context += '=== งานที่ค้างอยู่ ===\n';
    context += pendingTasks.map(t => {
      let line = `- Task #${t.id}: "${t.title || t.description}"`;
      if (t.assignee_name) line += ` [ผู้รับผิดชอบ: ${t.assignee_name}]`;
      if (t.priority && t.priority !== 'medium') line += ` [${t.priority}]`;
      if (t.due_on) {
        if (t.due_on < todayStr) line += ` [🔴 เลยกำหนด: ${t.due_on}]`;
        else line += ` [📅 กำหนด: ${t.due_on}]`;
      }
      if (t.category) line += ` (${t.category})`;
      if (t.status === 'in_progress') line += ' [กำลังทำ]';
      return line;
    }).join('\n');
    context += '\n\n';
  }

  // Blocked tasks
  if (blockedTasks.length > 0) {
    context += '=== งานที่ติดขัด (blocked) ===\n';
    context += blockedTasks.map(t => {
      let line = `- Task #${t.id}: "${t.title || t.description}"`;
      if (t.assignee_name) line += ` [${t.assignee_name}]`;
      if (t.blocker_description) line += ` — ติดขัด: ${t.blocker_description}`;
      return line;
    }).join('\n');
    context += '\n\n';
  }

  // Recently completed
  if (recentDone.length > 0) {
    context += '=== งานที่เสร็จล่าสุด (24 ชม.) ===\n';
    context += recentDone.map(t => {
      let line = `- Task #${t.id}: "${t.title || t.description}"`;
      if (t.assignee_name) line += ` [${t.assignee_name}]`;
      if (t.result) line += ` → ${t.result}`;
      line += ` (เสร็จ: ${t.completed_at})`;
      return line;
    }).join('\n');
    context += '\n\n';
  }

  // Recent messages
  if (recentMessages.length > 0) {
    if (isDM) {
      const byGroup = {};
      for (const msg of recentMessages) {
        const key = msg.chat_id;
        if (!byGroup[key]) byGroup[key] = { title: msg.chat_title, msgs: [] };
        byGroup[key].msgs.push(msg);
      }
      for (const group of Object.values(byGroup)) {
        context += `=== กลุ่ม: ${group.title} (ล่าสุด 2 ชม.) ===\n`;
        context += formatMessages(group.msgs);
        context += '\n\n';
      }
    } else {
      context += '=== บทสนทนาล่าสุด 2 ชม. (กลุ่มนี้) ===\n';
      context += formatMessages(recentMessages);
      context += '\n\n';
    }
  }

  // Calendar
  if (isDM && env && isCalendarConfigured(env)) {
    try {
      const now = new Date();
      const bangkokNow = new Date(now.getTime() + 7 * 3600000);
      const today = bangkokNow.toISOString().slice(0, 10);
      const next7 = new Date(bangkokNow);
      next7.setUTCDate(next7.getUTCDate() + 7);
      const endStr = next7.toISOString().slice(0, 10);
      const events = await listEvents(env, `${today}T00:00:00+07:00`, `${endStr}T23:59:59+07:00`, 15);
      if (events.length > 0) {
        context += '=== ปฏิทินนัดหมาย (7 วันข้างหน้า) ===\n';
        for (const e of events) {
          const timeStr = e.time === 'ทั้งวัน' ? 'ทั้งวัน' : `${e.time}-${e.endTime}`;
          let line = `📅 ${e.date} ${timeStr} — ${e.title}`;
          if (e.location) line += ` 📍${e.location}`;
          context += line + '\n';
        }
        context += '\n';
      }
    } catch (e) {
      console.error('Secretary calendar context failed:', e.message);
    }
  }

  return context;
}
