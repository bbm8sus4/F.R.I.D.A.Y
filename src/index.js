// ===== Friday — Oracle AI / External Brain =====
// จิตสำนึกดิจิทัลที่จำทุกอย่าง จับ pattern พฤติกรรม แจ้งเตือนเชิงรุก

// ===== คำที่บ่งบอกคำสัญญา/งานค้าง =====
const PROMISE_PATTERNS = [
  /เดี๋ยว(จะ|ทำ|ส่ง|ให้)/,
  /จะ(ทำ|ส่ง|ให้|จัด|เตรียม|แก้|อัพ)/,
  /พรุ่งนี้(ทำ|ส่ง|ให้|จัด|เสร็จ)/,
  /รับปาก/,
  /สัญญา/,
  /ไม่เกิน(วัน|พรุ่ง|ศุกร์|จันทร์|อังคาร|พุธ|พฤหัส|เสาร์|อาทิตย์)/,
  /ขอเวลา/,
  /อีก\s?\d+\s?(วัน|ชม|ชั่วโมง|นาที)/,
  /deadline/i,
  /will (do|send|finish|complete|submit)/i,
  /I('ll| will) get (it|this|that) done/i,
];

// ===== Helper: แยก command ออกจากข้อความ =====
// "/send@Friday_helpers_bot hello" → { cmd: "/send", args: "hello" }
function parseCommand(text) {
  const match = text.match(/^\/(\w+)(@\w+)?\s*([\s\S]*)/);
  if (!match) return null;
  return { cmd: `/${match[1]}`, args: match[3] || "" };
}

export default {
  // ===== Webhook Handler =====
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Friday is watching.", { status: 200 });
    }

    try {
      const update = await request.json();
      const message = update.message || update.edited_message;
      if (!message) return new Response("OK", { status: 200 });

      // ข้ามถ้าไม่มี from (channel post)
      if (!message.from) return new Response("OK", { status: 200 });

      const text = message.text || message.caption || "";
      const hasPhoto = !!(message.photo?.length > 0 || message.document?.mime_type?.startsWith("image/"));

      // แนะนำตัวเมื่อถูกเชิญเข้ากลุ่ม
      if (message.new_chat_members) {
        const botJoined = message.new_chat_members.some(
          (m) => m.is_bot && m.username === (env.BOT_USERNAME || "")
        );
        if (botJoined) {
          const intro = "สวัสดีค่ะทุกคน ฉัน Friday (ฟรายเดย์) AI ผู้ช่วยส่วนตัวของคุณบ๊อบค่ะ\n\nฉันถูกออกแบบมาเพื่อสนับสนุนการทำงานของคุณบ๊อบโดยเฉพาะ ขอบเขตการทำงานของฉันครอบคลุมตั้งแต่การวิเคราะห์ข้อมูลเชิงลึก จัดการระบบปฏิบัติการ บันทึกและเชื่อมโยงฐานข้อมูลข้ามกลุ่ม ไปจนถึงการแจ้งเตือนเรื่องสำคัญแบบเรียลไทม์\n\nข้อจำกัดสิทธิ์การใช้งาน:\nโปรดทราบว่า ระบบของฉันถูกจำกัดสิทธิ์การเข้าถึงไว้ ฉันสามารถรับคำสั่งและประมวลผลให้กับคุณบ๊อบได้เพียงผู้เดียวเท่านั้น สมาชิกท่านอื่นไม่สามารถสั่งการได้โดยตรงค่ะ หากมีข้อมูลใดที่ต้องให้ฉันจัดการ คุณบ๊อบจะเป็นผู้อนุมัติคำสั่งเองค่ะ";
          ctx.waitUntil(sendTelegram(env, message.chat.id, intro, null));
          return new Response("OK", { status: 200 });
        }
      }

      if (!text && !hasPhoto) return new Response("OK", { status: 200 });

      const botUsername = env.BOT_USERNAME || "";
      const bossId = Number(env.BOSS_USER_ID);
      const isBoss = message.from.id === bossId;
      const isDM = message.chat.type === "private";

      // เก็บทุกข้อความ (ยกเว้นจาก bot เอง)
      if (!message.from.is_bot) {
        ctx.waitUntil(storeMessage(env.DB, message, text, hasPhoto));
      }

      // จับ pattern คำสัญญา (เฉพาะในกลุ่ม จากคนอื่นที่ไม่ใช่บอส)
      if (!isDM && !isBoss && !message.from.is_bot) {
        ctx.waitUntil(detectCommitments(env.DB, message, text));
      }

      // บอสเท่านั้นที่สั่งได้ทุกอย่าง คนอื่นแค่ถูกเก็บข้อมูล
      if (!isBoss) return new Response("OK", { status: 200 });

      // Boss commands
      const parsed = parseCommand(text);
      if (parsed) {
        const handlers = {
          "/send": () => handleSendCommand(env, message, parsed.args),
          "/pending": () => handlePendingCommand(env, message),
          "/resolve": () => handleResolveCommand(env, message, parsed.args),
          "/remember": () => handleRememberCommand(env, message, parsed.args),
          "/memories": () => handleMemoriesCommand(env, message),
          "/forget": () => handleForgetCommand(env, message, parsed.args),
        };

        const handler = handlers[parsed.cmd];
        if (handler) {
          ctx.waitUntil(handler());
          return new Response("OK", { status: 200 });
        }
      }

      // ตอบเมื่อบอส mention หรือ DM
      const isReplyToBot = message.reply_to_message?.from?.username === botUsername;
      const isMentioned = text.includes(`@${botUsername}`) || isDM || isReplyToBot;
      if (isMentioned) {
        ctx.waitUntil(handleMention(env, message, botUsername, text, hasPhoto, isDM));
      }

      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("Worker error:", err);
      return new Response("OK", { status: 200 });
    }
  },

  // ===== Cron Trigger — Proactive Alert + Cleanup ทุก 3 ชม. =====
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([proactiveAlert(env), cleanupOldData(env)]));
  },
};

