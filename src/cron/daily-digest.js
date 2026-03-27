// Daily Digest — morning summary of tasks (runs in 3h cron, sends between 8-10 AM Bangkok)

import { sendTelegram } from '../lib/telegram.js';
import { createProvider } from '../secretary/ai-provider.js';
import { buildDigestPrompt } from '../secretary/secretary-prompt.js';
import { logAIUsage } from '../secretary/ai-logger.js';

export async function dailyDigest(env) {
  try {
    // Only send between 8-10 AM Bangkok time
    const bangkokHour = new Date(Date.now() + 7 * 3600000).getUTCHours();
    if (bangkokHour < 8 || bangkokHour >= 10) return;

    // Dedup: check if digest already sent today
    const todayStr = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
    const alreadySent = await env.DB.prepare(
      `SELECT id FROM ai_log WHERE feature = 'daily_digest' AND success = 1
       AND created_at > datetime('now', '-12 hours')
       LIMIT 1`
    ).first();
    if (alreadySent) return;

    // Gather data
    const [statusQ, overdueQ, blockedQ, assigneeQ, dueTodayQ] = await env.DB.batch([
      env.DB.prepare(
        `SELECT status, COUNT(*) as count FROM tasks
         WHERE status NOT IN ('done', 'cancelled')
         GROUP BY status`
      ),
      env.DB.prepare(
        `SELECT id, title, description, assignee_name, due_on, priority FROM tasks
         WHERE status NOT IN ('done', 'cancelled') AND due_on IS NOT NULL AND due_on < ?
         ORDER BY due_on ASC LIMIT 10`
      ).bind(todayStr),
      env.DB.prepare(
        `SELECT t.id, t.title, t.description, t.assignee_name, tb.blocker_description
         FROM tasks t LEFT JOIN task_blockers tb ON t.id = tb.task_id AND tb.resolved = 0
         WHERE t.status = 'blocked'
         LIMIT 10`
      ),
      env.DB.prepare(
        `SELECT COALESCE(assignee_name, 'ไม่ระบุ') as assignee, COUNT(*) as count
         FROM tasks WHERE status NOT IN ('done', 'cancelled')
         GROUP BY assignee_name ORDER BY count DESC`
      ),
      env.DB.prepare(
        `SELECT id, title, description, assignee_name, priority FROM tasks
         WHERE status NOT IN ('done', 'cancelled') AND due_on = ?
         ORDER BY priority DESC LIMIT 10`
      ).bind(todayStr),
    ]);

    const overdue = overdueQ.results;
    const blocked = blockedQ.results;
    const dueToday = dueTodayQ.results;
    const byAssignee = assigneeQ.results;
    const totalActive = statusQ.results.reduce((sum, r) => sum + r.count, 0);

    // Skip if nothing to report
    if (totalActive === 0 && overdue.length === 0) return;

    // Build context for AI
    let dataContext = `วันที่: ${todayStr}\n\n`;
    if (overdue.length > 0) {
      dataContext += 'งานเลยกำหนด:\n';
      dataContext += overdue.map(t => {
        const days = Math.floor((new Date(todayStr) - new Date(t.due_on)) / 86400000);
        return `- #${t.id} "${t.title || t.description}" [${t.assignee_name || 'ไม่ระบุ'}] กำหนด: ${t.due_on} (เลย ${days} วัน) priority: ${t.priority}`;
      }).join('\n');
      dataContext += '\n\n';
    }

    if (dueToday.length > 0) {
      dataContext += 'งานกำหนดวันนี้:\n';
      dataContext += dueToday.map(t =>
        `- #${t.id} "${t.title || t.description}" [${t.assignee_name || 'ไม่ระบุ'}] priority: ${t.priority}`
      ).join('\n');
      dataContext += '\n\n';
    }

    if (blocked.length > 0) {
      dataContext += 'งานติดขัด:\n';
      dataContext += blocked.map(t =>
        `- #${t.id} "${t.title || t.description}" [${t.assignee_name || 'ไม่ระบุ'}] สาเหตุ: ${t.blocker_description || 'ไม่ระบุ'}`
      ).join('\n');
      dataContext += '\n\n';
    }

    if (byAssignee.length > 0) {
      dataContext += 'งานตามคน:\n';
      dataContext += byAssignee.map(a => `- ${a.assignee}: ${a.count} งาน`).join('\n');
      dataContext += '\n\n';
    }

    dataContext += `รวมงานค้าง: ${totalActive} รายการ`;

    // Generate digest with AI
    const startTime = Date.now();
    let digestText;
    try {
      const provider = createProvider(env);
      const result = await provider.complete({
        systemPrompt: buildDigestPrompt(dataContext),
        messages: [{ role: 'user', content: 'สรุปสถานะงานประจำวัน' }],
        generationConfig: { maxOutputTokens: 2048 },
      });

      await logAIUsage(env.DB, {
        feature: 'daily_digest',
        model: result.model,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        durationMs: Date.now() - startTime,
        success: !result.error,
        error: result.errorMessage,
      });

      digestText = result.text;
    } catch (e) {
      console.error('Daily digest AI failed:', e.message);
    }

    // Fallback to template-based digest
    if (!digestText) {
      digestText = buildTemplateDigest(todayStr, overdue, dueToday, blocked, byAssignee, totalActive);
    }

    if (digestText) {
      const bossId = Number(env.BOSS_USER_ID);
      await sendTelegram(env, bossId, `📊 <b>สรุปงานประจำวัน</b>\n\n${digestText}`, null, true);
    }
  } catch (e) {
    console.error('dailyDigest error:', e.message);
  }
}

function buildTemplateDigest(today, overdue, dueToday, blocked, byAssignee, total) {
  let text = '';

  if (overdue.length > 0) {
    text += '<b>🔴 งานเลยกำหนด:</b>\n';
    for (const t of overdue) {
      const days = Math.floor((new Date(today) - new Date(t.due_on)) / 86400000);
      text += `  #${t.id} ${t.title || t.description} [${t.assignee_name || '-'}] เลย ${days} วัน\n`;
    }
    text += '\n';
  }

  if (dueToday.length > 0) {
    text += '<b>📅 กำหนดวันนี้:</b>\n';
    for (const t of dueToday) {
      text += `  #${t.id} ${t.title || t.description} [${t.assignee_name || '-'}]\n`;
    }
    text += '\n';
  }

  if (blocked.length > 0) {
    text += '<b>🚫 ติดขัด:</b>\n';
    for (const t of blocked) {
      text += `  #${t.id} ${t.title || t.description} — ${t.blocker_description || '?'}\n`;
    }
    text += '\n';
  }

  if (byAssignee.length > 0) {
    text += '<b>👥 ตามคน:</b>\n';
    for (const a of byAssignee) {
      text += `  ${a.assignee}: ${a.count} งาน\n`;
    }
    text += '\n';
  }

  text += `รวม: ${total} งานค้าง`;
  return text;
}
