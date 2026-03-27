// Guardrails — confirmation rules and permission checks for secretary tools

// Tools that require explicit user confirmation before execution
const CONFIRMATION_REQUIRED = new Set([
  'send_message',
]);

// Tools that require confirmation in specific conditions
const CONDITIONAL_CONFIRMATION = {
  update_task: (args) => !!args.assignee_name, // reassigning needs confirmation
  complete_task: (args, context) => {
    // Completing on behalf of another person needs confirmation for members
    return context.role === 'member';
  },
};

// Tools that members cannot use at all
const BOSS_ONLY_TOOLS = new Set([
  'send_message',
  'add_member',
  'schedule_reminder',
]);

// Member permission: can only modify own tasks
const MEMBER_TASK_TOOLS = new Set([
  'update_task',
  'complete_task',
  'block_task',
]);

export function requiresConfirmation(toolName, args, context) {
  if (CONFIRMATION_REQUIRED.has(toolName)) return true;
  const checker = CONDITIONAL_CONFIRMATION[toolName];
  if (checker && checker(args, context)) return true;
  return false;
}

export function checkPermission(toolName, args, context) {
  const { role, userId } = context;

  // Boss can do everything
  if (role === 'boss') return { allowed: true };

  // Member restrictions
  if (role === 'member') {
    if (BOSS_ONLY_TOOLS.has(toolName)) {
      return { allowed: false, reason: 'เฉพาะบอสเท่านั้นที่ใช้ฟังก์ชันนี้ได้ค่ะ' };
    }

    // Member task tools — only own tasks
    if (MEMBER_TASK_TOOLS.has(toolName) && args.task_id) {
      // Permission check happens at execution time (need DB lookup)
      // Return allowed here, executor will check ownership
      return { allowed: true, checkOwnership: true };
    }
  }

  return { allowed: true };
}

export async function checkTaskOwnership(db, taskId, userId) {
  try {
    const task = await db.prepare(
      `SELECT assignee_id, created_by_id FROM tasks WHERE id = ?`
    ).bind(taskId).first();
    if (!task) return false;
    return task.assignee_id === userId || task.created_by_id === userId;
  } catch {
    return false;
  }
}
