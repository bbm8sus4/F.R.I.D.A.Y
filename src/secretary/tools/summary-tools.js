// Summary tools — workspace overview, overdue tasks, employee summary, group recap

import { formatMessages } from '../../lib/context.js';

export const definitions = [
  {
    name: 'list_groups',
    description: 'แสดงรายชื่อกลุ่ม Telegram ทั้งหมดที่บอทอยู่ (จาก group_registry) — ใช้เมื่อบอสถาม "อยู่กลุ่มไหนบ้าง" "ขอชื่อกลุ่มทั้งหมด" "มีกลุ่มอะไรบ้าง"',
    parameters: {
      type: 'OBJECT',
      properties: {
        include_inactive: { type: 'BOOLEAN', description: 'รวมกลุ่มที่ inactive ด้วยหรือไม่ (default: false)' },
      },
    },
  },
  {
    name: 'recap_group',
    description: 'สรุปบทสนทนาของกลุ่ม Telegram ใดกลุ่มหนึ่งย้อนหลังตามช่วงเวลาที่ระบุ — ใช้เมื่อบอสขอ "recap/สรุปกลุ่ม X" คืนข้อความและสรุปรายวันที่เก็บไว้ใน DB เพื่อให้ AI นำไปเรียบเรียงสรุปต่อ. ระบุกลุ่มด้วย group_name (fuzzy match จาก group_registry.chat_title) และระบุช่วงเวลาเป็น days หรือ start_date/end_date (YYYY-MM-DD). ถ้าไม่ระบุช่วงเวลา default = 7 วัน',
    parameters: {
      type: 'OBJECT',
      properties: {
        group_name: { type: 'STRING', description: 'ชื่อกลุ่ม (fuzzy partial match)' },
        days: { type: 'INTEGER', description: 'จำนวนวันย้อนหลัง (1-90) ใช้เมื่อไม่ระบุช่วงวันที่ชัดเจน' },
        start_date: { type: 'STRING', description: 'วันเริ่มต้น YYYY-MM-DD (เช่น "2026-03-01")' },
        end_date: { type: 'STRING', description: 'วันสิ้นสุด YYYY-MM-DD (เช่น "2026-03-31")' },
      },
      required: ['group_name'],
    },
  },
  {
    name: 'get_workspace_summary',
    description: 'สรุปภาพรวมงานทั้ง workspace — จำนวนตาม status, priority, assignee, overdue',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'get_overdue_tasks',
    description: 'แสดงรายการ tasks ที่เลยกำหนดทั้งหมด',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'get_employee_summary',
    description: 'สรุปงานของพนักงานคนใดคนหนึ่ง หรือทุกคน',
    parameters: {
      type: 'OBJECT',
      properties: {
        employee_name: { type: 'STRING', description: 'ชื่อพนักงาน (ถ้าไม่ระบุ = ทุกคน)' },
      },
    },
  },
];