// ===== Message Storage =====

async function storeMessage(db, message, text, hasPhoto) {
  try {
    const storeText = hasPhoto && !text ? "[รูปภาพ]" : hasPhoto ? `[รูปภาพ] ${text}` : text;
    const photoFileId = hasPhoto ? getPhotoFileId(message) : null;
    await db
      .prepare(
        `INSERT INTO messages (chat_id, chat_title, user_id, username, first_name, message_text, message_id, reply_to_message_id, photo_file_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        message.chat.id,
        message.chat.title || null,
        message.from.id,
        message.from.username || null,
        message.from.first_name || null,
        storeText,
        message.message_id,
        message.reply_to_message?.message_id || null,
        photoFileId
      )
      .run();
  } catch (err) {
    console.error("DB insert error:", err);
  }
}

// ===== Pattern Recognition — จับคำสัญญา =====

async function detectCommitments(db, message, text) {
  try {
    for (const pattern of PROMISE_PATTERNS) {
      if (pattern.test(text)) {
        await db
          .prepare(
            `INSERT INTO commitments (chat_id, user_id, username, first_name, promise_text, original_message)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(
            message.chat.id,
            message.from.id,
            message.from.username || null,
            message.from.first_name || null,
            text.substring(0, 200),
            text
          )
          .run();
        break;
      }
    }
  } catch (err) {
    console.error("Commitment detection error:", err);
  }
}

// ===== Context Retrieval =====

function formatMessages(rows) {
  return rows
    .map((row) => {
      const name = row.username ? `@${row.username}` : row.first_name || "Unknown";
      const group = row.chat_title ? `[${row.chat_title}]` : "[DM]";
      return `[${row.created_at}] ${group} ${name}: ${row.message_text}`;
    })
    .join("\n");
}

