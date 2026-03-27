// Task tools — create, update, complete, block, list, detail, summary

export const definitions = [
  {
    name: 'create_task',
    description: 'สร้าง task ใหม่ ระบุ title, รายละเอียด, ผู้รับผิดชอบ, กำหนดส่ง, priority, category ได้',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING', description: 'ชื่อ task สั้นๆ กระชับ (จำเป็น)' },
        description: { type: 'STRING', description: 'รายละเอียดเพิ่มเติม' },
        assignee_name: { type: 'STRING', description: 'ชื่อผู้รับผิดชอบ (ต้องตรงกับ workspace_members)' },
        due_on: { type: 'STRING', description: 'วันกำหนดส่ง YYYY-MM-DD' },
        priority: { type: 'STRING', description: 'ความสำคัญ: critical, high, medium, low', enum: ['critical', 'high', 'medium', 'low'] },
        category: { type: 'STRING', description: 'หมวดหมู่งาน เช่น stock, delivery, report, meeting' },
        expected_output: { type: 'STRING', description: 'ผลลัพธ์ที่คาดหวัง เช่น "รายงาน Excel" "ภาพถ่ายสต็อก"' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task',
    description: 'อัปเดต task ที่มีอยู่ — เปลี่ยน status, assignee, priority, due_on, เพิ่ม comment',
    parameters: {
      type: 'OBJECT',
      properties: {
        task_id: { type: 'INTEGER', description: 'ID ของ task' },
        status: { type: 'STRING', description: 'สถานะใหม่', enum: ['pending', 'in_progress', 'done', 'cancelled', 'blocked'] },
        assignee_name: { type: 'STRING', description: 'ชื่อผู้รับผิดชอบใหม่' },
        priority: { type: 'STRING', description: 'priority ใหม่', enum: ['critical', 'high', 'medium', 'low'] },
        due_on: { type: 'STRING', description: 'กำหนดส่งใหม่ YYYY-MM-DD' },
        comment: { type: 'STRING', description: 'comment เพิ่มเติม' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'complete_task',
    description: 'ทำเครื่องหมาย task ว่าเสร็จแล้ว พร้อมระบุผลลัพธ์',
    parameters: {
      type: 'OBJECT',
      properties: {
        task_id: { type: 'INTEGER', description: 'ID ของ task' },
        result: { type: 'STRING', description: 'ผลลัพธ์/บันทึกการทำเสร็จ' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'block_task',
    description: 'ทำเครื่องหมาย task ว่าติดขัด (blocked) พร้อมระบุสาเหตุ',
    parameters: {
      type: 'OBJECT',
      properties: {
        task_id: { type: 'INTEGER', description: 'ID ของ task' },
        blocker_description: { type: 'STRING', description: 'สาเหตุที่ติดขัด' },
        blocked_by_task_id: { type: 'INTEGER', description: 'ID ของ task ที่ block อยู่ (ถ้ามี)' },
      },
      required: ['task_id', 'blocker_description'],
    },
  },
  {
    name: 'list_tasks',
    description: 'แสดงรายการ tasks ทั้งหมด — สามารถ filter ตาม status, assignee, category, overdue ได้',
    parameters: {
      type: 'OBJECT',
      properties: {
        status: { type: 'STRING', description: 'กรองตาม status', enum: ['pending', 'in_progress', 'done', 'cancelled', 'blocked', 'all'] },
        assignee_name: { type: 'STRING', description: 'กรองตามผู้รับผิดชอบ' },
        category: { type: 'STRING', description: 'กรองตาม category' },
        overdue_only: { type: 'BOOLEAN', description: 'แสดงเฉพาะงานเลยกำหนด' },
      },
    },
  },
  {
    name: 'get_task_detail',
    description: 'ดูรายละเอียด task แบบเต็ม รวม comments และ blockers',
    parameters: {
      type: 'OBJECT',
      properties: {
        task_id: { type: 'INTEGER', description: 'ID ของ task' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'get_task_summary',
    description: 'สรุปภาพรวมงานทั้งหมด — จำนวนตาม status, assignee, overdue count',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
];

// Resolve assignee name to workspace member
async function resolveAssignee(db, name) {
  if (!name) return null;
  const nameLower = name.toLowerCase();
  // Exact match
  let member = await db.prepare(
    `SELECT id, telegram_user_id, display_name FROM workspace_members
     WHERE is_active = 1 AND LOWER(display_name) = ?`
  ).bind(nameLower).first();
  if (member) return member;

  // Nickname match
  const members = await db.prepare(
    `SELECT id, telegram_user_id, display_name, nicknames FROM workspace_members WHERE is_active = 1`
  ).all();
  for (const m of members.results) {
    try {
      const nicks = JSON.parse(m.nicknames || '[]');
      if (nicks.some(n => n.toLowerCase() === nameLower)) return m;
    } catch { /* skip */ }
  }

  // LIKE match
  member = await db.prepare(
    `SELECT id, telegram_user_id, display_name FROM workspace_members
     WHERE is_active = 1 AND LOWER(display_name) LIKE ?`
  ).bind(`%${nameLower}%`).first();
  return member || null;
}

export const executors = {
  async create_task(env, args, context) {
    const { title, description, assignee_name, due_on, priority, category, expected_output } = args;
    let assigneeId = null;
    let assigneeName = assignee_name || null;

    if (assignee_name) {
      const member = await resolveAssignee(env.DB, assignee_name);
      if (member) {
        assigneeId = member.telegram_user_id;
        assigneeName = member.display_name;
      }
    }

    const desc = description || title;
    const { meta } = await env.DB.prepare(
      `INSERT INTO tasks (description, title, assignee_id, assignee_name, priority, category, expected_output, due_on, created_by_id, created_by_name, chat_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      desc, title || null, assigneeId, assigneeName,
      priority || 'medium', category || null, expected_output || null,
      due_on || null, context.userId || null,
      context.userName || null, context.chatId || null,
    ).run();

    return {
      success: true,
      task_id: meta.last_row_id,
      title: title,
      assignee: assigneeName,
      due_on: due_on || null,
      priority: priority || 'medium',
    };
  },

  async update_task(env, args, context) {
    const { task_id, status, assignee_name, priority, due_on, comment } = args;

    const task = await env.DB.prepare(`SELECT * FROM tasks WHERE id = ?`).bind(task_id).first();
    if (!task) return { error: `ไม่พบ Task #${task_id}` };

    const updates = [];
    const params = [];

    if (status) { updates.push('status = ?'); params.push(status); }
    if (priority) { updates.push('priority = ?'); params.push(priority); }
    if (due_on !== undefined) { updates.push('due_on = ?'); params.push(due_on); }
    if (assignee_name) {
      const member = await resolveAssignee(env.DB, assignee_name);
      updates.push('assignee_id = ?', 'assignee_name = ?');
      params.push(member?.telegram_user_id || null, member?.display_name || assignee_name);
    }
    if (status === 'done' || status === 'cancelled') {
      updates.push("completed_at = datetime('now')");
    }

    if (updates.length > 0) {
      params.push(task_id);
      await env.DB.prepare(
        `UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`
      ).bind(...params).run();
    }

    if (comment) {
      await env.DB.prepare(
        `INSERT INTO task_comments (task_id, user_id, user_name, content, source)
         VALUES (?, ?, ?, ?, 'secretary')`
      ).bind(task_id, context.userId || null, context.userName || null, comment).run();
    }

    return { success: true, task_id, updates_applied: updates.length, comment_added: !!comment };
  },

  async complete_task(env, args, context) {
    const { task_id, result } = args;
    const task = await env.DB.prepare(
      `SELECT id, description, title FROM tasks WHERE id = ? AND status IN ('pending', 'in_progress')`
    ).bind(task_id).first();
    if (!task) return { error: `ไม่พบ Task #${task_id} ที่ยังค้างอยู่` };

    await env.DB.prepare(
      `UPDATE tasks SET status='done', result=?, completed_at=datetime('now') WHERE id=?`
    ).bind(result || null, task_id).run();

    return { success: true, task_id, title: task.title || task.description };
  },

  async block_task(env, args) {
    const { task_id, blocker_description, blocked_by_task_id } = args;
    const task = await env.DB.prepare(
      `SELECT id FROM tasks WHERE id = ? AND status IN ('pending', 'in_progress')`
    ).bind(task_id).first();
    if (!task) return { error: `ไม่พบ Task #${task_id} ที่ยังค้างอยู่` };

    await env.DB.prepare(
      `UPDATE tasks SET status='blocked' WHERE id=?`
    ).bind(task_id).run();

    await env.DB.prepare(
      `INSERT INTO task_blockers (task_id, blocker_description, blocked_by_task_id)
       VALUES (?, ?, ?)`
    ).bind(task_id, blocker_description, blocked_by_task_id || null).run();

    return { success: true, task_id, status: 'blocked' };
  },

  async list_tasks(env, args) {
    const { status, assignee_name, category, overdue_only } = args;
    const todayStr = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

    let where = [];
    let params = [];

    if (status && status !== 'all') {
      where.push('status = ?');
      params.push(status);
    } else if (!status) {
      where.push("status NOT IN ('done', 'cancelled')");
    }

    if (assignee_name) {
      where.push('LOWER(assignee_name) LIKE ?');
      params.push(`%${assignee_name.toLowerCase()}%`);
    }

    if (category) {
      where.push('LOWER(category) LIKE ?');
      params.push(`%${category.toLowerCase()}%`);
    }

    if (overdue_only) {
      where.push('due_on IS NOT NULL AND due_on < ?');
      params.push(todayStr);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const { results } = await env.DB.prepare(
      `SELECT id, description, title, status, assignee_name, priority, due_on, category,
              datetime(created_at, '+7 hours') as created_at
       FROM tasks ${whereClause}
       ORDER BY
         CASE WHEN status = 'blocked' THEN 0
              WHEN status = 'pending' AND due_on IS NOT NULL AND due_on < '${todayStr}' THEN 1
              WHEN priority = 'critical' THEN 2
              WHEN priority = 'high' THEN 3
              ELSE 4 END,
         due_on ASC NULLS LAST, created_at ASC
       LIMIT 30`
    ).bind(...params).all();

    return {
      tasks: results.map(t => ({
        id: t.id,
        title: t.title || t.description,
        status: t.status,
        assignee: t.assignee_name,
        priority: t.priority,
        due_on: t.due_on,
        category: t.category,
        overdue: t.due_on && t.due_on < todayStr && t.status !== 'done' && t.status !== 'cancelled',
      })),
      count: results.length,
      today: todayStr,
    };
  },

  async get_task_detail(env, args) {
    const { task_id } = args;
    const task = await env.DB.prepare(
      `SELECT *, datetime(created_at, '+7 hours') as created_at_bkk,
              datetime(completed_at, '+7 hours') as completed_at_bkk
       FROM tasks WHERE id = ?`
    ).bind(task_id).first();
    if (!task) return { error: `ไม่พบ Task #${task_id}` };

    const { results: comments } = await env.DB.prepare(
      `SELECT user_name, content, source, datetime(created_at, '+7 hours') as created_at
       FROM task_comments WHERE task_id = ? ORDER BY created_at ASC LIMIT 20`
    ).bind(task_id).all();

    const { results: blockers } = await env.DB.prepare(
      `SELECT blocker_description, blocked_by_task_id, resolved,
              datetime(created_at, '+7 hours') as created_at
       FROM task_blockers WHERE task_id = ? ORDER BY created_at ASC`
    ).bind(task_id).all();

    return {
      task: {
        id: task.id,
        title: task.title || task.description,
        description: task.description,
        status: task.status,
        assignee: task.assignee_name,
        priority: task.priority,
        category: task.category,
        due_on: task.due_on,
        expected_output: task.expected_output,
        result: task.result,
        created_by: task.created_by_name,
        created_at: task.created_at_bkk,
        completed_at: task.completed_at_bkk,
      },
      comments,
      blockers,
    };
  },

  async get_task_summary(env) {
    const todayStr = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

    const [statusCounts, assigneeCounts, overdueTasks] = await env.DB.batch([
      env.DB.prepare(
        `SELECT status, COUNT(*) as count FROM tasks
         WHERE status NOT IN ('done', 'cancelled') OR completed_at > datetime('now', '-7 days')
         GROUP BY status`
      ),
      env.DB.prepare(
        `SELECT COALESCE(assignee_name, 'ไม่มีผู้รับผิดชอบ') as assignee, COUNT(*) as count
         FROM tasks WHERE status NOT IN ('done', 'cancelled')
         GROUP BY assignee_name`
      ),
      env.DB.prepare(
        `SELECT id, title, description, assignee_name, due_on, priority
         FROM tasks WHERE status NOT IN ('done', 'cancelled') AND due_on IS NOT NULL AND due_on < ?
         ORDER BY due_on ASC`
      ).bind(todayStr),
    ]);

    return {
      by_status: statusCounts.results,
      by_assignee: assigneeCounts.results,
      overdue: overdueTasks.results.map(t => ({
        id: t.id,
        title: t.title || t.description,
        assignee: t.assignee_name,
        due_on: t.due_on,
        priority: t.priority,
      })),
      today: todayStr,
    };
  },
};
