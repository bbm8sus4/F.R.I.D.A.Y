// Memory tools — save and delete memories via secretary

const VALID_CATEGORIES = ['person', 'preference', 'rule', 'project', 'task', 'general'];

async function autoClassify(env, content) {
  try {
    if (!env.GEMINI_API_KEY) return 'general';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const model = env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `จัดหมวดข้อความนี้เป็นหนึ่งใน: ${VALID_CATEGORIES.join(', ')}\n\nข้อความ: "${content}"\n\nตอบแค่คำเดียว (ชื่อหมวด):` }] }],
        generationConfig: { maxOutputTokens: 10, temperature: 0 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return 'general';
    const data = await res.json();
    const answer = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().toLowerCase();
    return VALID_CATEGORIES.includes(answer) ? answer : 'general';
  } catch (e) {
    console.error('autoClassify error:', e);
    return 'general';
  }
}

export const definitions = [
  {
    name: 'save_memory',
    description: 'บันทึกความจำถาวร — จำข้อมูล ข้อเท็จจริง กฎ ความชอบ บุคคล ฯลฯ ที่บอสบอกให้จำ',
    parameters: {
      type: 'OBJECT',
      properties: {
        content: { type: 'STRING', description: 'เนื้อหาที่จะจำ (จำเป็น)' },
        category: { type: 'STRING', description: 'หมวดหมู่: person, preference, rule, project, task, general (ถ้าไม่ระบุจะจัดอัตโนมัติ)' },
      },
      required: ['content'],
    },
  },
  {
    name: 'delete_memory',
    description: 'ลบความจำถาวร — ดู memory_id จาก context [#id]',
    parameters: {
      type: 'OBJECT',
      properties: {
        memory_id: { type: 'INTEGER', description: 'ID ของความจำที่จะลบ (ดูจาก context #id)' },
      },
      required: ['memory_id'],
    },
  },
];

export const executors = {
  async save_memory(env, args) {
    const { content, category } = args;
    if (!content || !content.trim()) {
      return { error: 'กรุณาระบุเนื้อหาที่จะจำค่ะ' };
    }

    // Validate or auto-classify category
    let finalCategory = category?.trim().toLowerCase();
    if (finalCategory && !VALID_CATEGORIES.includes(finalCategory)) {
      finalCategory = null;
    }
    if (!finalCategory) {
      finalCategory = await autoClassify(env, content.trim());
    }

    const { meta } = await env.DB
      .prepare('INSERT INTO memories (content, category) VALUES (?, ?)')
      .bind(content.trim(), finalCategory)
      .run();

    return {
      success: true,
      memory_id: meta.last_row_id,
      content: content.trim(),
      category: finalCategory,
    };
  },

  async delete_memory(env, args) {
    const { memory_id } = args;
    if (!memory_id) {
      return { error: 'กรุณาระบุ memory_id ที่จะลบค่ะ' };
    }

    // Check if memory exists
    const existing = await env.DB
      .prepare('SELECT id FROM memories WHERE id = ?')
      .bind(memory_id)
      .first();
    if (!existing) {
      return { error: `ไม่พบความจำ #${memory_id} ค่ะ` };
    }

    await env.DB
      .prepare('DELETE FROM memories WHERE id = ?')
      .bind(memory_id)
      .run();

    return {
      success: true,
      memory_id,
    };
  },
};
