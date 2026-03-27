// Fallback — regex-based intent extraction when AI fails

const FALLBACK_PATTERNS = [
  {
    // สร้างงาน/task <desc>
    pattern: /(?:สร้างงาน|task)\s+(.+)/i,
    tool: 'create_task',
    extract: (m) => ({ title: m[1].trim(), description: m[1].trim(), priority: 'medium' }),
  },
  {
    // เสร็จ/done #<id> or เสร็จ <id>
    pattern: /(?:เสร็จ|done)\s*#?(\d+)\s*(.*)?/i,
    tool: 'complete_task',
    extract: (m) => ({ task_id: Number(m[1]), result: (m[2] || '').trim() || null }),
  },
  {
    // สรุปงาน/tasks/งาน
    pattern: /^(?:สรุปงาน|tasks|งาน|ดูงาน)$/i,
    tool: 'list_tasks',
    extract: () => ({}),
  },
  {
    // ยกเลิก/cancel #<id>
    pattern: /(?:ยกเลิก|cancel)\s*#?(\d+)/i,
    tool: 'cancel_task',
    extract: (m) => ({ task_id: Number(m[1]) }),
  },
];

export function fallbackIntentExtraction(text) {
  const cleaned = text.trim();
  for (const { pattern, tool, extract } of FALLBACK_PATTERNS) {
    const match = cleaned.match(pattern);
    if (match) {
      return { tool, args: extract(match) };
    }
  }
  return null;
}

export function buildFallbackResponse(botName) {
  return `ขออภัยค่ะ ${botName} ไม่สามารถประมวลผลได้ในตอนนี้ ลองใช้คำสั่งเหล่านี้ค่ะ:
- /tasks — ดูงานทั้งหมด
- /task <รายละเอียด> — สร้างงานใหม่
- /done <id> — ทำงานเสร็จ
- /cancel <id> — ยกเลิกงาน`;
}
