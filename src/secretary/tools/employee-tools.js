// Employee tools — manage workspace members

export const definitions = [
  {
    name: 'add_member',
    description: 'เพิ่มสมาชิกใน workspace — ระบุชื่อ, ชื่อเล่น, telegram_user_id, role, department',
    parameters: {
      type: 'OBJECT',
      properties: {
        display_name: { type: 'STRING', description: 'ชื่อเต็มของสมาชิก' },
        nicknames: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'ชื่อเล่น/ชื่อย่อ',
        },
        telegram_user_id: { type: 'INTEGER', description: 'Telegram user ID (ถ้ามี)' },
        telegram_username: { type: 'STRING', description: 'Telegram username (ถ้ามี)' },
        role: { type: 'STRING', description: 'บทบาท เช่น employee, manager, intern', enum: ['employee', 'manager', 'intern'] },
        department: { type: 'STRING', description: 'แผนก/ทีม' },
      },
      required: ['display_name'],
    },
  },
  {
    name: 'list_members',
    description: 'แสดงรายชื่อสมาชิกทั้งหมดใน workspace',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
];

export const executors = {
  async add_member(env, args) {
    const { display_name, nicknames, telegram_user_id, telegram_username, role, department } = args;

    // Check duplicate
    if (telegram_user_id) {
      const existing = await env.DB.prepare(
        `SELECT id FROM workspace_members WHERE telegram_user_id = ?`
      ).bind(telegram_user_id).first();
      if (existing) return { error: `สมาชิกที่มี Telegram ID ${telegram_user_id} มีอยู่แล้ว (id: ${existing.id})` };
    }

    const { meta } = await env.DB.prepare(
      `INSERT INTO workspace_members (display_name, nicknames, telegram_user_id, telegram_username, role, department)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      display_name,
      JSON.stringify(nicknames || []),
      telegram_user_id || null,
      telegram_username || null,
      role || 'employee',
      department || null,
    ).run();

    return {
      success: true,
      member_id: meta.last_row_id,
      display_name,
    };
  },

  async list_members(env) {
    const { results } = await env.DB.prepare(
      `SELECT id, display_name, nicknames, telegram_user_id, telegram_username, role, department
       FROM workspace_members WHERE is_active = 1
       ORDER BY display_name ASC`
    ).all();

    return {
      members: results.map(m => ({
        id: m.id,
        display_name: m.display_name,
        nicknames: JSON.parse(m.nicknames || '[]'),
        telegram_user_id: m.telegram_user_id,
        telegram_username: m.telegram_username,
        role: m.role,
        department: m.department,
      })),
      count: results.length,
    };
  },
};