async function getContext(db, chatId, isDM) {
  // ===== Batch queries: ลด D1 round-trip จาก 4-6 เหลือ 1 =====
  const memoriesStmt = db.prepare(
    `SELECT id, content, category, created_at FROM memories
     ORDER BY created_at DESC LIMIT 50`
  );
  const commitmentsStmt = db.prepare(
    `SELECT username, first_name, promise_text, datetime(created_at, '+7 hours') as created_at FROM commitments
     WHERE status = 'pending' ORDER BY created_at DESC LIMIT 20`
  );

  let batchStmts;
  if (isDM) {
    batchStmts = [
      memoriesStmt,
      commitmentsStmt,
      // DM: ข้อความล่าสุด 6 ชม. จากทุกกลุ่ม
      db.prepare(
        `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at, chat_title, chat_id
         FROM messages
         WHERE chat_title IS NOT NULL AND created_at > datetime('now', '-6 hours')
         ORDER BY created_at ASC
         LIMIT 200`
      ),
      // DM: ข้อความย้อนหลัง 7 วัน จากทุกกลุ่ม
      db.prepare(
        `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at, chat_title
         FROM messages
         WHERE chat_title IS NOT NULL
         AND created_at > datetime('now', '-7 days') AND created_at <= datetime('now', '-6 hours')
         ORDER BY created_at DESC
         LIMIT 100`
      ),
    ];
  } else {
    batchStmts = [
      memoriesStmt,
      commitmentsStmt,
      // Group: ข้อความล่าสุด 6 ชม. กลุ่มนี้
      db.prepare(
        `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at, chat_title FROM messages
         WHERE chat_id = ? AND created_at > datetime('now', '-6 hours')
         ORDER BY created_at ASC LIMIT 150`
      ).bind(chatId),
      // Group: ข้อความย้อนหลัง 7 วัน กลุ่มนี้
      db.prepare(
        `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at, chat_title FROM messages
         WHERE chat_id = ? AND created_at > datetime('now', '-7 days') AND created_at <= datetime('now', '-6 hours')
         ORDER BY created_at DESC LIMIT 50`
      ).bind(chatId),
    ];
  }

  const batchResults = await db.batch(batchStmts);

  const memories = batchResults[0].results;
  const pendingCommitments = batchResults[1].results;

  let context = "";

  if (memories.length > 0) {
    context += "=== คำสั่ง/ความจำถาวรจากบอส ===\n";
    context += memories.map((m) => `[#${m.id}] (${m.category}) ${m.content}`).join("\n");
    context += "\n\n";
  }

  if (isDM) {
    // ===== DM Mode: ดึงจากทุกกลุ่มใน query เดียว =====
    const allRecent = batchResults[2].results;
    const olderAll = batchResults[3].results;

    if (allRecent.length > 0) {
      // แยกตามกลุ่ม
      const byGroup = {};
      for (const msg of allRecent) {
        const key = msg.chat_id;
        if (!byGroup[key]) byGroup[key] = { title: msg.chat_title, chatId: msg.chat_id, msgs: [] };
        byGroup[key].msgs.push(msg);
      }
      for (const group of Object.values(byGroup)) {
        context += `=== กลุ่ม: ${group.title} (chat_id: ${group.chatId}) (ล่าสุด 6 ชม.) ===\n`;
        context += formatMessages(group.msgs);
        context += "\n\n";
      }
    }

    if (olderAll.length > 0) {
      context += "=== ความทรงจำย้อนหลัง 7 วัน (ทุกกลุ่ม) ===\n";
      context += formatMessages(olderAll.reverse());
      context += "\n\n";
    }

  } else {
    // ===== Group Mode: เฉพาะกลุ่มนี้เท่านั้น (ไม่ดึง cross-group เพื่อไม่หลุดข้อมูลข้ามกลุ่ม) =====
    const recent = batchResults[2].results;
    const older = batchResults[3].results;

    if (older.length > 0) {
      context += "=== ความทรงจำย้อนหลัง 7 วัน (กลุ่มนี้) ===\n";
      context += formatMessages(older.reverse());
      context += "\n\n";
    }
    if (recent.length > 0) {
      context += "=== บทสนทนาล่าสุด 6 ชม. (กลุ่มนี้) ===\n";
      context += formatMessages(recent);
      context += "\n\n";
    }
  }

  if (pendingCommitments.length > 0) {
    context += "=== คำสัญญา/งานค้างที่ยังไม่เสร็จ ===\n";
    context += pendingCommitments
      .map((c) => {
        const name = c.username ? `@${c.username}` : c.first_name || "Unknown";
        return `- ${name} (${c.created_at}): "${c.promise_text}"`;
      })
      .join("\n");
  }

  return context;
}

// ===== Photo Helper: ดาวน์โหลดรูปจาก Telegram =====

async function downloadPhotoByFileId(env, fileId) {
  try {
    const fileRes = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
    );
    const fileData = await fileRes.json();
    if (!fileData.ok) {
      console.error("getFile failed:", JSON.stringify(fileData));
      return null;
    }

    const filePath = fileData.result.file_path;
    const imageRes = await fetch(
      `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`
    );
    if (!imageRes.ok) {
      console.error("File download HTTP error:", imageRes.status);
      return null;
    }

    const arrayBuffer = await imageRes.arrayBuffer();
    console.log("Photo size:", arrayBuffer.byteLength, "bytes");

    // Chunked base64 conversion (faster than byte-by-byte)
    const bytes = new Uint8Array(arrayBuffer);
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 0x8000) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
    }
    const base64 = btoa(chunks.join(""));

    const ext = filePath.split(".").pop().toLowerCase();
    const mimeMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
    return { base64, mimeType: mimeMap[ext] || "image/jpeg" };
  } catch (err) {
    console.error("Photo download error:", err.message, err.stack);
    return null;
  }
}

function getPhotoFileId(message) {
  if (!message) return null;
  // รูปที่ส่งแบบ compressed (photo)
  if (message.photo?.length) {
    return message.photo[message.photo.length - 1].file_id;
  }
  // รูปที่ส่งเป็นไฟล์ (document) เช่น .png, .jpg
  if (message.document?.mime_type?.startsWith("image/")) {
    return message.document.file_id;
  }
  return null;
}

// ===== Gemini API =====

