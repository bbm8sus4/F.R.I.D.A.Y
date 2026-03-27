// Query tools — ask_clarification, resolve_user, resolve_task_reference

export const definitions = [
  {
    name: 'ask_clarification',
    description: 'ถามคำถามเพื่อขอข้อมูลเพิ่มเติมจากผู้ใช้ก่อนดำเนินการ เช่น ถามว่าหมายถึง task ไหน หรือต้องการให้ใครทำ',
    parameters: {
      type: 'OBJECT',
      properties: {
        question: { type: 'STRING', description: 'คำถามที่ต้องการถาม' },
        options: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'ตัวเลือกให้เลือก (ถ้ามี)',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'resolve_user_by_name',
    description: 'ค้นหาสมาชิกในทีมจากชื่อ ชื่อเล่น หรือชื่อบางส่วน',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'ชื่อหรือชื่อเล่นที่ต้องการค้นหา' },
      },
      required: ['name'],
    },
  },
  {
    name: 'resolve_task_reference',
    description: 'ค้นหา task จากคำอธิบาย keyword หรือชื่อบางส่วน (fuzzy search)',
    parameters: {
      type: 'OBJECT',
      properties: {
        description_hint: { type: 'STRING', description: 'คำหรือข้อความบางส่วนที่เกี่ยวกับ task' },
      },
      required: ['description_hint'],
    },
  },
];

export const executors = {
  // ask_clarification is handled specially in tool-executor.js (never reaches here)
  async ask_clarification() {
    return { error: 'Should not be called directly' };
  },

  async resolve_user_by_name(env, args) {
    const { name } = args;
    const nameLower = name.toLowerCase();

    // Exact display_name match
    let { results } = await env.DB.prepare(
      `SELECT id, telegram_user_id, telegram_username, display_name, nicknames, role, department
       FROM workspace_members WHERE is_active = 1 AND LOWER(display_name) = ?`
    ).bind(nameLower).all();

    if (results.length > 0) {
      return { matches: results.map(formatMember), exact: true };
    }

    // Nickname match
    const all = await env.DB.prepare(
      `SELECT id, telegram_user_id, telegram_username, display_name, nicknames, role, department
       FROM workspace_members WHERE is_active = 1`
    ).all();

    const nicknameMatches = all.results.filter(m => {
      try {
        const nicks = JSON.parse(m.nicknames || '[]');
        return nicks.some(n => n.toLowerCase() === nameLower);
      } catch { return false; }
    });

    if (nicknameMatches.length > 0) {
      return { matches: nicknameMatches.map(formatMember), exact: true };
    }

    // Partial match
    const partialResults = await env.DB.prepare(
      `SELECT id, telegram_user_id, telegram_username, display_name, nicknames, role, department
       FROM workspace_members WHERE is_active = 1 AND LOWER(display_name) LIKE ?`
    ).bind(`%${nameLower}%`).all();

    return {
      matches: partialResults.results.map(formatMember),
      exact: false,
    };
  },

  async resolve_task_reference(env, args) {
    const { description_hint } = args;
    const keywords = description_hint.toLowerCase().split(/\s+/).filter(w => w.length > 1);

    if (keywords.length === 0) {
      return { error: 'ไม่มี keyword ในการค้นหา' };
    }

    const likeConditions = keywords.map(() => '(LOWER(COALESCE(title, description)) LIKE ?)').join(' OR ');
    const likeParams = keywords.map(k => `%${k}%`);

    const { results } = await env.DB.prepare(
      `SELECT id, title, description, status, assignee_name, priority, due_on
       FROM tasks
       WHERE ${likeConditions}
       ORDER BY
         CASE WHEN status IN ('pending', 'in_progress', 'blocked') THEN 0 ELSE 1 END,
         created_at DESC
       LIMIT 5`
    ).bind(...likeParams).all();

    return {
      tasks: results.map(t => ({
        id: t.id,
        title: t.title || t.description,
        status: t.status,
        assignee: t.assignee_name,
        priority: t.priority,
        due_on: t.due_on,
      })),
      count: results.length,
    };
  },
};

function formatMember(m) {
  return {
    id: m.id,
    telegram_user_id: m.telegram_user_id,
    display_name: m.display_name,
    role: m.role,
    department: m.department,
  };
}
