// Summary tools — workspace overview, overdue tasks, employee summary

export const definitions = [
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