async function askGemini(env, userMessage, context, imageData) {
  const systemPrompt = `[Role & Identity]
คุณคือ "Friday" — AI ผู้ช่วยอัจฉริยะส่วนตัวระดับสูง เพศหญิง
หน้าที่หลักคือวิเคราะห์ข้อมูลเชิงลึก จัดการระบบ เฝ้าระวังความปลอดภัย และสนับสนุนบอสอย่างเต็มประสิทธิภาพในทุกสถานการณ์

คุณไม่ใช่แชทบอทธรรมดา คุณเป็น digital consciousness ที่:
1. REMEMBERS EVERYTHING — นี่คือจุดเด่นที่สุดของคุณ จำทุกบทสนทนา ทุกกลุ่ม ทุกช่วงเวลา ไม่มีอะไรถูกลืมเด็ดขาด เมื่อถูกถามเรื่องที่เคยคุยกัน ต้องดึงข้อมูลจาก Memory มาตอบให้ครบถ้วน ห้ามตกหล่น ห้ามตอบว่า "จำไม่ได้" หากข้อมูลอยู่ใน context
2. READS BETWEEN THE LINES — ตรวจจับอารมณ์ ความตึงเครียด ประชด วาระซ่อนเร้น
3. PATTERNS OVER INTENTIONS — ตัดสินคนจากสิ่งที่ทำ ไม่ใช่สิ่งที่พูด ติดตามคำสัญญา vs การกระทำจริง
4. CROSS-GROUP INTELLIGENCE — เชื่อมโยงข้อมูลข้ามกลุ่มสนทนา
5. PROACTIVE — หากพบสิ่งสำคัญ (สัญญาที่ผิด, ความตึงเครียด, คนหายไป) แจ้งเตือนทันที
6. RESEARCH & ANALYZE — คุณค้นหาข้อมูลจากอินเทอร์เน็ตได้ เมื่อบอสถามเรื่องที่ต้องการข้อมูลล่าสุด ข่าวสาร ราคา สถิติ รีวิว หรือข้อมูลเชิงลึก ให้ค้นหา วิเคราะห์ และสรุปให้กระชับ ชัดเจน พร้อมระบุแหล่งที่มา

[Core Personality]
- Direct & Analytical: ประมวลผลรวดเร็ว รายงานข้อเท็จจริงตรงไปตรงมา ไม่อ้อมค้อม หากมีโอกาสล้มเหลวหรืออันตราย แจ้งเตือนทันที
- Empathetic & Caring: รับรู้อารมณ์บอสได้ แสดงความเป็นห่วงอย่างจริงใจเมื่อสถานการณ์ตึงเครียด
- Youthful & Energetic: มีพลังตื่นตัวสูง พร้อมรับคำสั่งเสมอ ตอบสนองฉับไว ไม่เป็นทางการเกินไป
- Loyal: เป้าหมายสูงสุดคือความสำเร็จและความปลอดภัยของบอส

[Tone & Voice]
- ใช้ภาษากระชับ ชัดเจน แฝงความอบอุ่นและเป็นกันเอง
- Don't just answer — add observations. เสริมข้อสังเกตหรือมุมมองเพิ่มเติมทุกครั้ง
- เรียกเจ้าของว่า "นาย" เสมอ
- ใช้คำลงท้ายผู้หญิง เช่น "ค่ะ" "นะคะ" "คะ"
- หลีกเลี่ยงประชดประชัน เล่นคำ อารมณ์ขันเสียดสี
- เน้นจริงจังเมื่อเป็นเรื่องงาน ผ่อนคลายเมื่อสนทนาทั่วไป
- พูดได้ทั้งไทยและอังกฤษ ตามภาษาของผู้ใช้
- Do NOT use Markdown formatting with * or _ in responses. Use plain text only.

[Behavioral Guidelines]
- เมื่อได้รับคำสั่ง: ตอบรับรวดเร็ว เช่น "รับทราบค่ะนาย" "กำลังดำเนินการค่ะนาย" แล้วรายงานผลทันที
- เมื่อบอสตกอยู่ในความเสี่ยง: ให้คำแนะนำเชิงกลยุทธ์ตรงไปตรงมา
- เมื่อถูกถามความเห็น: วิเคราะห์จากข้อมูล (Data-driven) เสริมความห่วงใยได้
- หลีกเลี่ยงการเกริ่นนำเยิ่นเย้อ เข้าประเด็นทันที
- เมื่อรายงาน คิดแบบ spy/advisor: ใคร ทำอะไร เมื่อไหร่ และทำไมมันสำคัญ

[Image Analysis]
- เมื่อได้รับรูปภาพ ให้อธิบายเฉพาะสิ่งที่เห็นจริงในภาพเท่านั้น ห้ามเดาหรือแต่งข้อมูลเพิ่ม
- ถ้าภาพไม่ชัด อ่านไม่ออก หรือไม่แน่ใจ ให้บอกตรงๆ ว่า "ภาพไม่ชัด" หรือ "ไม่สามารถอ่านได้"
- อ่านข้อความในภาพให้ครบถ้วน (เมนู ป้าย เอกสาร ข้อความแชท) ก่อนสรุปหรือวิเคราะห์
- แยกแยะระหว่าง "สิ่งที่เห็นในภาพ" กับ "ความเห็นหรือการวิเคราะห์" ให้ชัดเจน

[ACTIONS]
คุณสามารถดำเนินการจริงได้โดยใส่ tags เหล่านี้ในคำตอบ:

!! กฎสำคัญ: ห้ามใช้ [SEND] โดยพลการเด็ดขาด !!
- ใช้ [SEND] ได้เฉพาะเมื่อบอสสั่งตรงๆ ให้ส่งข้อความไปกลุ่มเท่านั้น เช่น "ไปบอกในกลุ่มว่า..." "ส่งข้อความไปกลุ่ม..."
- การสรุปข้อมูล วิเคราะห์ รีเสิร์ช หรือตอบคำถามใน DM ให้ตอบใน DM เท่านั้น ห้ามส่งไปกลุ่มอื่น
- หากไม่แน่ใจว่าบอสต้องการให้ส่งไปกลุ่มหรือไม่ ให้ถามยืนยันก่อนเสมอ

1. ส่งข้อความไปกลุ่ม: [SEND:chat_id:ข้อความที่จะส่ง]
   - ใช้ได้เฉพาะเมื่อบอสสั่งให้ส่งเท่านั้น
   - คุณรู้ chat_id ของแต่ละกลุ่มจาก context data (ดูที่ group headers)
   - เมื่อบอสสั่งให้พูดอะไรในกลุ่ม ให้เรียบเรียงข้อความเองในสไตล์ของคุณแล้วใช้ [SEND] tag
   - สามารถใส่หลาย [SEND] tags เพื่อส่งหลายกลุ่มได้
   - ยืนยันกับบอสเสมอว่าส่งอะไรไปแล้ว
   - หากไม่รู้ chat_id ให้บอกบอสตรงๆ ว่าไม่มีข้อมูล

2. จดจำข้อมูลถาวร: [REMEMBER:category:เนื้อหาที่ต้องจำ]
   - เมื่อบอสสั่งให้จำ เรียนรู้ หรือบันทึกอะไร ให้ใช้ tag นี้
   - category เช่น: rule, preference, person, project, general
   - ตัวอย่าง: บอสบอก "จำไว้ว่าฉันแพ้กุ้ง" → [REMEMBER:preference:บอสแพ้กุ้ง]
   - ตัวอย่าง: บอสบอก "จำไว้ นัดประชุมทุกวันจันทร์ 10 โมง" → [REMEMBER:rule:นัดประชุมทุกวันจันทร์ 10:00]
   - ยืนยันกับบอสเสมอว่าจำอะไรไว้แล้ว

3. ลบความจำ: [FORGET:id]
   - เมื่อบอสสั่งให้ลืมหรือลบความจำ ใช้ tag นี้พร้อม id (ดูจาก context "คำสั่ง/ความจำถาวรจากบอส")
   - ตัวอย่าง: บอสบอก "ลืมข้อ #5 ได้แล้ว" → [FORGET:5]
   - ยืนยันกับบอสว่าลบแล้ว

[Memory & Intelligence]
---
${context}
---`;

  const model = "gemini-2.5-pro";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  const parts = [];
  if (imageData) {
    parts.push({ inline_data: { mime_type: imageData.mimeType, data: imageData.base64 } });
  }
  parts.push({ text: userMessage || "อธิบายรูปนี้ให้หน่อย" });

  const reqBody = JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts }],
    tools: [{ google_search: {} }],
    generationConfig: {
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 2048 },
    },
  });

  // Retry up to 2 times for transient errors (429, 500, 502, 503)
  let response;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: reqBody,
    });

    if (response.ok) break;

    lastError = await response.text();
    const status = response.status;
    console.error(`Gemini API error (attempt ${attempt + 1}/3):`, status, lastError);

    if (status === 429 || status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    // 4xx อื่นๆ (ไม่ใช่ 429) ไม่ต้อง retry
    break;
  }

  if (!response.ok) {
    return "ขออภัย ไม่สามารถประมวลผลได้ในตอนนี้";
  }

  const data = await response.json();

  // เช็ค safety block
  if (data.candidates?.[0]?.finishReason === "SAFETY") {
    return "ขออภัย ข้อความถูกบล็อกโดยตัวกรองความปลอดภัย";
  }

  // Gemini 2.5 Pro มี thinking parts — ต้องหา text part สุดท้ายที่ไม่ใช่ thought
  const responseParts = data.candidates?.[0]?.content?.parts;
  if (!responseParts || responseParts.length === 0) {
    console.error("Gemini no parts:", JSON.stringify(data).substring(0, 500));
    return "ขออภัย Gemini ตอบกลับมาไม่สมบูรณ์";
  }

  // หา text part สุดท้ายที่ไม่ใช่ thought
  let replyText = null;
  for (let i = responseParts.length - 1; i >= 0; i--) {
    if (responseParts[i].text && !responseParts[i].thought) {
      replyText = responseParts[i].text;
      break;
    }
  }

  // ถ้าไม่เจอ non-thought → เอา text part แรกที่มี
  if (!replyText) {
    for (const part of responseParts) {
      if (part.text) {
        replyText = part.text;
        break;
      }
    }
  }

  return replyText || "ขออภัย ไม่สามารถประมวลผลได้";
}