export const executors = {
  async list_groups(env, args) {
    const includeInactive = !!(args && args.include_inactive);
    const query = includeInactive
      ? `SELECT chat_id, chat_title, is_active, last_message_at FROM group_registry
         ORDER BY is_active DESC, last_message_at DESC`
      : `SELECT chat_id, chat_title, is_active, last_message_at FROM group_registry
         WHERE is_active = 1 ORDER BY last_message_at DESC`;
    const { results } = await env.DB.prepare(query).all();
    return {
      count: results.length,
      groups: results.map(r => ({
        title: r.chat_title || `Group ${r.chat_id}`,
        is_active: !!r.is_active,
        last_message_at: r.last_message_at,
      })),
    };
  },

  async recap_group(env, args) {
    const { group_name, days, start_date, end_date } = args || {};
    if (!group_name) return { error: 'ต้องระบุ group_name' };

    // Resolve group via fuzzy match against group_registry
    const nameLower = group_name.toLowerCase();
    const { results: groups } = await env.DB.prepare(
      `SELECT chat_id, chat_title FROM group_registry
       WHERE is_active = 1 AND LOWER(chat_title) LIKE ?
       ORDER BY last_message_at DESC LIMIT 5`
    ).bind(`%${nameLower}%`).all();

    if (!groups.length) {
      return { error: `ไม่พบกลุ่มที่ชื่อใกล้เคียง "${group_name}"` };
    }
    if (groups.length > 1) {
      // Prefer exact match if any
      const exact = groups.find(g => (g.chat_title || '').toLowerCase() === nameLower);
      if (!exact) {
        return {
          ambiguous: true,
          candidates: groups.map(g => g.chat_title),
          message: 'พบหลายกลุ่ม กรุณาระบุชื่อให้ชัดเจนขึ้น',
        };
      }
    }
    const group = groups.find(g => (g.chat_title || '').toLowerCase() === nameLower) || groups[0];
    const targetChatId = group.chat_id;
    const groupName = group.chat_title;

    // Determine date range
    let useDateRange = false;
    let startStr, endStr, daysNum;
    if (start_date && end_date && /^\d{4}-\d{2}-\d{2}$/.test(start_date) && /^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
      useDateRange = true;
      startStr = start_date;
      endStr = end_date;
    } else {
      daysNum = Math.min(Math.max(Number(days) || 7, 1), 90);
    }

    // Fetch messages
    const msgQuery = useDateRange
      ? `SELECT message_text, first_name, username, chat_title, created_at
         FROM messages WHERE chat_id = ? AND date(created_at) >= ? AND date(created_at) <= ?
         ORDER BY created_at ASC LIMIT 800`
      : `SELECT message_text, first_name, username, chat_title, created_at
         FROM messages WHERE chat_id = ? AND created_at > ?
         ORDER BY created_at ASC LIMIT 800`;
    const msgParams = useDateRange
      ? [targetChatId, startStr, endStr]
      : [targetChatId, new Date(Date.now() - daysNum * 86400000).toISOString()];

    const { results: messages } = await env.DB.prepare(msgQuery).bind(...msgParams).all();

    // Fetch daily summaries
    const sumQuery = useDateRange
      ? `SELECT summary_text, summary_date FROM summaries
         WHERE chat_id = ? AND summary_date >= ? AND summary_date <= ?
         ORDER BY summary_date ASC`
      : `SELECT summary_text, summary_date FROM summaries
         WHERE chat_id = ? AND summary_date >= ?
         ORDER BY summary_date ASC`;
    const sumParams = useDateRange
      ? [targetChatId, startStr, endStr]
      : [targetChatId, new Date(Date.now() - daysNum * 86400000).toISOString().slice(0, 10)];

    const { results: summaries } = await env.DB.prepare(sumQuery).bind(...sumParams).all();

    if (!messages.length && !summaries.length) {
      return {
        group_name: groupName,
        period: useDateRange ? `${startStr} ถึง ${endStr}` : `${daysNum} วันที่ผ่านมา`,
        message_count: 0,
        summary_count: 0,
        note: 'ไม่พบข้อมูลในช่วงเวลาที่ระบุ',
      };
    }

    const formattedMsgs = formatMessages(messages);
    const summaryTexts = summaries
      .map(s => `[สรุปวันที่ ${s.summary_date}]\n${s.summary_text}`)
      .join('\n\n');

    // Cap context to keep tokens manageable
    const MAX_LEN = 30000;
    let messagesText = formattedMsgs || '';
    let truncated = false;
    if (messagesText.length > MAX_LEN) {
      messagesText = messagesText.slice(-MAX_LEN);
      truncated = true;
    }

    return {
      group_name: groupName,
      period: useDateRange ? `${startStr} ถึง ${endStr}` : `${daysNum} วันที่ผ่านมา`,
      message_count: messages.length,
      summary_count: summaries.length,
      truncated,
      daily_summaries: summaryTexts || null,
      messages: messagesText || null,
      instruction: 'นำข้อมูลด้านบนไปเรียบเรียงเป็นสรุปภาษาไทย กระชับ แบ่งหัวข้อชัดเจน ระบุประเด็นสำคัญและสิ่งที่ต้องติดตาม',
    };
  },

  async get_workspace_summary(env) {
    const todayStr = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

    const [statusQ, priorityQ, assigneeQ, overdueQ, recentDoneQ] = await env.DB.batch([
      env.DB.prepare(
        `SELECT status, COUNT(*) as count FROM tasks
         WHERE status NOT IN ('done', 'cancelled')
         GROUP BY status`
      ),
      env.DB.prepare(
        `SELECT priority, COUNT(*) as count FROM tasks
         WHERE status NOT IN ('done', 'cancelled')
         GROUP BY priority`
      ),
      env.DB.prepare(
        `SELECT COALESCE(assignee_name, 'ไม่มีผู้รับผิดชอบ') as assignee, status, COUNT(*) as count
         FROM tasks WHERE status NOT IN ('done', 'cancelled')
         GROUP BY assignee_name, status`
      ),
      env.DB.prepare(
        `SELECT COUNT(*) as count FROM tasks
         WHERE status NOT IN ('done', 'cancelled') AND due_on IS NOT NULL AND due_on < ?`
      ).bind(todayStr),
      env.DB.prepare(
        `SELECT COUNT(*) as count FROM tasks
         WHERE status = 'done' AND completed_at > datetime('now', '-24 hours')`
      ),
    ]);

    return {
      by_status: statusQ.results,
      by_priority: priorityQ.results,
      by_assignee: assigneeQ.results,
      overdue_count: overdueQ.results[0]?.count || 0,
      completed_last_24h: recentDoneQ.results[0]?.count || 0,
      today: todayStr,
    };
  },

  async get_overdue_tasks(env) {
    const todayStr = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

    const { results } = await env.DB.prepare(
      `SELECT id, title, description, assignee_name, priority, due_on, status,
              datetime(created_at, '+7 hours') as created_at
       FROM tasks
       WHERE status NOT IN ('done', 'cancelled') AND due_on IS NOT NULL AND due_on < ?
       ORDER BY due_on ASC, priority DESC
       LIMIT 20`
    ).bind(todayStr).all();

    return {
      tasks: results.map(t => ({
        id: t.id,
        title: t.title || t.description,
        assignee: t.assignee_name,
        priority: t.priority,
        due_on: t.due_on,
        days_overdue: Math.floor((new Date(todayStr) - new Date(t.due_on)) / 86400000),
        status: t.status,
      })),
      count: results.length,
      today: todayStr,
    };
  },

  async get_employee_summary(env, args) {
    const { employee_name } = args;

    let whereClause = "WHERE status NOT IN ('done', 'cancelled')";
    const params = [];

    if (employee_name) {
      whereClause += ' AND LOWER(assignee_name) LIKE ?';
      params.push(`%${employee_name.toLowerCase()}%`);
    }

    const { results } = await env.DB.prepare(
      `SELECT COALESCE(assignee_name, 'ไม่มีผู้รับผิดชอบ') as assignee,
              status, priority, COUNT(*) as count
       FROM tasks ${whereClause}
       GROUP BY assignee_name, status, priority
       ORDER BY assignee_name, status`
    ).bind(...params).all();

    // Group by assignee
    const byAssignee = {};
    for (const row of results) {
      if (!byAssignee[row.assignee]) {
        byAssignee[row.assignee] = { total: 0, by_status: {}, by_priority: {} };
      }
      byAssignee[row.assignee].total += row.count;
      byAssignee[row.assignee].by_status[row.status] = (byAssignee[row.assignee].by_status[row.status] || 0) + row.count;
      byAssignee[row.assignee].by_priority[row.priority] = (byAssignee[row.assignee].by_priority[row.priority] || 0) + row.count;
    }

    return { employees: byAssignee };
  },
};