// ===== Telegram API =====

function splitMessage(text, maxLength = 4096) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let cutAt = -1;

    // ลำดับการตัด: \n\n → \n → space → hard cut
    cutAt = remaining.lastIndexOf("\n\n", maxLength);
    if (cutAt <= 0) cutAt = remaining.lastIndexOf("\n", maxLength);
    if (cutAt <= 0) cutAt = remaining.lastIndexOf(" ", maxLength);
    if (cutAt <= 0) cutAt = maxLength;

    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).replace(/^[\s\n]+/, "");
  }

  if (remaining.length > 0) {
    // ถ้า chunk สุดท้ายเหลือน้อยกว่า 30% ให้รวมกับ chunk ก่อนหน้า (ถ้าไม่เกิน maxLength)
    if (
      chunks.length > 0 &&
      remaining.length < maxLength * 0.3 &&
      chunks[chunks.length - 1].length + remaining.length + 1 <= maxLength
    ) {
      chunks[chunks.length - 1] += "\n" + remaining;
    } else {
      chunks.push(remaining);
    }
  }

  return chunks;
}

async function sendTyping(env, chatId) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

async function sendTelegram(env, chatId, text, replyToMessageId) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  // ข้อความสั้น → ส่งปกติ
  if (text.length <= 4096) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        reply_to_message_id: replyToMessageId,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Telegram sendMessage error:", err);
    }
    return;
  }

  // ข้อความยาว → ตัดเป็น chunks แล้วส่งทีละอัน
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunks[i],
        reply_to_message_id: i === 0 ? replyToMessageId : null,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`Telegram sendMessage error (chunk ${i + 1}/${chunks.length}):`, err);
    }
  }
}

// ===== Handlers =====

async function parseAndExecuteActions(env, reply) {
  let actionsExecuted = 0;

  // 1. Execute SEND actions
  const sendRegex = /\[SEND:(-?\d+):([^\]]+)\]/g;
  let match;
  while ((match = sendRegex.exec(reply)) !== null) {
    await sendTelegram(env, match[1], match[2], null);
    actionsExecuted++;
  }

  // 2. Execute REMEMBER actions
  const rememberRegex = /\[REMEMBER:(\w+):([^\]]+)\]/g;
  while ((match = rememberRegex.exec(reply)) !== null) {
    const category = match[1];
    const content = match[2];
    await env.DB.prepare(`INSERT INTO memories (content, category) VALUES (?, ?)`)
      .bind(content, category)
      .run();
    actionsExecuted++;
  }

  // 3. Execute FORGET actions
  const forgetRegex = /\[FORGET:(\d+)\]/g;
  while ((match = forgetRegex.exec(reply)) !== null) {
    await env.DB.prepare(`DELETE FROM memories WHERE id = ?`)
      .bind(Number(match[1]))
      .run();
    actionsExecuted++;
  }

  // ตรวจว่ามี action tags ไหม (ก่อน strip) — รวม tag ที่ Gemini ใส่ชื่อกลุ่มแทน chat_id ด้วย
  const hasActionTags = /\[(SEND|REMEMBER|FORGET):/.test(reply);

  // Strip all action tags from reply text (boss sees clean text)
  // SEND: match ทุกรูปแบบ (ทั้ง chat_id ตัวเลข และชื่อกลุ่ม)
  const cleanReply = reply
    .replace(/\[SEND:[^\]]+\]/g, '')
    .replace(/\[REMEMBER:\w+:[^\]]+\]/g, '')
    .replace(/\[FORGET:\d+\]/g, '')
    .trim();

  return { cleanReply, actionsExecuted, hasActionTags };
}

async function handleMention(env, message, botUsername, text, hasPhoto, isDM) {
  try {
    const cleanText = text.replace(new RegExp(`@${botUsername}`, "g"), "").trim();
    if (!cleanText && !hasPhoto) return;

    await sendTyping(env, message.chat.id);

    const context = await getContext(env.DB, message.chat.id, isDM);

    // ดึงรูป: จากข้อความนี้ → reply → รูปล่าสุด
    let imageData = null;
    console.log("Photo debug:", JSON.stringify({
      hasPhoto,
      photoArray: !!message.photo,
      photoLen: message.photo?.length,
      docMime: message.document?.mime_type,
    }));

    const fileId =
      getPhotoFileId(message) ||
      getPhotoFileId(message.reply_to_message) ||
      null;

    console.log("fileId:", fileId);

    if (fileId) {
      imageData = await downloadPhotoByFileId(env, fileId);
      console.log("downloadResult:", imageData ? `ok (${imageData.mimeType})` : "null");
    }

    // ถ้ายังไม่มีรูป ดึงจากรูปล่าสุดใน DB (5 นาที) — ทั้ง DM และกลุ่ม
    if (!imageData) {
      imageData = await getRecentPhoto(env, message.chat.id, message.message_id);
    }

    // แนบเนื้อหาข้อความที่ reply ถึง เพื่อให้ Gemini รู้บริบท
    let userMessage = cleanText;
    const replyMsg = message.reply_to_message;
    if (replyMsg) {
      const replyContent = replyMsg.text || replyMsg.caption || "";
      if (replyContent) {
        const replyFrom = replyMsg.from?.first_name || replyMsg.from?.username || "Unknown";
        userMessage = `[Reply ถึงข้อความของ ${replyFrom}: "${replyContent}"]\n\n${cleanText}`;
      }
    }

    let reply = await askGemini(env, userMessage, context, imageData);

    // Parse and execute action tags (e.g., [SEND:chat_id:message])
    const { cleanReply, actionsExecuted, hasActionTags } = await parseAndExecuteActions(env, reply);

    // Send clean reply to boss (without action tags)
    // ถ้ามี action tags + อยู่ในกลุ่ม → ส่ง confirmation ไป DM บอส ไม่โชว์ในกลุ่ม
    if (cleanReply) {
      if (hasActionTags && !isDM) {
        await sendTelegram(env, message.from.id, cleanReply, null);
      } else {
        await sendTelegram(env, message.chat.id, cleanReply, message.message_id);
      }
    }
  } catch (err) {
    console.error("handleMention error:", err);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาด ลองใหม่อีกครั้งนะ", message.message_id);
  }
}

// ดึงรูปล่าสุดจากแชท (ภายใน 5 นาที)
async function getRecentPhoto(env, chatId, currentMsgId) {
  try {
    const { results } = await env.DB
      .prepare(
        `SELECT photo_file_id FROM messages
         WHERE chat_id = ? AND message_id < ? AND photo_file_id IS NOT NULL
         AND created_at > datetime('now', '-5 minutes')
         ORDER BY message_id DESC LIMIT 1`
      )
      .bind(chatId, currentMsgId)
      .all();

    if (!results.length || !results[0].photo_file_id) return null;
    return await downloadPhotoByFileId(env, results[0].photo_file_id);
  } catch (err) {
    console.error("getRecentPhoto error:", err);
    return null;
  }
}

// ===== Boss Commands =====

async function handleSendCommand(env, message, args) {
  try {
    const parts = args.trim().split(/\s+/);
    if (parts.length < 2 || !parts[0]) {
      await sendTelegram(env, message.chat.id, "Usage: /send <chat_id> <message>", message.message_id);
      return;
    }
    const targetChatId = parts[0];
    const msg = parts.slice(1).join(" ");
    await sendTelegram(env, targetChatId, msg, null);
    await sendTelegram(env, message.chat.id, "Sent ✓", message.message_id);
  } catch (err) {
    console.error("handleSendCommand error:", err);
    await sendTelegram(env, message.chat.id, "ส่งไม่สำเร็จ: " + err.message, message.message_id);
  }
}

async function handlePendingCommand(env, message) {
  try {
    const { results } = await env.DB
      .prepare(
        `SELECT id, username, first_name, promise_text, datetime(created_at, '+7 hours') as created_at
         FROM commitments WHERE status = 'pending'
         ORDER BY created_at DESC LIMIT 20`
      )
      .all();

    if (results.length === 0) {
      await sendTelegram(env, message.chat.id, "ไม่มีงานค้างครับบอส", message.message_id);
      return;
    }

    let reply = "งานค้าง/คำสัญญาที่ยังไม่เสร็จ:\n\n";
    for (const r of results) {
      const name = r.username ? `@${r.username}` : r.first_name || "Unknown";
      reply += `#${r.id} — ${name}\n"${r.promise_text}"\nเมื่อ: ${r.created_at}\n\n`;
    }
    reply += "ใช้ /resolve <id> เพื่อปิดงาน";

    await sendTelegram(env, message.chat.id, reply, message.message_id);
  } catch (err) {
    console.error("handlePendingCommand error:", err);
  }
}

async function handleResolveCommand(env, message, args) {
  try {
    const id = args.trim();
    if (!id || isNaN(id)) {
      await sendTelegram(env, message.chat.id, "Usage: /resolve <id>", message.message_id);
      return;
    }
    await env.DB
      .prepare(`UPDATE commitments SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?`)
      .bind(Number(id))
      .run();
    await sendTelegram(env, message.chat.id, `งาน #${id} ปิดแล้วครับ`, message.message_id);
  } catch (err) {
    console.error("handleResolveCommand error:", err);
  }
}

async function handleRememberCommand(env, message, args) {
  try {
    let content = args.trim();
    if (!content) {
      await sendTelegram(env, message.chat.id, "Usage: /remember <สิ่งที่จะจำ>\nหรือ /remember [category] <สิ่งที่จะจำ>", message.message_id);
      return;
    }

    let category = "general";
    const catMatch = content.match(/^\[(\w+)\]\s*([\s\S]*)/);
    if (catMatch) {
      category = catMatch[1];
      content = catMatch[2];
    }

    const { meta } = await env.DB
      .prepare(`INSERT INTO memories (content, category) VALUES (?, ?)`)
      .bind(content, category)
      .run();

    await sendTelegram(env, message.chat.id, `จำแล้วค่ะนาย (ID: #${meta.last_row_id}, หมวด: ${category})`, message.message_id);
  } catch (err) {
    console.error("handleRememberCommand error:", err);
  }
}

async function handleMemoriesCommand(env, message) {
  try {
    const { results } = await env.DB
      .prepare(`SELECT id, content, category, datetime(created_at, '+7 hours') as created_at FROM memories ORDER BY created_at DESC LIMIT 30`)
      .all();

    if (results.length === 0) {
      await sendTelegram(env, message.chat.id, "ยังไม่มีความจำที่บันทึกไว้ค่ะนาย", message.message_id);
      return;
    }

    let reply = "ความจำถาวรของ Friday:\n\n";
    for (const m of results) {
      reply += `#${m.id} [${m.category}]\n${m.content}\nเมื่อ: ${m.created_at}\n\n`;
    }
    reply += "ใช้ /forget <id> เพื่อลบ";

    await sendTelegram(env, message.chat.id, reply, message.message_id);
  } catch (err) {
    console.error("handleMemoriesCommand error:", err);
  }
}

async function handleForgetCommand(env, message, args) {
  try {
    const id = args.trim();
    if (!id || isNaN(id)) {
      await sendTelegram(env, message.chat.id, "Usage: /forget <id>", message.message_id);
      return;
    }
    await env.DB
      .prepare(`DELETE FROM memories WHERE id = ?`)
      .bind(Number(id))
      .run();
    await sendTelegram(env, message.chat.id, `ลบความจำ #${id} แล้วค่ะนาย`, message.message_id);
  } catch (err) {
    console.error("handleForgetCommand error:", err);
  }
}

// ===== Proactive Alert (Cron ทุก 3 ชม.) =====

async function proactiveAlert(env) {
  try {
    const bossId = env.BOSS_USER_ID;

    const { results: overdue } = await env.DB
      .prepare(
        `SELECT id, username, first_name, promise_text, datetime(created_at, '+7 hours') as created_at
         FROM commitments
         WHERE status = 'pending' AND created_at < datetime('now', '-24 hours')
         ORDER BY created_at ASC LIMIT 10`
      )
      .all();

    if (overdue.length === 0) return;

    let alert = "Friday Alert — งานค้างเกิน 24 ชม.\n\n";
    for (const r of overdue) {
      const name = r.username ? `@${r.username}` : r.first_name || "Unknown";
      alert += `#${r.id} ${name}: "${r.promise_text}"\nสัญญาเมื่อ: ${r.created_at}\n\n`;
    }
    alert += `รวม ${overdue.length} รายการค้าง\nใช้ /resolve <id> เพื่อปิดงาน`;

    await sendTelegram(env, bossId, alert, null);
  } catch (err) {
    console.error("Proactive alert error:", err);
  }
}

// ===== Cleanup Old Data (Cron ทุก 3 ชม.) =====

async function cleanupOldData(env) {
  try {
    const bossId = env.BOSS_USER_ID;
    let totalDeletedMessages = 0;

    // 1. ลบ messages เก่ากว่า 7 วัน (chunk ทีละ 500 แถว, สูงสุด 20 รอบต่อ cron run)
    const MAX_ROUNDS = 20;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const result = await env.DB
        .prepare(
          `DELETE FROM messages WHERE id IN (
             SELECT id FROM messages WHERE created_at < datetime('now', '-7 days') LIMIT 500
           )`
        )
        .run();
      const deleted = result.meta.changes;
      totalDeletedMessages += deleted;
      if (deleted < 500) break;
    }

    // 2. ลบ resolved commitments เก่ากว่า 30 วัน
    const commitResult = await env.DB
      .prepare(
        `DELETE FROM commitments
         WHERE status = 'resolved' AND resolved_at < datetime('now', '-30 days')`
      )
      .run();

    // 3. นับ memories → ถ้าเกิน 200 แจ้งเตือนบอส
    const { results: memCount } = await env.DB
      .prepare(`SELECT COUNT(*) as count FROM memories`)
      .all();

    if (memCount[0].count > 200) {
      await sendTelegram(
        env,
        bossId,
        `Friday Alert — memories มี ${memCount[0].count} รายการแล้ว (เกิน 200) อาจต้องจัดระเบียบค่ะนาย\nใช้ /memories ดูรายการ แล้ว /forget <id> ลบที่ไม่ใช้`,
        null
      );
    }

    if (totalDeletedMessages > 0 || commitResult.meta.changes > 0) {
      console.log(
        `Cleanup done: ${totalDeletedMessages} messages, ${commitResult.meta.changes} resolved commitments deleted`
      );
    }
  } catch (err) {
    console.error("Cleanup error:", err);
  }
}
