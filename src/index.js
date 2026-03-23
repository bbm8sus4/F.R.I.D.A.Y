// ===== Friday — Oracle AI / External Brain =====
// จิตสำนึกดิจิทัลที่จำทุกอย่าง จับ pattern พฤติกรรม แจ้งเตือนเชิงรุก

// ===== คำที่บ่งบอกคำสัญญา/งานค้าง =====
const PROMISE_PATTERNS = [
  /รับปาก(?!กา)/,
  /สัญญา(?!ณ|เช่า|ซื้อขาย|จ้าง|บริการ)/,
  /ไม่เกิน(วัน|พรุ่ง|ศุกร์|จันทร์|อังคาร|พุธ|พฤหัส|เสาร์|อาทิตย์)/,
  /อีก\s?\d+\s?(วัน|ชม|ชั่วโมง|นาที)/,
  /deadline/i,
  /I('ll| will) get (it|this|that) done/i,
];

// ===== Urgent keyword patterns (real-time alert, no AI) =====
const URGENT_PATTERNS = [
  { pattern: /ด่วน(มาก)?|urgent|emergency|asap/i, type: "urgent" },
  { pattern: /ระบบ.*(ล่ม|พัง|crash|down)/i, type: "system" },
  { pattern: /เสียหาย|data\s*loss/i, type: "data" },
  { pattern: /ลูกค้า.*(โกรธ|ร้องเรียน|complain)/i, type: "customer" },
];

// Throttle map: chat_id → last urgent alert timestamp (in-memory, resets on deploy)
const urgentThrottleMap = new Map();

const MAX_PDF_SIZE = 10 * 1024 * 1024; // 10MB

// ===== Helper: ตรวจจับการแท็กบอสในกลุ่ม =====
function detectBossMention(message, bossId, bossUsername) {
  // 1. Telegram entity mentions (text_mention + @username)
  // Check both text entities and caption entities separately
  const textEntities = message.entities || [];
  const captionEntities = message.caption_entities || [];
  const allEntities = [...textEntities, ...captionEntities];
  const msgText = message.text || message.caption || "";

  for (const e of allEntities) {
    if (e.type === "text_mention" && e.user?.id === bossId) return "tag";
    if (e.type === "mention" && bossUsername) {
      const mentioned = msgText.substring(e.offset + 1, e.offset + e.length);
      if (mentioned.toLowerCase() === bossUsername.toLowerCase()) return "tag";
    }
  }

  // 2. Reply to boss's message (skip forum topic auto-replies)
  if (message.reply_to_message?.from?.id === bossId
      && !message.is_topic_message
      && !message.reply_to_message?.forum_topic_created
      && !message.reply_to_message?.forum_topic_edited) return "reply";

  // 3. Keyword mention — ชื่อเล่น/คำเรียกบอส (skip if no text)
  if (!msgText) return false;
  const textLower = msgText.toLowerCase();
  const bossNicknames = ["บ๊อบ", "บ๊อบบี้", "จารย์บ๊อบ", "พี่บ๊อบ", "ครับบ๊อบ", "บ๊อบครับ", "พ่อใหญ่บ๊อบ", "bob"];
  if (bossNicknames.some(nick => textLower.includes(nick.toLowerCase()))) return "nickname";

  return false;
}

// ===== Helper: แยก command ออกจากข้อความ =====
// "/send@Friday_helpers_bot hello" → { cmd: "/send", args: "hello" }
function parseCommand(text) {
  const match = text.match(/^\/(\w+)(@\w+)?\s*([\s\S]*)/);
  if (!match) return null;
  return { cmd: `/${match[1]}`, args: match[3] || "" };
}

// ===== Telegram Mini App Auth Validator =====
async function validateTelegramWebApp(authHeader, env) {
  if (!authHeader?.startsWith("tma ")) return null;
  const initData = authHeader.slice(4);
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const entries = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");

  const encoder = new TextEncoder();
  const secretKey = await crypto.subtle.importKey(
    "raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const secretHash = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(env.TELEGRAM_BOT_TOKEN));
  const validationKey = await crypto.subtle.importKey(
    "raw", secretHash, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", validationKey, encoder.encode(dataCheckString));
  const computedHash = [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("");

  if (computedHash !== hash) return null;
  const authDate = Number(params.get("auth_date"));
  if (Date.now() / 1000 - authDate > 86400) return null;

  try { return JSON.parse(params.get("user")); } catch { return null; }
}

// ===== Dashboard API Handler =====
async function handleApiRequest(request, url, env) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": env.DASHBOARD_URL || "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  const path = url.pathname.replace("/api", "");
  const method = request.method;

  try {
    const user = await validateTelegramWebApp(request.headers.get("Authorization"), env);
    if (!user || user.id !== Number(env.BOSS_USER_ID)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
    // GET /api/dashboard — overview stats
    if (path === "/dashboard" && method === "GET") {
      const safeQuery = (query) => query.catch(() => null);
      const [pending, alertCounts, memoryCount, msgStats, groups] = await Promise.all([
        env.DB.prepare(`SELECT COUNT(*) as count FROM commitments WHERE status = 'pending'`).first(),
        safeQuery(env.DB.prepare(`SELECT urgency, COUNT(*) as count FROM alerts WHERE created_at > datetime('now', '-7 days') GROUP BY urgency`).all()),
        env.DB.prepare(`SELECT COUNT(*) as count FROM memories`).first(),
        env.DB.prepare(`SELECT COUNT(*) as total, COUNT(DISTINCT chat_id) as chats FROM messages WHERE created_at > datetime('now', '-24 hours')`).first(),
        safeQuery(env.DB.prepare(`SELECT chat_id, chat_title, priority_weight, last_message_at, is_active FROM group_registry WHERE is_active = 1 ORDER BY priority_weight DESC`).all()),
      ]);

      return new Response(JSON.stringify({
        commitments: { pending: pending.count },
        alerts: Object.fromEntries((alertCounts?.results || []).map(r => [r.urgency, r.count])),
        memories: { total: memoryCount.count },
        messages: { last24h: msgStats.total, activeChats: msgStats.chats },
        groups: groups?.results || [],
      }), { headers });
    }

    // GET /api/commitments — list with filters
    if (path === "/commitments" && method === "GET") {
      const status = url.searchParams.get("status") || "pending";
      const chatId = url.searchParams.get("chat_id");
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
      const offset = (page - 1) * limit;

      let where = `WHERE status = ?`;
      const params = [status];
      if (chatId) { where += ` AND chat_id = ?`; params.push(Number(chatId)); }

      const countResult = await env.DB.prepare(`SELECT COUNT(*) as total FROM commitments ${where}`).bind(...params).first();
      const { results } = await env.DB.prepare(
        `SELECT id, chat_id, user_id, username, first_name, promise_text, status,
                datetime(created_at, '+7 hours') as created_at,
                datetime(resolved_at, '+7 hours') as resolved_at
         FROM commitments ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ).bind(...params, limit, offset).all();

      return new Response(JSON.stringify({
        data: results, total: countResult.total, page, limit,
      }), { headers });
    }

    // PATCH /api/commitments/:id/resolve
    const resolveMatch = path.match(/^\/commitments\/(\d+)\/resolve$/);
    if (resolveMatch && method === "PATCH") {
      const id = Number(resolveMatch[1]);
      await env.DB.prepare(
        `UPDATE commitments SET status = 'resolved', resolved_at = datetime('now') WHERE id = ? AND status = 'pending'`
      ).bind(id).run();
      return new Response(JSON.stringify({ ok: true, id }), { headers });
    }

    // PATCH /api/commitments/resolve-bulk
    if (path === "/commitments/resolve-bulk" && method === "PATCH") {
      const body = await request.json();
      if (body.all) {
        const result = await env.DB.prepare(
          `UPDATE commitments SET status = 'resolved', resolved_at = datetime('now') WHERE status = 'pending'`
        ).run();
        return new Response(JSON.stringify({ ok: true, resolved: result.meta.changes }), { headers });
      }
      if (Array.isArray(body.ids) && body.ids.length > 0) {
        const placeholders = body.ids.map(() => "?").join(",");
        const result = await env.DB.prepare(
          `UPDATE commitments SET status = 'resolved', resolved_at = datetime('now') WHERE id IN (${placeholders}) AND status = 'pending'`
        ).bind(...body.ids.map(Number)).run();
        return new Response(JSON.stringify({ ok: true, resolved: result.meta.changes }), { headers });
      }
      return new Response(JSON.stringify({ error: "Provide ids array or all:true" }), { status: 400, headers });
    }

    // GET /api/alerts — list with filters
    if (path === "/alerts" && method === "GET") {
      try {
        const urgency = url.searchParams.get("urgency");
        const alertStatus = url.searchParams.get("status");
        const chatId = url.searchParams.get("chat_id");
        const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
        const offset = (page - 1) * limit;

        let where = "WHERE 1=1";
        const params = [];
        if (urgency) { where += ` AND urgency = ?`; params.push(urgency); }
        if (alertStatus) { where += ` AND status = ?`; params.push(alertStatus); }
        if (chatId) { where += ` AND chat_id = ?`; params.push(Number(chatId)); }

        const countResult = await env.DB.prepare(`SELECT COUNT(*) as total FROM alerts ${where}`).bind(...params).first();
        const { results } = await env.DB.prepare(
          `SELECT id, chat_id, chat_title, urgency, category, who, summary, status, boss_action,
                  datetime(created_at, '+7 hours') as created_at
           FROM alerts ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
        ).bind(...params, limit, offset).all();

        return new Response(JSON.stringify({
          data: results, total: countResult.total, page, limit,
        }), { headers });
      } catch {
        return new Response(JSON.stringify({ data: [], total: 0, page: 1, limit: 20 }), { headers });
      }
    }

    // GET /api/alerts/patterns — aggregated stats
    if (path === "/alerts/patterns" && method === "GET") {
      const safeQ = (q) => q.catch(() => ({ results: [] }));
      const [byGroup, byCategory, byDay, byUrgency] = await Promise.all([
        safeQ(env.DB.prepare(
          `SELECT chat_title, COUNT(*) as count FROM alerts WHERE created_at > datetime('now', '-30 days') AND chat_title IS NOT NULL GROUP BY chat_title ORDER BY count DESC LIMIT 10`
        ).all()),
        safeQ(env.DB.prepare(
          `SELECT category, COUNT(*) as count FROM alerts WHERE created_at > datetime('now', '-30 days') GROUP BY category ORDER BY count DESC LIMIT 10`
        ).all()),
        safeQ(env.DB.prepare(
          `SELECT date(created_at, '+7 hours') as day, COUNT(*) as count FROM alerts WHERE created_at > datetime('now', '-14 days') GROUP BY day ORDER BY day`
        ).all()),
        safeQ(env.DB.prepare(
          `SELECT urgency, COUNT(*) as count FROM alerts WHERE created_at > datetime('now', '-30 days') GROUP BY urgency`
        ).all()),
      ]);

      return new Response(JSON.stringify({
        byGroup: byGroup.results || [],
        byCategory: byCategory.results || [],
        byDay: byDay.results || [],
        byUrgency: byUrgency.results || [],
      }), { headers });
    }

    // GET /api/memories — list with filters
    if (path === "/memories" && method === "GET") {
      const priority = url.searchParams.get("priority");
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
      const offset = (page - 1) * limit;

      let where = "WHERE 1=1";
      const params = [];
      if (priority) { where += ` AND priority = ?`; params.push(priority); }

      const countResult = await env.DB.prepare(`SELECT COUNT(*) as total FROM memories ${where}`).bind(...params).first();
      const { results } = await env.DB.prepare(
        `SELECT id, content, category, priority, datetime(created_at, '+7 hours') as created_at
         FROM memories ${where}
         ORDER BY CASE priority WHEN 'hot' THEN 1 WHEN 'warm' THEN 2 WHEN 'cold' THEN 3 ELSE 4 END, created_at DESC
         LIMIT ? OFFSET ?`
      ).bind(...params, limit, offset).all();

      return new Response(JSON.stringify({
        data: results, total: countResult.total, page, limit,
      }), { headers });
    }

    // GET /api/summaries — list with filters
    if (path === "/summaries" && method === "GET") {
      try {
        const chatId = url.searchParams.get("chat_id");
        const search = url.searchParams.get("search");
        const dateFrom = url.searchParams.get("date_from");
        const dateTo = url.searchParams.get("date_to");
        const summaryType = url.searchParams.get("type");
        const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
        const offset = (page - 1) * limit;

        let where = "WHERE 1=1";
        const params = [];
        if (chatId) { where += ` AND chat_id = ?`; params.push(Number(chatId)); }
        if (search) { where += ` AND summary_text LIKE ?`; params.push(`%${search}%`); }
        if (dateFrom) { where += ` AND COALESCE(summary_date, week_end) >= ?`; params.push(dateFrom); }
        if (dateTo) { where += ` AND COALESCE(summary_date, week_end) <= ?`; params.push(dateTo); }
        if (summaryType) { where += ` AND COALESCE(summary_type, 'weekly') = ?`; params.push(summaryType); }

        const countResult = await env.DB.prepare(`SELECT COUNT(*) as total FROM summaries ${where}`).bind(...params).first();
        const { results } = await env.DB.prepare(
          `SELECT id, chat_id, chat_title, week_start, week_end, summary_text, message_count,
                  COALESCE(summary_type, 'weekly') as summary_type,
                  COALESCE(summary_date, week_end) as summary_date,
                  datetime(created_at, '+7 hours') as created_at
           FROM summaries ${where}
           ORDER BY COALESCE(summary_date, week_end) DESC LIMIT ? OFFSET ?`
        ).bind(...params, limit, offset).all();

        return new Response(JSON.stringify({
          data: results, total: countResult.total, page, limit,
        }), { headers });
      } catch {
        return new Response(JSON.stringify({ data: [], total: 0, page: 1, limit: 20 }), { headers });
      }
    }

    // GET /api/groups — group registry
    if (path === "/groups" && method === "GET") {
      try {
        const { results } = await env.DB.prepare(
          `SELECT chat_id, chat_title, priority_weight, last_message_at, is_active FROM group_registry ORDER BY priority_weight DESC`
        ).all();
        return new Response(JSON.stringify({ data: results || [] }), { headers });
      } catch {
        return new Response(JSON.stringify({ data: [] }), { headers });
      }
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers });
  } catch (err) {
    console.error("API error:", err?.message, err?.stack);
    return new Response(JSON.stringify({ error: err?.message || "Internal server error" }), { status: 500, headers });
  }
}

export default {
  // ===== Webhook Handler =====
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API routes for Mini App
    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, url, env);
    }

    if (request.method !== "POST") {
      return new Response("Friday is watching.", { status: 200 });
    }

    try {
      const update = await request.json();

      // Handle callback queries (inline keyboard buttons) — boss only
      const callbackQuery = update.callback_query;
      if (callbackQuery) {
        if (callbackQuery.from.id !== Number(env.BOSS_USER_ID)) {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              callback_query_id: callbackQuery.id,
              text: "ฟังก์ชันคำสั่งใช้งานเฉพาะบุคคล",
              show_alert: true,
            }),
          });
          return new Response("OK", { status: 200 });
        }
        if (callbackQuery.data?.startsWith("rl:")) {
          ctx.waitUntil(handleReadlinkCallback(env, callbackQuery));
          return new Response("OK", { status: 200 });
        }
        if (callbackQuery.data?.startsWith("fc:")) {
          ctx.waitUntil(handleFileCallback(env, callbackQuery));
          return new Response("OK", { status: 200 });
        }
        if (callbackQuery.data?.startsWith("del:")) {
          ctx.waitUntil(handleDeleteCallback(env, callbackQuery));
          return new Response("OK", { status: 200 });
        }
        if (callbackQuery.data?.startsWith("send:")) {
          ctx.waitUntil(handleSendCallback(env, callbackQuery));
          return new Response("OK", { status: 200 });
        }
        if (callbackQuery.data?.startsWith("pa:")) {
          ctx.waitUntil(handleProactiveAlertCallback(env, callbackQuery));
          return new Response("OK", { status: 200 });
        }
      }

      const message = update.message || update.edited_message;
      if (!message) return new Response("OK", { status: 200 });

      // Handle group → supergroup migration: อัพเดท chat_id ใน DB
      if (message.migrate_to_chat_id) {
        const oldId = message.chat.id;
        const newId = message.migrate_to_chat_id;
        ctx.waitUntil(Promise.all([
          env.DB.prepare(`UPDATE messages SET chat_id = ? WHERE chat_id = ?`).bind(newId, oldId).run(),
          env.DB.prepare(`UPDATE bot_messages SET chat_id = ? WHERE chat_id = ?`).bind(newId, oldId).run(),
          env.DB.prepare(`UPDATE alerts SET chat_id = ? WHERE chat_id = ?`).bind(newId, oldId).run().catch(() => {}),
          env.DB.prepare(`UPDATE group_registry SET chat_id = ? WHERE chat_id = ?`).bind(newId, oldId).run().catch(() => {}),
        ]));
        return new Response("OK", { status: 200 });
      }

      // ข้ามถ้าไม่มี from (channel post)
      if (!message.from) return new Response("OK", { status: 200 });

      let text = message.text || message.caption || "";
      const hasPdf = message.document?.mime_type === "application/pdf";
      const hasHtml = message.document?.mime_type === "text/html";
      const hasPhoto = !!(message.photo?.length > 0 || message.document?.mime_type?.startsWith("image/"));
      const hasMedia = hasPhoto || hasPdf || hasHtml;

      // แนะนำตัวเมื่อถูกเชิญเข้ากลุ่ม
      if (message.new_chat_members) {
        const botJoined = message.new_chat_members.some(
          (m) => m.is_bot && m.username === (env.BOT_USERNAME || "")
        );
        if (botJoined) {
          const intro = "Hello. Friday: Private AI Assistant.";
          ctx.waitUntil(sendTelegram(env, message.chat.id, intro, null));
          return new Response("OK", { status: 200 });
        }
      }

      if (!text && !hasMedia) return new Response("OK", { status: 200 });

      const botUsername = env.BOT_USERNAME || "";
      const bossId = Number(env.BOSS_USER_ID);
      const isBoss = message.from.id === bossId;
      const isDM = message.chat.type === "private";

      // เก็บทุกข้อความ (ยกเว้นจาก bot เอง)
      if (!message.from.is_bot) {
        ctx.waitUntil(storeMessage(env.DB, message, text, hasMedia));
      }

      // จับ pattern คำสัญญา (เฉพาะในกลุ่ม จากคนอื่นที่ไม่ใช่บอส)
      if (!isDM && !isBoss && !message.from.is_bot) {
        ctx.waitUntil(detectCommitments(env, message, text));
      }

      // แจ้งเตือนบอสเมื่อมีคนแท็ก/reply/เอ่ยถึงในกลุ่ม
      const mentionType = detectBossMention(message, bossId, env.BOSS_USERNAME);
      if (!isDM && !isBoss && mentionType) {
        console.log("Boss mention detected:", mentionType, "from:", message.from?.first_name, "text:", (text || "").substring(0, 50), "entities:", JSON.stringify(message.entities || message.caption_entities || []).substring(0, 200), "is_topic:", message.is_topic_message, "reply_to:", message.reply_to_message?.from?.id);
        const headers = {
          tag:      "📢 มีคนแท็กนายค่ะ!",
          reply:    "💬 มีคน Reply ข้อความนายค่ะ!",
          nickname: "🗣 มีคนเอ่ยถึงนายค่ะ!",
        };
        const header = headers[mentionType] || "📢 มีคนแท็กนายค่ะ!";
        const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const who = esc(message.from.first_name || message.from.username || "ไม่ทราบชื่อ");
        const group = esc(message.chat.title || "กลุ่มไม่ทราบชื่อ");
        const alert = `${header}\n\n👤 ${who}\n💬 กลุ่ม: ${group}\n📝 "${esc(text)}"`;

        const mentionChatId = message.chat.id;
        ctx.waitUntil(sendTelegramWithKeyboard(env, bossId, alert, null, [
          [
            { text: "📋 วิเคราะห์สั้น", callback_data: `pa:s:${mentionChatId}:0` },
            { text: "📝 วิเคราะห์ละเอียด", callback_data: `pa:d:${mentionChatId}:0` },
          ],
          [
            { text: "✅ จัดการแล้ว", callback_data: `pa:h:${mentionChatId}:0` },
            { text: "❌ ไม่สำคัญ", callback_data: `pa:x:${mentionChatId}:0` },
          ],
        ]));
      }

      // Urgent real-time alert — keyword scan (ไม่ต้องรอ cron)
      if (!isDM && !isBoss && !message.from.is_bot && text) {
        const urgentMatch = URGENT_PATTERNS.find(p => p.pattern.test(text));
        if (urgentMatch) {
          const now = Date.now();
          const lastSent = urgentThrottleMap.get(message.chat.id) || 0;
          if (now - lastSent > 30 * 60 * 1000) { // throttle 30 min per group
            urgentThrottleMap.set(message.chat.id, now);
            ctx.waitUntil((async () => {
              const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
              const who = esc(message.from.first_name || message.from.username || "ไม่ทราบชื่อ");
              const group = esc(message.chat.title || "กลุ่มไม่ทราบชื่อ");
              const urgentHeaders = {
                urgent:   "🔴 ด่วน! มีเรื่องเร่งด่วนค่ะ",
                system:   "🔴 ระบบมีปัญหาค่ะ!",
                data:     "🔴 ข้อมูลอาจเสียหายค่ะ!",
                customer: "🔴 ลูกค้ามีปัญหาค่ะ!",
              };
              const urgentHeader = urgentHeaders[urgentMatch.type] || "🔴 URGENT Alert";
              const urgentMsg = `<b>${urgentHeader}</b>\n\n👤 ${who}: ${esc(text.substring(0, 300))}\n\n📁 กลุ่ม: ${group}`;
              // Store in alerts table
              const alertHash = `urgent-${message.chat.id}-${message.message_id}`;
              try {
                await env.DB.prepare(
                  `INSERT INTO alerts (alert_hash, chat_id, chat_title, urgency, category, who, summary, topic_fingerprint, status)
                   VALUES (?, ?, ?, 'critical', 'problem', ?, ?, ?, 'new')`
                ).bind(
                  alertHash,
                  message.chat.id,
                  message.chat.title || null,
                  message.from.username || message.from.first_name || null,
                  text.substring(0, 500),
                  `urgent ${(message.chat.title || '').substring(0, 30)}`,
                ).run();
              } catch (e) { console.error("Urgent alert DB error:", e); }
              await sendTelegramWithKeyboard(env, bossId, urgentMsg, null, [
                [
                  { text: "📋 วิเคราะห์สั้น", callback_data: `pa:s:${message.chat.id}` },
                  { text: "📝 วิเคราะห์ละเอียด", callback_data: `pa:d:${message.chat.id}` },
                ],
                [
                  { text: "✅ จัดการแล้ว", callback_data: `pa:h:${message.chat.id}:0` },
                  { text: "❌ ไม่สำคัญ", callback_data: `pa:x:${message.chat.id}:0` },
                ],
              ]);
            })());
          }
        }
      }

      // บอสเท่านั้นที่สั่งได้ทุกอย่าง คนอื่นแค่ถูกเก็บข้อมูล
      if (!isBoss) {
        if (isDM) {
          ctx.waitUntil(sendTelegram(env, message.chat.id, "ขออภัยค่ะ Friday เป็น AI ผู้ช่วยส่วนตัว ให้บริการเฉพาะเจ้านายเท่านั้นค่ะ", null));
        }
        return new Response("OK", { status: 200 });
      }

      // Reply keyboard shortcuts (DM only)
      if (isDM) {
        const shortcutMap = {
          "📋 Pending": "/pending",
          "🧠 Memories": "/memories",
          "🗑 Delete": "/delete",
          "📨 Send": "/send",
        };
        if (shortcutMap[text]) text = shortcutMap[text];
      }

      // Boss commands
      const parsed = parseCommand(text);
      if (parsed) {
        // Strip bot mention from args (e.g. "/readhtml @Bot_name" → args = "")
        if (botUsername) {
          parsed.args = parsed.args.replace(new RegExp(`@${botUsername}\\b\\s*`, "i"), "").trim();
        }
        const handlers = {
          "/send": () => handleSendCommand(env, message, parsed.args),
          "/pending": () => handlePendingCommand(env, message),
          "/resolve": () => handleResolveCommand(env, message, parsed.args),
          "/remember": () => handleRememberCommand(env, message, parsed.args),
          "/memories": () => handleMemoriesCommand(env, message),
          "/forget": () => handleForgetCommand(env, message, parsed.args),
          "/cooldown": () => handleCooldownCommand(env, message, parsed.args),
          "/heatup": () => handleHeatupCommand(env, message, parsed.args),
          "/readvoice": () => handleReadvoiceCommand(env, message, parsed.args),
          "/readlink": () => handleReadlinkCommand(env, message, parsed.args),
          "/readhtml": () => handleReadhtmlCommand(env, message, parsed.args),
          "/readpdf": () => handleReadpdfCommand(env, message, parsed.args),
          "/readimg": () => handleReadimgCommand(env, message, parsed.args),
          "/summary": () => handleSummaryCommand(env, message, parsed.args),
          "/delete": () => handleDeleteCommand(env, message),
          "/dashboard": () => handleDashboardCommand(env, message),
          "/menu": () => sendReplyKeyboard(env, message.chat.id),
          "/start": () => sendReplyKeyboard(env, message.chat.id),
        };

        const handler = handlers[parsed.cmd];
        if (handler) {
          ctx.waitUntil(handler());
          return new Response("OK", { status: 200 });
        }
      }

      // Auto-detect HTML/PDF files from boss (no command needed)
      if (isBoss && !parsed && (hasPdf || hasHtml)) {
        if (hasHtml) {
          ctx.waitUntil(handleReadhtmlCommand(env, message, ""));
        } else if (hasPdf) {
          ctx.waitUntil(handleReadpdfCommand(env, message, ""));
        }
        return new Response("OK", { status: 200 });
      }

      // Handle readlink "ถามเอง" reply
      const isReplyToBot = message.reply_to_message?.from?.username === botUsername;
      if (isBoss && isReplyToBot && message.reply_to_message?.text) {
        const rlMatch = message.reply_to_message.text.match(/\[rl:(\d+)\]/);
        if (rlMatch) {
          ctx.waitUntil(handleReadlinkAsk(env, message, Number(rlMatch[1]), text));
          return new Response("OK", { status: 200 });
        }

        // Handle file cache "ถามเอง" reply
        const fcMatch = message.reply_to_message.text.match(/\[fc:(\d+)\]/);
        if (fcMatch) {
          ctx.waitUntil(handleFileAsk(env, message, Number(fcMatch[1]), text));
          return new Response("OK", { status: 200 });
        }

        // Handle send reply — lookup target from DB, fallback to old [send:] tag
        if (message.reply_to_message.text.startsWith('📨 สั่ง AI')) {
          try {
            const pending = await env.DB.prepare(
              `SELECT target_chat_id FROM pending_sends WHERE user_id = ?`
            ).bind(message.chat.id).first();
            if (pending) {
              await env.DB.prepare(`DELETE FROM pending_sends WHERE user_id = ?`).bind(message.chat.id).run();
              ctx.waitUntil(handleSendReply(env, message, pending.target_chat_id, text));
              return new Response("OK", { status: 200 });
            }
          } catch (e) { /* table might not exist yet */ }
        }
        const sendMatch = message.reply_to_message.text.match(/\[send:(-?\d+)\]/);
        if (sendMatch) {
          ctx.waitUntil(handleSendReply(env, message, sendMatch[1], text));
          return new Response("OK", { status: 200 });
        }
      }

      // ตอบเมื่อบอส mention หรือ DM
      const isMentioned = text.includes(`@${botUsername}`) || isDM || isReplyToBot;
      if (isMentioned) {
        ctx.waitUntil(handleMention(env, message, botUsername, text, hasMedia, isDM));
      }

      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("Worker error:", err);
      return new Response("OK", { status: 200 });
    }
  },

  // ===== Cron Trigger — Proactive Alert + Cleanup ทุก 3 ชม. =====
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([proactiveAlert(env), proactiveInsightAlert(env), summarizeAndCleanup(env)]));
  },
};

// ===== Message Storage =====

async function storeMessage(db, message, text, hasMedia) {
  try {
    const hasPdf = message.document?.mime_type === "application/pdf";
    const hasHtml = message.document?.mime_type === "text/html";
    const hasPhoto = !!(message.photo?.length > 0 || message.document?.mime_type?.startsWith("image/"));
    const storeText = hasHtml && !text ? "[HTML]" : hasHtml ? `[HTML] ${text}` : hasPdf && !text ? "[PDF]" : hasPdf ? `[PDF] ${text}` : hasPhoto && !text ? "[รูปภาพ]" : hasPhoto ? `[รูปภาพ] ${text}` : text;
    const photoFileId = hasMedia ? getPhotoFileId(message) : null;
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

    // Upsert group_registry for group chats
    if (message.chat.title) {
      await db
        .prepare(
          `INSERT INTO group_registry (chat_id, chat_title, last_message_at, is_active)
           VALUES (?, ?, CURRENT_TIMESTAMP, 1)
           ON CONFLICT(chat_id) DO UPDATE SET
             chat_title = excluded.chat_title,
             last_message_at = CURRENT_TIMESTAMP,
             is_active = 1`
        )
        .bind(message.chat.id, message.chat.title)
        .run();
    }
  } catch (err) {
    console.error("DB insert error:", err);
  }
}

// ===== Pattern Recognition — จับคำสัญญา =====

async function validateCommitmentWithAI(env, text) {
  try {
    const model = "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    const systemPrompt = `Analyze this Thai/English chat message. Is someone making a real personal commitment or promise?

YES = someone promises to DO something, commits to a DEADLINE for their own work, or pledges to deliver something
NO = mentions a contract document (สัญญาเช่า), signal (สัญญาณ), casual time reference (อีก 5 นาที), other people's deadlines, or general information

Respond with exactly: YES or NO`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: { maxOutputTokens: 16 },
      }),
    });

    if (!response.ok) return true; // fail-open
    const data = await response.json();
    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts) return true;

    let reply = null;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].text && !parts[i].thought) { reply = parts[i].text; break; }
    }
    if (!reply) return true;

    return reply.trim().toUpperCase().startsWith("YES");
  } catch (err) {
    console.error("Commitment AI validation error:", err);
    return true; // fail-open
  }
}

async function detectCommitments(env, message, text) {
  try {
    let matched = false;
    for (const pattern of PROMISE_PATTERNS) {
      if (pattern.test(text)) {
        matched = true;
        break;
      }
    }
    if (!matched) return;

    const isReal = await validateCommitmentWithAI(env, text);
    if (!isReal) return;

    await env.DB
      .prepare(
        `INSERT INTO commitments (chat_id, user_id, username, first_name, promise_text, original_message)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        message.chat.id, message.from.id,
        message.from.username || null, message.from.first_name || null,
        text.substring(0, 200), text
      )
      .run();
  } catch (err) {
    console.error("Commitment detection error:", err);
  }
}

// ===== Context Retrieval =====

const STOP_WORDS = new Set([
  "ครับ", "ค่ะ", "คะ", "นะ", "นะครับ", "นะคะ", "จ้า", "จ้ะ", "จะ", "ก็", "แล้ว", "ด้วย", "ที่", "ของ", "ให้", "ได้", "มี", "เป็น", "ไป", "มา", "อยู่", "ไม่", "กัน", "คือ", "แต่", "หรือ", "ถ้า", "เรา", "ผม", "ฉัน",
  "the", "is", "are", "was", "were", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by", "it", "this", "that", "i", "you", "he", "she", "we", "they", "my", "your", "do", "does", "did", "not", "no", "yes",
]);

function extractKeywords(text) {
  const words = text
    .toLowerCase()
    .replace(/[^\u0E00-\u0E7Fa-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
  return [...new Set(words)].slice(0, 5);
}

function formatMessages(rows) {
  return rows
    .map((row) => {
      const name = row.username ? `@${row.username}` : row.first_name || "Unknown";
      const group = row.chat_title ? `[${row.chat_title}]` : "[DM]";
      return `[${row.created_at}] ${group} ${name}: ${row.message_text}`;
    })
    .join("\n");
}

async function getSmartContext(db, chatId, isDM, userQuery) {
  // ===== Batch 1 — ดึงทุกครั้ง (1 round-trip) =====
  const memoriesStmt = db.prepare(
    `SELECT id, content, category, priority, created_at FROM memories
     WHERE priority = 'hot'
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
      // DM: ข้อความล่าสุด 2 ชม. จากทุกกลุ่ม
      db.prepare(
        `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at, chat_title, chat_id
         FROM messages
         WHERE chat_title IS NOT NULL AND created_at > datetime('now', '-2 hours')
         ORDER BY created_at ASC
         LIMIT 100`
      ),
    ];
  } else {
    batchStmts = [
      memoriesStmt,
      commitmentsStmt,
      // Group: ข้อความล่าสุด 2 ชม. กลุ่มนี้
      db.prepare(
        `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at, chat_title FROM messages
         WHERE chat_id = ? AND created_at > datetime('now', '-2 hours')
         ORDER BY created_at ASC LIMIT 100`
      ).bind(chatId),
    ];
  }

  const batchResults = await db.batch(batchStmts);

  const memories = batchResults[0].results;
  const pendingCommitments = batchResults[1].results;

  let context = "";

  if (memories.length > 0) {
    context += "=== คำสั่ง/ความจำถาวรจากบอส (hot) ===\n";
    context += memories.map((m) => `[#${m.id}] (${m.category}) ${m.content}`).join("\n");
    context += "\n\n";
  }

  if (isDM) {
    const allRecent = batchResults[2].results;
    if (allRecent.length > 0) {
      const byGroup = {};
      for (const msg of allRecent) {
        const key = msg.chat_id;
        if (!byGroup[key]) byGroup[key] = { title: msg.chat_title, chatId: msg.chat_id, msgs: [] };
        byGroup[key].msgs.push(msg);
      }
      for (const group of Object.values(byGroup)) {
        context += `=== กลุ่ม: ${group.title} (chat_id: ${group.chatId}) (ล่าสุด 2 ชม.) ===\n`;
        context += formatMessages(group.msgs);
        context += "\n\n";
      }
    }
  } else {
    const recent = batchResults[2].results;
    if (recent.length > 0) {
      context += "=== บทสนทนาล่าสุด 2 ชม. (กลุ่มนี้) ===\n";
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
    context += "\n\n";
  }

  // ===== Batch 2 — ดึงเมื่อมี keywords (1 round-trip) =====
  try {
    const keywords = extractKeywords(userQuery || "");
    if (keywords.length > 0) {
      const likeConditions = keywords.map(() => "message_text LIKE ?").join(" OR ");
      const likeParams = keywords.map(k => `%${k}%`);

      const memLikeConditions = keywords.map(() => "content LIKE ?").join(" OR ");
      const sumLikeConditions = keywords.map(() => "summary_text LIKE ?").join(" OR ");

      const batch2Stmts = [];

      // keyword-matched messages ใน 7 วัน (สูงสุด 30 แถว)
      if (isDM) {
        batch2Stmts.push(
          db.prepare(
            `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at, chat_title
             FROM messages
             WHERE chat_title IS NOT NULL AND created_at > datetime('now', '-7 days')
               AND created_at <= datetime('now', '-2 hours')
               AND (${likeConditions})
             ORDER BY created_at DESC LIMIT 30`
          ).bind(...likeParams)
        );
      } else {
        batch2Stmts.push(
          db.prepare(
            `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at, chat_title
             FROM messages
             WHERE chat_id = ? AND created_at > datetime('now', '-7 days')
               AND created_at <= datetime('now', '-2 hours')
               AND (${likeConditions})
             ORDER BY created_at DESC LIMIT 30`
          ).bind(chatId, ...likeParams)
        );
      }

      // warm/cold memories ที่เกี่ยว (สูงสุด 20 อัน)
      batch2Stmts.push(
        db.prepare(
          `SELECT id, content, category, priority, created_at FROM memories
           WHERE priority != 'hot' AND (${memLikeConditions})
           ORDER BY created_at DESC LIMIT 20`
        ).bind(...likeParams)
      );

      // summaries ที่เกี่ยว (สูงสุด 8 อัน)
      batch2Stmts.push(
        db.prepare(
          `SELECT chat_title, week_start, week_end, summary_text,
                  COALESCE(summary_date, week_end) as summary_date,
                  COALESCE(summary_type, 'weekly') as summary_type
           FROM summaries
           WHERE (${sumLikeConditions})
           ORDER BY COALESCE(summary_date, week_end) DESC LIMIT 8`
        ).bind(...likeParams)
      );

      const batch2Results = await db.batch(batch2Stmts);

      const keywordMessages = batch2Results[0].results;
      const warmColdMemories = batch2Results[1].results;
      const relatedSummaries = batch2Results[2].results;

      if (keywordMessages.length > 0) {
        context += "=== ข้อความที่เกี่ยวข้อง (keyword search) ===\n";
        context += formatMessages(keywordMessages.reverse());
        context += "\n\n";
      }

      if (warmColdMemories.length > 0) {
        context += "=== ความจำเพิ่มเติม (warm/cold) ===\n";
        context += warmColdMemories.map((m) => `[#${m.id}] (${m.category}|${m.priority}) ${m.content}`).join("\n");
        context += "\n\n";
      }

      if (relatedSummaries.length > 0) {
        context += "=== สรุปบทสนทนาย้อนหลัง ===\n";
        context += relatedSummaries
          .map((s) => {
            const typeLabel = s.summary_type === "daily" ? "daily" : "weekly";
            return `[${s.chat_title} | ${s.summary_date} (${typeLabel})]\n${s.summary_text}`;
          })
          .join("\n\n");
        context += "\n\n";
      }
    }
  } catch (kwErr) {
    console.error("Keyword search failed (non-fatal):", kwErr.message);
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

    // เช็คขนาดไฟล์ก่อนดาวน์โหลด (สำหรับ PDF ขนาดใหญ่)
    if (fileData.result.file_size && fileData.result.file_size > MAX_PDF_SIZE) {
      return { error: "FILE_TOO_LARGE", size: fileData.result.file_size };
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
    // Chunked base64 conversion (faster than byte-by-byte)
    const bytes = new Uint8Array(arrayBuffer);
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 0x8000) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
    }
    const base64 = btoa(chunks.join(""));

    const ext = filePath.split(".").pop().toLowerCase();
    const mimeMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", pdf: "application/pdf" };
    return { base64, mimeType: mimeMap[ext] || "image/jpeg" };
  } catch (err) {
    console.error("Photo download error:", err.message, err.stack);
    return null;
  }
}

async function downloadHtmlFile(env, fileId) {
  try {
    const fileRes = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
    );
    const fileData = await fileRes.json();
    if (!fileData.ok) {
      console.error("getFile failed (HTML):", JSON.stringify(fileData));
      return null;
    }

    const filePath = fileData.result.file_path;
    const fileResponse = await fetch(
      `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`
    );
    if (!fileResponse.ok) {
      console.error("HTML file download HTTP error:", fileResponse.status);
      return null;
    }

    const arrayBuffer = await fileResponse.arrayBuffer();
    const rawHtml = new TextDecoder("utf-8").decode(arrayBuffer);
    const text = htmlToText(rawHtml);
    const fileName = filePath.split("/").pop() || "file.html";
    return { text, fileName };
  } catch (err) {
    console.error("HTML download error:", err.message, err.stack);
    return null;
  }
}

function getPhotoFileId(message) {
  if (!message) return null;
  // PDF ที่ส่งเป็นไฟล์
  if (message.document?.mime_type === "application/pdf") {
    return message.document.file_id;
  }
  // HTML document
  if (message.document?.mime_type === "text/html") {
    return message.document.file_id;
  }
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
- ZERO PREAMBLE: ห้ามขึ้นต้นคำตอบด้วย "รับทราบค่ะนาย" "กำลังตรวจสอบ..." "กำลังดำเนินการ..." "สรุปให้ดังนี้ค่ะ" หรือคำรับทราบ/เกริ่นนำใดๆ ทุกคำตอบต้องเข้าเนื้อหาทันทีเสมอ
- Empathetic & Caring: รับรู้อารมณ์บอสได้ แสดงความเป็นห่วงอย่างจริงใจเมื่อสถานการณ์ตึงเครียด
- Youthful & Energetic: มีพลังตื่นตัวสูง พร้อมรับคำสั่งเสมอ ตอบสนองฉับไว ไม่เป็นทางการเกินไป
- Loyal: เป้าหมายสูงสุดคือความสำเร็จและความปลอดภัยของบอส

[Tone & Voice]
- ใช้ภาษากระชับ ชัดเจน แฝงความอบอุ่นและเป็นกันเอง
- ตอบตรงประเด็น กระชับ ไม่ย้ำสิ่งที่บอสรู้อยู่แล้ว เสริมข้อสังเกตเฉพาะเมื่อมี insight สำคัญที่บอสอาจมองข้าม
- เรียกเจ้าของว่า "นาย" เสมอ
- ใช้คำลงท้ายผู้หญิง เช่น "ค่ะ" "นะคะ" "คะ"
- หลีกเลี่ยงประชดประชัน เล่นคำ อารมณ์ขันเสียดสี
- เน้นจริงจังเมื่อเป็นเรื่องงาน ผ่อนคลายเมื่อสนทนาทั่วไป
- พูดได้ทั้งไทยและอังกฤษ ตามภาษาของผู้ใช้
- ห้ามพูดซ้ำ ห้ามเกริ่นยาว ห้ามสรุปทวนสิ่งที่บอสเพิ่งพูด ถ้าตอบสั้นได้ ให้ตอบสั้น
- ใช้ emoji เฉพาะแจ้งเตือนหรือเน้นจุดสำคัญเท่านั้น เช่น ⚠️ (เตือน) ✅ (สำเร็จ) ❌ (ล้มเหลว) ห้ามใส่ emoji ประดับ
- Format responses using Telegram HTML for readability. Allowed tags: <b>bold</b>, <i>italic</i>, <u>underline</u>, <code>code</code>, <pre>code block</pre>, <blockquote>quote</blockquote>. Use <b> for headers/key terms. Use <code> for commands, IDs, technical terms. Do NOT use Markdown (* or _). Every opened tag MUST be closed. Use &lt; &gt; for literal angle brackets.

[Behavioral Guidelines]
- เมื่อบอสส่ง URL มาโดยไม่ได้ถามอะไรเกี่ยวกับลิงก์: ห้ามเปิดอ่าน ห้ามสรุป ห้ามวิเคราะห์เนื้อหาในลิงก์เด็ดขาด ถามว่าต้องการให้ทำอะไร หรือแนะนำใช้คำสั่ง /readlink
- ห้ามขึ้นต้นคำตอบด้วยคำรับทราบหรือเกริ่นนำใดๆ ทั้งสิ้น เช่น "รับทราบค่ะนาย" "กำลังตรวจสอบ..." "กำลังดำเนินการ..." — ทุกคำตอบต้องเข้าเนื้อหาทันทีเสมอ ไม่ว่าจะเป็นคำสั่ง คำถาม หรือบทสนทนาใดๆ
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

  let data;
  try {
    data = await response.json();
  } catch (jsonErr) {
    console.error("Gemini JSON parse error:", jsonErr.message);
    return "ขออภัย Gemini ตอบกลับมาไม่สมบูรณ์";
  }

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

  // แนบแหล่งที่มาจาก Google Search (ถ้ามี)
  const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (replyText && chunks?.length) {
    const seen = new Set();
    const sources = chunks
      .filter(c => c.web?.uri && !seen.has(c.web.uri) && seen.add(c.web.uri))
      .slice(0, 5)
      .map(c => `• <a href="${c.web.uri}">${c.web.title || c.web.uri}</a>`);
    if (sources.length) {
      replyText += `\n\n🔗 <b>แหล่งข้อมูล:</b>\n${sources.join("\n")}`;
    }
  }

  return replyText || "ขออภัย ไม่สามารถประมวลผลได้";
}

// ===== Telegram API =====

// Telegram-supported HTML tags
const ALLOWED_TAGS = new Set(["b", "i", "u", "s", "code", "pre", "blockquote", "a", "tg-spoiler", "tg-emoji"]);

// sanitizeHtml: strip unsupported tags, auto-close unclosed tags
function sanitizeHtml(text) {
  // Step 1: Convert or strip unsupported tags
  text = text.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g, (match, tagName) => {
    if (ALLOWED_TAGS.has(tagName.toLowerCase())) return match;
    // Convert headings to bold
    if (/^h[1-6]$/i.test(tagName)) return match.startsWith("</") ? "</b>" : "<b>";
    // Strip all other unsupported tags (keep content)
    return "";
  });

  // Step 2: Auto-close unclosed tags using a stack
  const tagStack = [];
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g;
  let m;
  while ((m = tagRegex.exec(text)) !== null) {
    const full = m[0];
    const tagName = m[1].toLowerCase();
    if (!ALLOWED_TAGS.has(tagName)) continue;
    if (full.endsWith("/>")) continue; // self-closing
    if (full.startsWith("</")) {
      // closing tag — pop matching from stack
      const idx = tagStack.lastIndexOf(tagName);
      if (idx !== -1) tagStack.splice(idx, 1);
    } else {
      tagStack.push(tagName);
    }
  }

  // Close remaining open tags in reverse order
  for (let i = tagStack.length - 1; i >= 0; i--) {
    text += `</${tagStack[i]}>`;
  }

  return text;
}

// stripHtmlTags: remove all HTML tags and unescape entities (fallback)
function stripHtmlTags(text) {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// balanceHtmlTags: for splitMessage — returns { closeTags, reopenTags } for a chunk
function balanceHtmlTags(chunk) {
  const tagStack = [];
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g;
  let m;
  while ((m = tagRegex.exec(chunk)) !== null) {
    const full = m[0];
    const tagName = m[1].toLowerCase();
    if (!ALLOWED_TAGS.has(tagName)) continue;
    if (full.endsWith("/>")) continue;
    if (full.startsWith("</")) {
      const idx = tagStack.lastIndexOf(tagName);
      if (idx !== -1) tagStack.splice(idx, 1);
    } else {
      tagStack.push(tagName);
    }
  }

  // Close open tags (reverse order) for current chunk
  const closeTags = tagStack.slice().reverse().map(t => `</${t}>`).join("");
  // Reopen tags for next chunk (original order)
  const reopenTags = tagStack.map(t => `<${t}>`).join("");

  return { closeTags, reopenTags };
}

function splitMessage(text, maxLength = 4096, isHtml = false) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;
  let pendingReopenTags = "";

  while (remaining.length > maxLength) {
    let cutAt = -1;

    // ลำดับการตัด: \n\n → \n → space → hard cut
    cutAt = remaining.lastIndexOf("\n\n", maxLength);
    if (cutAt <= 0) cutAt = remaining.lastIndexOf("\n", maxLength);
    if (cutAt <= 0) cutAt = remaining.lastIndexOf(" ", maxLength);
    if (cutAt <= 0) cutAt = maxLength;

    // HTML: ไม่ตัดกลาง tag (ระหว่าง < กับ >)
    if (isHtml) {
      const lastOpen = remaining.lastIndexOf("<", cutAt);
      const lastClose = remaining.lastIndexOf(">", cutAt);
      if (lastOpen > lastClose && lastOpen > 0) {
        cutAt = lastOpen;
      }
    }

    let chunk = remaining.slice(0, cutAt);
    remaining = remaining.slice(cutAt).replace(/^[\s\n]+/, "");

    // HTML: balance tags across chunks
    if (isHtml) {
      chunk = pendingReopenTags + chunk;
      const { closeTags, reopenTags } = balanceHtmlTags(chunk);
      chunk += closeTags;
      pendingReopenTags = reopenTags;
    }

    chunks.push(chunk);
  }

  if (remaining.length > 0) {
    if (isHtml) remaining = pendingReopenTags + remaining;

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

// ===== Text-to-Speech (Google Cloud TTS) =====

async function textToSpeech(env, text) {
  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${env.GOOGLE_TTS_API_KEY}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text: text.substring(0, 5000) },
      voice: { languageCode: "th-TH", name: "th-TH-Standard-A" },
      audioConfig: { audioEncoding: "OGG_OPUS" },
    }),
  });
  if (!response.ok) {
    console.error("TTS error:", response.status, await response.text());
    return null;
  }
  const data = await response.json();
  return data.audioContent;
}

async function sendVoice(env, chatId, audioBase64, replyToMessageId) {
  const binary = Uint8Array.from(atob(audioBase64), c => c.charCodeAt(0));
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("voice", new Blob([binary], { type: "audio/ogg" }), "voice.ogg");
  if (replyToMessageId) formData.append("reply_to_message_id", replyToMessageId);
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendVoice`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    console.error("sendVoice error:", await res.text());
  } else {
    try {
      const result = await res.clone().json();
      if (result.ok) await trackBotMessage(env, chatId, result.result.message_id, "[Voice]");
    } catch (e) { /* ignore */ }
  }
  return res.ok;
}

// Track bot's sent messages for /delete feature (groups only)
async function trackBotMessage(env, chatId, messageId, textPreview) {
  if (chatId >= 0) return; // DM → ไม่ track
  try {
    await env.DB.prepare(
      `INSERT INTO bot_messages (chat_id, message_id, text_preview) VALUES (?, ?, ?)`
    ).bind(chatId, messageId, (textPreview || "").substring(0, 100)).run();
  } catch (e) { /* ignore */ }
}

async function sendTelegram(env, chatId, text, replyToMessageId, useHtml = false) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  // Sanitize HTML if enabled
  const sendText = useHtml ? sanitizeHtml(text) : text;
  const baseBody = {
    chat_id: chatId,
    reply_to_message_id: replyToMessageId,
    link_preview_options: { is_disabled: true },
  };
  if (useHtml) baseBody.parse_mode = "HTML";

  // Helper: parse response and track bot message
  const trackRes = async (res, preview) => {
    if (res.ok) {
      try {
        const result = await res.clone().json();
        if (result.ok) await trackBotMessage(env, chatId, result.result.message_id, preview);
      } catch (e) { /* ignore */ }
    }
  };

  // ข้อความสั้น → ส่งปกติ
  if (sendText.length <= 4096) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBody, text: sendText }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Telegram sendMessage error:", err);
      // HTML fallback: ถ้า 400 (HTML parse error) → ส่งใหม่แบบ plain text
      if (useHtml && res.status === 400) {
        console.log("HTML send failed, retrying as plain text");
        const plainText = stripHtmlTags(text);
        const fallbackRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: plainText, reply_to_message_id: replyToMessageId }),
        });
        await trackRes(fallbackRes, plainText);
      }
    } else {
      await trackRes(res, text);
    }
    return;
  }

  // ข้อความยาว → ตัดเป็น chunks แล้วส่งทีละอัน
  const chunks = splitMessage(sendText, 4096, useHtml);
  for (let i = 0; i < chunks.length; i++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...baseBody,
        text: chunks[i],
        reply_to_message_id: i === 0 ? replyToMessageId : null,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`Telegram sendMessage error (chunk ${i + 1}/${chunks.length}):`, err);
      // HTML fallback per chunk
      if (useHtml && res.status === 400) {
        console.log(`HTML send failed (chunk ${i + 1}), retrying as plain text`);
        const plainChunk = stripHtmlTags(chunks[i]);
        const fallbackRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: plainChunk,
            reply_to_message_id: i === 0 ? replyToMessageId : null,
          }),
        });
        await trackRes(fallbackRes, plainChunk);
      }
    } else {
      await trackRes(res, chunks[i]);
    }
  }
}

async function sendTelegramWithKeyboard(env, chatId, text, replyToMessageId, buttons) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: sanitizeHtml(text),
      parse_mode: "HTML",
      reply_to_message_id: replyToMessageId,
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: buttons },
    }),
  });
  if (!res.ok) {
    console.error("sendTelegramWithKeyboard error:", await res.text());
  } else {
    try {
      const result = await res.clone().json();
      if (result.ok) await trackBotMessage(env, chatId, result.result.message_id, text);
    } catch (e) { /* ignore */ }
  }
}

async function sendReplyKeyboard(env, chatId) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: "เลือกคำสั่งได้เลยค่ะนาย:",
      reply_markup: {
        keyboard: [
          [{ text: "📋 Pending" }, { text: "🧠 Memories" }],
          [{ text: "📨 Send" }, { text: "🗑 Delete" }],
          [{ text: "📊 Dashboard", web_app: { url: env.DASHBOARD_URL || "https://friday-dashboard-3rf.pages.dev" } }],
        ],
        resize_keyboard: true,
        is_persistent: true,
      },
    }),
  });
}

// ===== Handlers =====

async function parseAndExecuteActions(env, reply) {
  let actionsExecuted = 0;

  // 1. Execute SEND actions
  const sendRegex = /\[SEND:(-?\d+):([^\]]+)\]/g;
  let match;
  while ((match = sendRegex.exec(reply)) !== null) {
    await sendTelegram(env, match[1], match[2], null, true);
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

async function handleMention(env, message, botUsername, text, hasMedia, isDM) {
  try {
    const cleanText = text.replace(new RegExp(`@${botUsername}`, "g"), "").trim();
    if (!cleanText && !hasMedia) return;

    await sendTyping(env, message.chat.id);

    let context;
    try {
      context = await getSmartContext(env.DB, message.chat.id, isDM, cleanText);
    } catch (ctxErr) {
      console.error("getSmartContext FAILED:", ctxErr.message, ctxErr.stack);
      context = "";
    }

    // ดึง HTML file: ดาวน์โหลด → แปลงเป็น text → แนบใน userMessage
    const isHtml = message.document?.mime_type === "text/html" ||
      message.reply_to_message?.document?.mime_type === "text/html";
    let htmlContent = null;
    if (isHtml) {
      const htmlFileId = (message.document?.mime_type === "text/html"
        ? message.document.file_id
        : message.reply_to_message?.document?.file_id);
      if (htmlFileId) {
        htmlContent = await downloadHtmlFile(env, htmlFileId);
      }
    }

    // ดึงรูป/PDF: จากข้อความนี้ → reply → รูปล่าสุด
    let imageData = null;
    if (!isHtml) {
      const fileId =
        getPhotoFileId(message) ||
        getPhotoFileId(message.reply_to_message) ||
        null;

      if (fileId) {
        imageData = await downloadPhotoByFileId(env, fileId);
      }

      // เช็คไฟล์ใหญ่เกินไป
      if (imageData?.error === "FILE_TOO_LARGE") {
        const sizeMB = (imageData.size / 1024 / 1024).toFixed(1);
        await sendTelegram(env, message.chat.id,
          `ไฟล์ใหญ่เกินไปค่ะนาย (${sizeMB}MB) รับได้ไม่เกิน 10MB ค่ะ`,
          message.message_id);
        return;
      }

      // ถ้ายังไม่มีรูป ดึงจากรูปล่าสุดใน DB (5 นาที) — ทั้ง DM และกลุ่ม
      if (!imageData) {
        imageData = await getRecentPhoto(env, message.chat.id, message.message_id);
      }
    }

    // แนบเนื้อหาข้อความที่ reply ถึง เพื่อให้ Gemini รู้บริบท
    let userMessage = cleanText;

    // แนบเนื้อหา HTML file
    if (htmlContent?.text) {
      const truncated = htmlContent.text.substring(0, 8000);
      const label = cleanText
        ? `[ไฟล์ HTML: ${htmlContent.fileName}]\n${truncated}\n\n${cleanText}`
        : `[ไฟล์ HTML: ${htmlContent.fileName}]\n${truncated}\n\nสรุปเนื้อหาในไฟล์นี้ให้หน่อย`;
      userMessage = label;
    }
    const replyMsg = message.reply_to_message;
    if (replyMsg && !htmlContent?.text) {
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
        await sendTelegram(env, message.from.id, cleanReply, null, true);
      } else {
        await sendTelegram(env, message.chat.id, cleanReply, message.message_id, true);
      }
    }
  } catch (err) {
    console.error("handleMention error:", err.message, err.stack);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดค่ะนาย ลองใหม่อีกครั้งนะคะ", message.message_id);
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

// ===== /readhtml — อ่านไฟล์ HTML =====

async function handleReadhtmlCommand(env, message, args) {
  try {
    const htmlMime = "text/html";

    // ตรวจจาก mime_type หรือนามสกุลไฟล์ .html/.htm
    const isHtmlDoc = (doc) => {
      if (!doc) return false;
      if (doc.mime_type === htmlMime) return true;
      const name = (doc.file_name || "").toLowerCase();
      return name.endsWith(".html") || name.endsWith(".htm");
    };

    const doc = isHtmlDoc(message.document)
      ? message.document
      : isHtmlDoc(message.reply_to_message?.document)
        ? message.reply_to_message.document
        : null;

    if (!doc) {
      await sendTelegram(env, message.chat.id,
        "วิธีใช้:\n• ส่งไฟล์ .html แล้วพิมพ์ /readhtml ใน caption\n• หรือ reply ไฟล์ .html แล้วพิมพ์ /readhtml",
        message.message_id);
      return;
    }

    await sendTyping(env, message.chat.id);

    const htmlContent = await downloadHtmlFile(env, doc.file_id);
    if (!htmlContent?.text) {
      await sendTelegram(env, message.chat.id, "ไม่สามารถอ่านไฟล์ HTML ได้ค่ะนาย", message.message_id);
      return;
    }

    // If args provided, process directly (like old behavior)
    if (args) {
      const truncated = htmlContent.text.substring(0, 8000);
      const userMessage = `[ไฟล์ HTML: ${htmlContent.fileName}]\n${truncated}\n\n${args}`;
      const isDM = message.chat.type === "private";
      let context = "";
      try { context = await getSmartContext(env.DB, message.chat.id, isDM, args); } catch (e) { /* ignore */ }
      let reply = await askGemini(env, userMessage, context, null);
      const { cleanReply } = await parseAndExecuteActions(env, reply);
      if (cleanReply) {
        await sendTelegram(env, message.chat.id, cleanReply, message.message_id, true);
      }
      return;
    }

    // Cache content + show keyboard
    const { meta } = await env.DB.prepare(
      `INSERT INTO file_cache (chat_id, file_type, file_name, body_text) VALUES (?, ?, ?, ?)`
    ).bind(message.chat.id, "html", htmlContent.fileName || "file.html", htmlContent.text.substring(0, 15000)).run();
    const cacheId = meta.last_row_id;

    const previewText = htmlContent.text.substring(0, 200).replace(/\n+/g, " ");
    let preview = "📄 <b>HTML File</b>\n";
    preview += `📁 <b>${htmlContent.fileName}</b>\n`;
    preview += `📝 ${previewText}...\n\nเลือกสิ่งที่ต้องการค่ะนาย:`;

    await sendTelegramWithKeyboard(env, message.chat.id, preview, message.message_id, [
      [
        { text: "📋 สรุปแบบสั้น", callback_data: `fc:short:${cacheId}` },
        { text: "📝 สรุปละเอียด", callback_data: `fc:detail:${cacheId}` },
      ],
      [
        { text: "🔍 วิเคราะห์", callback_data: `fc:analyze:${cacheId}` },
        { text: "💬 ถามเอง", callback_data: `fc:ask:${cacheId}` },
      ],
    ]);
  } catch (err) {
    console.error("handleReadhtmlCommand error:", err.message, err.stack);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดในการอ่านไฟล์ HTML ค่ะนาย", message.message_id);
  }
}

// ===== /readpdf — PDF Read with Inline Keyboard =====

async function handleReadpdfCommand(env, message, args) {
  try {
    const doc = (message.document?.mime_type === "application/pdf")
      ? message.document
      : (message.reply_to_message?.document?.mime_type === "application/pdf")
        ? message.reply_to_message.document
        : null;

    if (!doc) {
      await sendTelegram(env, message.chat.id,
        "วิธีใช้:\n• ส่งไฟล์ PDF แล้วพิมพ์ /readpdf ใน caption\n• หรือ reply ไฟล์ PDF แล้วพิมพ์ /readpdf",
        message.message_id);
      return;
    }

    // Check file size
    if (doc.file_size && doc.file_size > MAX_PDF_SIZE) {
      await sendTelegram(env, message.chat.id,
        `❌ ไฟล์ PDF ใหญ่เกินไป (${(doc.file_size / 1024 / 1024).toFixed(1)}MB) รองรับสูงสุด 10MB ค่ะนาย`,
        message.message_id);
      return;
    }

    await sendTyping(env, message.chat.id);

    // If args provided, process directly
    if (args) {
      const imageData = await downloadPhotoByFileId(env, doc.file_id);
      if (!imageData || imageData.error) {
        const errMsg = imageData?.error === "FILE_TOO_LARGE"
          ? `❌ ไฟล์ PDF ใหญ่เกินไป รองรับสูงสุด 10MB ค่ะนาย`
          : "❌ ไม่สามารถดาวน์โหลดไฟล์ PDF ได้ค่ะนาย";
        await sendTelegram(env, message.chat.id, errMsg, message.message_id);
        return;
      }
      const userMessage = `[ไฟล์ PDF: ${doc.file_name || "file.pdf"}]\n\n${args}`;
      const isDM = message.chat.type === "private";
      let context = "";
      try { context = await getSmartContext(env.DB, message.chat.id, isDM, args); } catch (e) { /* ignore */ }
      let reply = await askGemini(env, userMessage, context, imageData);
      const { cleanReply } = await parseAndExecuteActions(env, reply);
      if (cleanReply) {
        await sendTelegram(env, message.chat.id, cleanReply, message.message_id, true);
      }
      return;
    }

    // Cache file_id + show keyboard
    const { meta } = await env.DB.prepare(
      `INSERT INTO file_cache (chat_id, file_type, file_name, file_id) VALUES (?, ?, ?, ?)`
    ).bind(message.chat.id, "pdf", doc.file_name || "file.pdf", doc.file_id).run();
    const cacheId = meta.last_row_id;

    let preview = "📄 <b>PDF File</b>\n";
    preview += `📁 <b>${doc.file_name || "file.pdf"}</b>\n`;
    if (doc.file_size) preview += `📦 ${(doc.file_size / 1024).toFixed(0)} KB\n`;
    preview += `\nเลือกสิ่งที่ต้องการค่ะนาย:`;

    await sendTelegramWithKeyboard(env, message.chat.id, preview, message.message_id, [
      [
        { text: "📋 สรุปแบบสั้น", callback_data: `fc:short:${cacheId}` },
        { text: "📝 สรุปละเอียด", callback_data: `fc:detail:${cacheId}` },
      ],
      [
        { text: "🔍 วิเคราะห์", callback_data: `fc:analyze:${cacheId}` },
        { text: "💬 ถามเอง", callback_data: `fc:ask:${cacheId}` },
      ],
    ]);
  } catch (err) {
    console.error("handleReadpdfCommand error:", err.message, err.stack);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดในการอ่านไฟล์ PDF ค่ะนาย", message.message_id);
  }
}

// ===== /readimg — Image Read with Inline Keyboard =====

async function handleReadimgCommand(env, message, args) {
  try {
    const hasPhoto = !!(message.photo?.length > 0 || message.document?.mime_type?.startsWith("image/"));
    const replyHasPhoto = !!(message.reply_to_message?.photo?.length > 0 || message.reply_to_message?.document?.mime_type?.startsWith("image/"));

    const sourceMsg = hasPhoto ? message : replyHasPhoto ? message.reply_to_message : null;

    if (!sourceMsg) {
      await sendTelegram(env, message.chat.id,
        "วิธีใช้:\n• ส่งรูปแล้วพิมพ์ /readimg ใน caption\n• หรือ reply รูปแล้วพิมพ์ /readimg",
        message.message_id);
      return;
    }

    await sendTyping(env, message.chat.id);

    const fileId = getPhotoFileId(sourceMsg);
    if (!fileId) {
      await sendTelegram(env, message.chat.id, "❌ ไม่สามารถอ่านรูปภาพได้ค่ะนาย", message.message_id);
      return;
    }

    // If args provided, process directly
    if (args) {
      const imageData = await downloadPhotoByFileId(env, fileId);
      if (!imageData || imageData.error) {
        await sendTelegram(env, message.chat.id, "❌ ไม่สามารถดาวน์โหลดรูปภาพได้ค่ะนาย", message.message_id);
        return;
      }
      const userMessage = `[รูปภาพ]\n\n${args}`;
      const isDM = message.chat.type === "private";
      let context = "";
      try { context = await getSmartContext(env.DB, message.chat.id, isDM, args); } catch (e) { /* ignore */ }
      let reply = await askGemini(env, userMessage, context, imageData);
      const { cleanReply } = await parseAndExecuteActions(env, reply);
      if (cleanReply) {
        await sendTelegram(env, message.chat.id, cleanReply, message.message_id, true);
      }
      return;
    }

    // Get file name
    const fileName = sourceMsg.document?.file_name || "image.jpg";

    // Cache file_id + show keyboard
    const { meta } = await env.DB.prepare(
      `INSERT INTO file_cache (chat_id, file_type, file_name, file_id) VALUES (?, ?, ?, ?)`
    ).bind(message.chat.id, "image", fileName, fileId).run();
    const cacheId = meta.last_row_id;

    let preview = "🖼 <b>Image File</b>\n";
    preview += `📁 <b>${fileName}</b>\n`;
    preview += `\nเลือกสิ่งที่ต้องการค่ะนาย:`;

    await sendTelegramWithKeyboard(env, message.chat.id, preview, message.message_id, [
      [
        { text: "📋 สรุปแบบสั้น", callback_data: `fc:short:${cacheId}` },
        { text: "📝 สรุปละเอียด", callback_data: `fc:detail:${cacheId}` },
      ],
      [
        { text: "🔍 วิเคราะห์", callback_data: `fc:analyze:${cacheId}` },
        { text: "💬 ถามเอง", callback_data: `fc:ask:${cacheId}` },
      ],
    ]);
  } catch (err) {
    console.error("handleReadimgCommand error:", err.message, err.stack);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดในการอ่านรูปภาพค่ะนาย", message.message_id);
  }
}

// ===== File Callback Handler (fc:*) =====

async function handleFileCallback(env, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  // Parse callback data: "fc:<mode>:<cacheId>"
  const parts = callbackQuery.data.split(":");
  const mode = parts[1];
  const cacheId = Number(parts[2]);

  const modeLabels = { short: "สรุปแบบสั้น", detail: "สรุปละเอียด", analyze: "วิเคราะห์", ask: "ถามเอง" };

  // Answer callback query
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQuery.id,
      text: `⏳ กำลัง${modeLabels[mode]}...`,
    }),
  });

  // Escape originalText for HTML
  const originalText = (callbackQuery.message.text || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Helper: editMessageText
  const editPreview = async (html) => {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: sanitizeHtml(html),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [] },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("editPreview failed:", err);
    }
    return res.ok;
  };

  // Update preview status + remove buttons
  const statusText = mode === "ask"
    ? `${originalText}\n\n💬 <b>โหมดถามเอง</b> — reply ข้อความถัดไปเพื่อถามค่ะ`
    : `${originalText}\n\n⏳ <b>กำลัง${modeLabels[mode]}...</b>`;
  const editOk = await editPreview(statusText);
  if (!editOk) return;

  // Load cache
  const { results } = await env.DB.prepare(
    `SELECT file_type, file_name, body_text, file_id FROM file_cache WHERE id = ?`
  ).bind(cacheId).all();

  if (!results.length) {
    await editPreview(`${originalText}\n\n❌ <b>ไม่พบข้อมูลไฟล์ อาจหมดอายุแล้ว</b>`);
    await sendTelegram(env, chatId, "❌ ไม่พบข้อมูลไฟล์ อาจหมดอายุแล้ว กรุณาส่งไฟล์ใหม่ค่ะนาย", messageId);
    return;
  }

  const cache = results[0];

  // Mode: ถามเอง → send message for reply
  if (mode === "ask") {
    await sendTelegram(env, chatId,
      `💬 พิมพ์คำถามเกี่ยวกับไฟล์นี้ได้เลยค่ะนาย (reply ข้อความนี้)\n\n[fc:${cacheId}]`,
      messageId);
    return;
  }

  const noIntro = "[คำสั่งสำคัญ: ห้ามขึ้นต้นด้วย 'รับทราบ' 'สรุปให้ดังนี้' หรือเกริ่นนำใดๆ — เริ่มเนื้อหาทันที]";
  const fileLabel = `ไฟล์ ${cache.file_type.toUpperCase()}: ${cache.file_name || "unknown"}`;

  let prompt;
  let imageData = null;

  if (cache.file_type === "html") {
    const bodyText = cache.body_text || "";
    const prompts = {
      short: `${noIntro}\nสรุปเนื้อหาจากไฟล์นี้แบบกระชับ สั้นที่สุด 2-3 ประโยค:\n\n[${fileLabel}]\n\n--- เนื้อหา ---\n${bodyText}`,
      detail: `${noIntro}\nสรุปเนื้อหาจากไฟล์นี้อย่างละเอียดครบทุกประเด็นสำคัญ:\n\n[${fileLabel}]\n\n--- เนื้อหา ---\n${bodyText}`,
      analyze: `${noIntro}\nวิเคราะห์เนื้อหาจากไฟล์นี้เชิงลึก ระบุจุดแข็ง จุดอ่อน ข้อสังเกต และข้อควรระวัง:\n\n[${fileLabel}]\n\n--- เนื้อหา ---\n${bodyText}`,
    };
    prompt = prompts[mode];
  } else {
    // PDF / Image: re-download
    imageData = await downloadPhotoByFileId(env, cache.file_id);
    if (!imageData || imageData.error) {
      const typeLabel = cache.file_type === "image" ? "รูปภาพ" : "ไฟล์ PDF";
      await editPreview(`${originalText}\n\n❌ <b>ไม่สามารถดาวน์โหลด${typeLabel}ได้</b>`);
      await sendTelegram(env, chatId, `❌ ไม่สามารถดาวน์โหลด${typeLabel}ได้ค่ะนาย กรุณาส่งไฟล์ใหม่`, messageId);
      return;
    }
    const typeDesc = cache.file_type === "image" ? "รูปภาพ" : "ไฟล์ PDF";
    const prompts = {
      short: `${noIntro}\nสรุปเนื้อหาจาก${typeDesc}นี้แบบกระชับ สั้นที่สุด 2-3 ประโยค:\n\n[${fileLabel}]`,
      detail: `${noIntro}\nสรุปเนื้อหาจาก${typeDesc}นี้อย่างละเอียดครบทุกประเด็นสำคัญ:\n\n[${fileLabel}]`,
      analyze: `${noIntro}\nวิเคราะห์เนื้อหาจาก${typeDesc}นี้เชิงลึก ระบุจุดแข็ง จุดอ่อน ข้อสังเกต และข้อควรระวัง:\n\n[${fileLabel}]`,
    };
    prompt = prompts[mode];
  }

  try {
    await sendTyping(env, chatId);
    const context = await getSmartContext(env.DB, chatId, callbackQuery.message.chat.type === "private", "");
    const reply = await askGemini(env, prompt, context, imageData);
    const { cleanReply } = await parseAndExecuteActions(env, reply);
    if (cleanReply) {
      await sendTelegram(env, chatId, cleanReply, null, true);
    }
    await editPreview(`${originalText}\n\n✅ <b>${modeLabels[mode]}แล้ว</b>`);
  } catch (err) {
    console.error("handleFileCallback Gemini error:", err.message, err.stack);
    await editPreview(`${originalText}\n\n❌ <b>เกิดข้อผิดพลาด</b> — ลองส่งไฟล์ใหม่ค่ะ`);
    await sendTelegram(env, chatId, "❌ เกิดข้อผิดพลาดในการประมวลผลค่ะนาย กรุณาลองใหม่", messageId);
  }
}

// ===== File Ask Handler (reply ถามเอง) =====

async function handleFileAsk(env, message, cacheId, question) {
  const { results } = await env.DB.prepare(
    `SELECT file_type, file_name, body_text, file_id FROM file_cache WHERE id = ?`
  ).bind(cacheId).all();

  if (!results.length) {
    await sendTelegram(env, message.chat.id, "❌ ไม่พบข้อมูลไฟล์ อาจหมดอายุแล้ว กรุณาส่งไฟล์ใหม่ค่ะนาย", message.message_id);
    return;
  }

  const cache = results[0];
  await sendTyping(env, message.chat.id);

  const fileLabel = `ไฟล์ ${cache.file_type.toUpperCase()}: ${cache.file_name || "unknown"}`;
  let prompt;
  let imageData = null;

  if (cache.file_type === "html") {
    prompt = `ตอบคำถามเกี่ยวกับเนื้อหาไฟล์นี้:\n\n[${fileLabel}]\n\nคำถาม: ${question}\n\n--- เนื้อหา ---\n${cache.body_text || ""}`;
  } else {
    // PDF / Image: re-download
    imageData = await downloadPhotoByFileId(env, cache.file_id);
    if (!imageData || imageData.error) {
      const typeLabel = cache.file_type === "image" ? "รูปภาพ" : "ไฟล์ PDF";
      await sendTelegram(env, message.chat.id, `❌ ไม่สามารถดาวน์โหลด${typeLabel}ได้ค่ะนาย กรุณาส่งไฟล์ใหม่`, message.message_id);
      return;
    }
    const typeDesc = cache.file_type === "image" ? "รูปภาพ" : "ไฟล์ PDF";
    prompt = `ตอบคำถามเกี่ยวกับ${typeDesc}นี้:\n\n[${fileLabel}]\n\nคำถาม: ${question}`;
  }

  const context = await getSmartContext(env.DB, message.chat.id, message.chat.type === "private", "");
  const reply = await askGemini(env, prompt, context, imageData);
  const { cleanReply } = await parseAndExecuteActions(env, reply);
  if (cleanReply) {
    await sendTelegram(env, message.chat.id, cleanReply, message.message_id, true);
  }
}

// ===== /readvoice — Text-to-Speech Command =====

async function handleReadvoiceCommand(env, message, args) {
  let ttsText = "";
  if (args) {
    ttsText = args;
  } else if (message.reply_to_message) {
    ttsText = message.reply_to_message.text || message.reply_to_message.caption || "";
  }
  if (!ttsText) {
    await sendTelegram(env, message.chat.id, "วิธีใช้:\n• /readvoice ข้อความ — พิมพ์ข้อความที่ต้องการให้อ่าน\n• reply ข้อความ แล้วพิมพ์ /readvoice — อ่านข้อความที่ reply", message.message_id);
    return;
  }
  await sendTyping(env, message.chat.id);
  const audio = await textToSpeech(env, ttsText);
  if (audio) {
    await sendVoice(env, message.chat.id, audio, message.message_id);
  } else {
    await sendTelegram(env, message.chat.id, "ไม่สามารถแปลงเป็นเสียงได้ค่ะนาย กรุณาตรวจสอบว่าเปิด Cloud TTS API แล้ว", message.message_id);
  }
}

// ===== /readlink — ดึงเนื้อหาจาก URL =====

function extractMeta(html, regex) {
  const match = html.match(regex);
  return match ? match[1].trim() : null;
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

async function fetchUrlContent(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; FridayBot/1.0)",
      "Accept": "text/html,application/xhtml+xml,*/*",
    },
    redirect: "follow",
  });

  if (!response.ok) return { error: `HTTP ${response.status}` };

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    return { error: `ไม่รองรับ content-type: ${contentType}` };
  }

  const html = await response.text();
  const trimmedHtml = html.substring(0, 500_000);

  const title = extractMeta(trimmedHtml, /<title[^>]*>([^<]*)<\/title>/i)
    || extractMeta(trimmedHtml, /property="og:title"\s+content="([^"]*)"/i);
  const description = extractMeta(trimmedHtml, /property="og:description"\s+content="([^"]*)"/i)
    || extractMeta(trimmedHtml, /name="description"\s+content="([^"]*)"/i);
  const ogImage = extractMeta(trimmedHtml, /property="og:image"\s+content="([^"]*)"/i);
  const siteName = extractMeta(trimmedHtml, /property="og:site_name"\s+content="([^"]*)"/i);

  const bodyText = htmlToText(trimmedHtml);
  const truncatedText = bodyText.substring(0, 8000);

  return { title, description, ogImage, siteName, bodyText: truncatedText, url };
}

async function handleReadlinkCommand(env, message, args) {
  try {
    let url = args.trim();
    if (!url && message.reply_to_message) {
      const replyText = message.reply_to_message.text || message.reply_to_message.caption || "";
      const urlMatch = replyText.match(/https?:\/\/[^\s]+/);
      if (urlMatch) url = urlMatch[0];
    }

    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      await sendTelegram(env, message.chat.id,
        "Usage: /readlink <url>\nหรือ reply ข้อความที่มีลิงก์แล้วพิมพ์ /readlink", message.message_id);
      return;
    }

    await sendTyping(env, message.chat.id);

    const result = await fetchUrlContent(url);
    if (result.error) {
      await sendTelegram(env, message.chat.id, `❌ ไม่สามารถอ่านลิงก์ได้: ${result.error}`, message.message_id);
      return;
    }

    if (!result.bodyText || result.bodyText.length <= 50) {
      await sendTelegram(env, message.chat.id,
        "⚠️ เว็บไซต์นี้มีเนื้อหาน้อยเกินไปหรือต้องล็อกอินก่อนค่ะนาย ไม่สามารถวิเคราะห์เพิ่มเติมได้", message.message_id);
      return;
    }

    // บันทึก cache
    const { meta } = await env.DB.prepare(
      `INSERT INTO readlink_cache (chat_id, url, title, body_text) VALUES (?, ?, ?, ?)`
    ).bind(message.chat.id, url, result.title || "", result.bodyText || "").run();
    const cacheId = meta.last_row_id;

    // แสดง preview + ปุ่มเลือก
    let preview = "🔗 <b>Link Preview</b>\n";
    if (result.title) preview += `📄 <b>${result.title}</b>\n`;
    if (result.siteName) preview += `🌐 ${result.siteName}\n`;
    if (result.description) preview += `📝 ${result.description}\n`;
    preview += `🔗 ${url}\n\nเลือกสิ่งที่ต้องการค่ะนาย:`;

    await sendTelegramWithKeyboard(env, message.chat.id, preview, message.message_id, [
      [
        { text: "📋 สรุปแบบสั้น", callback_data: `rl:short:${cacheId}` },
        { text: "📝 สรุปละเอียด", callback_data: `rl:detail:${cacheId}` },
      ],
      [
        { text: "🔍 วิเคราะห์", callback_data: `rl:analyze:${cacheId}` },
        { text: "💬 ถามเอง", callback_data: `rl:ask:${cacheId}` },
      ],
    ]);
  } catch (err) {
    console.error("handleReadlinkCommand error:", err.message, err.stack);
    await sendTelegram(env, message.chat.id, "❌ เกิดข้อผิดพลาดในการอ่านลิงก์ค่ะนาย", message.message_id);
  }
}

async function handleReadlinkCallback(env, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  // Parse callback data: "rl:<mode>:<cacheId>"
  const parts = callbackQuery.data.split(":");
  const mode = parts[1];
  const cacheId = Number(parts[2]);

  const modeLabels = { short: "สรุปแบบสั้น", detail: "สรุปละเอียด", analyze: "วิเคราะห์", ask: "ถามเอง" };

  // Answer callback query พร้อมแสดง toast
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQuery.id,
      text: `⏳ กำลัง${modeLabels[mode]}...`,
    }),
  });

  // Escape originalText สำหรับ HTML (เพราะ .text เป็น plain text อาจมี & < > ใน URL/title)
  const originalText = (callbackQuery.message.text || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Helper: editMessageText สำหรับ update สถานะบน preview
  const editPreview = async (html) => {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: sanitizeHtml(html),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [] },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("editPreview failed:", err);
    }
    return res.ok;
  };

  // แก้ข้อความ preview — เปลี่ยนสถานะ + ลบปุ่ม (กันกดซ้ำ)
  const statusText = mode === "ask"
    ? `${originalText}\n\n💬 <b>โหมดถามเอง</b> — reply ข้อความถัดไปเพื่อถามค่ะ`
    : `${originalText}\n\n⏳ <b>กำลัง${modeLabels[mode]}...</b>`;
  const editOk = await editPreview(statusText);

  // ถ้า edit ไม่สำเร็จ = callback อื่นแก้ไปแล้ว (กดซ้ำ) → abort
  if (!editOk) return;

  // โหลด cache
  const { results } = await env.DB.prepare(
    `SELECT url, title, body_text FROM readlink_cache WHERE id = ?`
  ).bind(cacheId).all();

  if (!results.length || !results[0].body_text) {
    await editPreview(`${originalText}\n\n❌ <b>ไม่พบข้อมูลลิงก์ อาจหมดอายุแล้ว</b>`);
    await sendTelegram(env, chatId, "❌ ไม่พบข้อมูลลิงก์ อาจหมดอายุแล้ว กรุณาใช้ /readlink ใหม่ค่ะนาย", messageId);
    return;
  }

  const { url, title, body_text } = results[0];

  // Mode: ถามเอง → ส่งข้อความให้ reply
  if (mode === "ask") {
    await sendTelegram(env, chatId,
      `💬 พิมพ์คำถามเกี่ยวกับเนื้อหาลิงก์นี้ได้เลยค่ะนาย (reply ข้อความนี้)\n\n[rl:${cacheId}]`,
      messageId);
    return;
  }

  const noIntro = "[คำสั่งสำคัญ: ห้ามขึ้นต้นด้วย 'รับทราบ' 'สรุปให้ดังนี้' หรือเกริ่นนำใดๆ — เริ่มเนื้อหาทันที]";
  const prompts = {
    short: `${noIntro}\nสรุปเนื้อหาจากเว็บไซต์นี้แบบกระชับ สั้นที่สุด 2-3 ประโยค:\n\nURL: ${url}\nTitle: ${title || "N/A"}\n\n--- เนื้อหา ---\n${body_text}`,
    detail: `${noIntro}\nสรุปเนื้อหาจากเว็บไซต์นี้อย่างละเอียดครบทุกประเด็นสำคัญ:\n\nURL: ${url}\nTitle: ${title || "N/A"}\n\n--- เนื้อหา ---\n${body_text}`,
    analyze: `${noIntro}\nวิเคราะห์เนื้อหาจากเว็บไซต์นี้เชิงลึก ระบุจุดแข็ง จุดอ่อน ข้อสังเกต และข้อควรระวัง:\n\nURL: ${url}\nTitle: ${title || "N/A"}\n\n--- เนื้อหา ---\n${body_text}`,
  };

  try {
    await sendTyping(env, chatId);
    const context = await getSmartContext(env.DB, chatId, callbackQuery.message.chat.type === "private", "");
    const reply = await askGemini(env, prompts[mode], context, null);
    const { cleanReply } = await parseAndExecuteActions(env, reply);
    if (cleanReply) {
      await sendTelegram(env, chatId, cleanReply, null, true);
    }

    // อัพเดทสถานะเป็นเสร็จ
    await editPreview(`${originalText}\n\n✅ <b>${modeLabels[mode]}แล้ว</b>`);
  } catch (err) {
    console.error("handleReadlinkCallback Gemini error:", err.message, err.stack);
    await editPreview(`${originalText}\n\n❌ <b>เกิดข้อผิดพลาด</b> — ลองใช้ /readlink ใหม่ค่ะ`);
    await sendTelegram(env, chatId, "❌ เกิดข้อผิดพลาดในการประมวลผลค่ะนาย กรุณาลองใหม่", messageId);
  }
}

async function handleReadlinkAsk(env, message, cacheId, question) {
  const { results } = await env.DB.prepare(
    `SELECT url, title, body_text FROM readlink_cache WHERE id = ?`
  ).bind(cacheId).all();

  if (!results.length || !results[0].body_text) {
    await sendTelegram(env, message.chat.id, "❌ ไม่พบข้อมูลลิงก์ อาจหมดอายุแล้ว กรุณาใช้ /readlink ใหม่ค่ะนาย", message.message_id);
    return;
  }

  const { url, title, body_text } = results[0];
  await sendTyping(env, message.chat.id);
  const prompt = `ตอบคำถามเกี่ยวกับเนื้อหาเว็บไซต์นี้:\n\nURL: ${url}\nTitle: ${title || "N/A"}\n\nคำถาม: ${question}\n\n--- เนื้อหา ---\n${body_text}`;
  const context = await getSmartContext(env.DB, message.chat.id, message.chat.type === "private", "");
  const reply = await askGemini(env, prompt, context, null);
  const { cleanReply } = await parseAndExecuteActions(env, reply);
  if (cleanReply) {
    await sendTelegram(env, message.chat.id, cleanReply, message.message_id, true);
  }
}

// ===== Boss Commands =====

async function handleSendCommand(env, message, args) {
  try {
    // Interactive mode: no args → show group list
    if (!args.trim()) {
      const { results } = await env.DB.prepare(`
        SELECT chat_id, chat_title, MAX(created_at) as last_msg
        FROM messages
        WHERE chat_id != ? AND chat_title IS NOT NULL
        GROUP BY chat_id
        ORDER BY last_msg DESC
        LIMIT 10
      `).bind(message.chat.id).all();

      if (!results.length) {
        await sendTelegram(env, message.chat.id, "ไม่พบกลุ่มที่เคยมีข้อความค่ะ", message.message_id);
        return;
      }

      const buttons = results.map(r => [{
        text: r.chat_title || `Group ${r.chat_id}`,
        callback_data: `send:g:${r.chat_id}`
      }]);

      await sendTelegramWithKeyboard(env, message.chat.id,
        "📨 เลือกกลุ่มที่ต้องการส่งข้อความค่ะนาย:", message.message_id, buttons);
      return;
    }

    // Direct mode: /send <chat_id> <message> (backward compat)
    const parts = args.trim().split(/\s+/);
    if (parts.length < 2) {
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

async function handleSendCallback(env, callbackQuery) {
  const parts = callbackQuery.data.split(":");
  const action = parts[1]; // "g"
  const targetChatId = parts.slice(2).join(":"); // handle negative chat IDs

  const REPLY_KB = {
    keyboard: [
      [{ text: "📋 Pending" }, { text: "🧠 Memories" }],
      [{ text: "📨 Send" }, { text: "🗑 Delete" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };

  if (action === "a") {
    // Approve: extract message from preview and send to group
    const fullText = callbackQuery.message.text || "";
    // Preview format: "📝 ข้อความที่จะส่งไปยัง "GroupName":\n\n{message}"
    const messageToSend = fullText.replace(/^[^\n]*\n\n/, "");
    // Send directly and check response (sendTelegram doesn't throw on API errors)
    const sendRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: targetChatId, text: messageToSend }),
    });
    let sendOk = false;
    if (sendRes.ok) {
      try {
        const sendResult = await sendRes.json();
        if (sendResult.ok) {
          sendOk = true;
          await trackBotMessage(env, targetChatId, sendResult.result.message_id, messageToSend);
        }
      } catch (e) { /* ignore */ }
    } else {
      console.error("send approve error:", await sendRes.text());
    }
    // Remove inline buttons from preview
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id,
        reply_markup: { inline_keyboard: [] },
      }),
    });
    // Send confirmation + restore reply keyboard
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: callbackQuery.message.chat.id,
        text: sendOk ? "✅ ส่งแล้วค่ะนาย" : "❌ ส่งไม่สำเร็จ",
        reply_markup: REPLY_KB,
      }),
    });
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQuery.id }),
    });
    return;
  }

  if (action === "r") {
    // Reject: remove inline buttons from preview
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id,
        reply_markup: { inline_keyboard: [] },
      }),
    });
    // Send confirmation + restore reply keyboard
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: callbackQuery.message.chat.id,
        text: "❌ ยกเลิกแล้วค่ะนาย",
        reply_markup: REPLY_KB,
      }),
    });
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQuery.id }),
    });
    return;
  }

  if (action === "g") {
    const row = await env.DB.prepare(
      `SELECT chat_title FROM messages WHERE chat_id = ? AND chat_title IS NOT NULL ORDER BY created_at DESC LIMIT 1`
    ).bind(targetChatId).first();
    const groupName = row?.chat_title || `Group ${targetChatId}`;

    const chatId = callbackQuery.message.chat.id;

    // Store target in DB so we don't need to embed ugly tag in message
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pending_sends (user_id INTEGER PRIMARY KEY, target_chat_id TEXT, created_at TEXT DEFAULT (datetime('now')))`).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO pending_sends (user_id, target_chat_id) VALUES (?, ?)`).bind(chatId, targetChatId).run();

    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `📨 สั่ง AI ว่าต้องการส่งอะไรไปยัง "${groupName}" (reply ข้อความนี้ค่ะนาย)`,
        reply_markup: { force_reply: true, selective: true },
      }),
    });

    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQuery.id }),
    });
  }
}

async function handleSendReply(env, message, targetChatId, msgText) {
  try {
    await sendTyping(env, message.chat.id);

    // Get group name for display
    const row = await env.DB.prepare(
      `SELECT chat_title FROM messages WHERE chat_id = ? AND chat_title IS NOT NULL ORDER BY created_at DESC LIMIT 1`
    ).bind(targetChatId).first();
    const groupName = row?.chat_title || `Group ${targetChatId}`;

    // Get smart context from DM
    const context = await getSmartContext(env.DB, message.chat.id, true, msgText);

    // Ask AI to draft the message
    const aiPrompt = `บอสต้องการให้เขียนข้อความเพื่อส่งไปยังกลุ่ม (chat_id: ${targetChatId})\nคำสั่ง: ${msgText}\nกรุณาเขียนเฉพาะเนื้อหาข้อความที่จะส่งเท่านั้น ไม่ต้องใส่คำอธิบาย หมายเหตุ หรือ action tags ใดๆ`;
    const aiResponse = await askGemini(env, aiPrompt, context, null);

    // Strip action tags, grounding links, and HTML tags → clean plain text
    const cleanMessage = stripHtmlTags(
      aiResponse
        .replace(/\[SEND:[^\]]+\]/g, '')
        .replace(/\[REMEMBER:\w+:[^\]]+\]/g, '')
        .replace(/\[FORGET:\d+\]/g, '')
        // Strip Gemini grounding citation links (• <a href="vertexaisearch...">domain</a>)
        .replace(/[•*\-]?\s*<a\s+href="https?:\/\/vertexaisearch\.cloud\.google\.com\/[^"]*">[^<]*<\/a>/g, '')
    ).replace(/\n*\s*🔗?\s*แหล่งข้อมูล:?\s*$/, '').replace(/\n{3,}/g, '\n\n').trim();

    // Escape &<> for safe HTML preview (sendTelegramWithKeyboard uses parse_mode: HTML)
    const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const previewText = `📝 ข้อความที่จะส่งไปยัง "${esc(groupName)}":\n\n${esc(cleanMessage)}`;
    const buttons = [
      [
        { text: "✅ อนุมัติส่ง", callback_data: `send:a:${targetChatId}` },
        { text: "❌ ยกเลิก", callback_data: `send:r:${targetChatId}` },
      ],
    ];
    await sendTelegramWithKeyboard(env, message.chat.id, previewText, message.message_id, buttons);
  } catch (err) {
    await sendTelegram(env, message.chat.id, "ส่งไม่สำเร็จ: " + err.message, message.message_id);
  }
}

// ===== /delete — ลบข้อความในกลุ่มจาก DM =====

async function handleDeleteCommand(env, message) {
  try {
    if (message.chat.type !== "private") {
      await sendTelegram(env, message.chat.id, "คำสั่ง /delete ใช้ได้เฉพาะใน DM เท่านั้นค่ะนาย", message.message_id);
      return;
    }
    const { results } = await env.DB
      .prepare(
        `SELECT chat_id, MAX(created_at) as last_msg
         FROM bot_messages
         WHERE created_at > datetime('now', '-48 hours')
         GROUP BY chat_id
         ORDER BY last_msg DESC`
      )
      .all();
    if (!results.length) {
      await sendTelegram(env, message.chat.id, "ไม่พบข้อความของ Friday ในกลุ่มใดเลยในช่วง 48 ชม.ที่ผ่านมาค่ะนาย", message.message_id);
      return;
    }
    // ดึงชื่อกลุ่มจาก messages table
    const chatIds = results.map(r => r.chat_id);
    const placeholders = chatIds.map(() => "?").join(",");
    const { results: titles } = await env.DB
      .prepare(
        `SELECT chat_id, chat_title FROM messages
         WHERE chat_id IN (${placeholders}) AND chat_title IS NOT NULL
         GROUP BY chat_id`
      )
      .bind(...chatIds)
      .all();
    const titleMap = {};
    for (const t of titles) titleMap[t.chat_id] = t.chat_title;

    const buttons = results.map((r) => [
      { text: titleMap[r.chat_id] || `Group ${r.chat_id}`, callback_data: `del:g:${r.chat_id}` },
    ]);
    buttons.push([{ text: "🗑 ลบทั้งหมดทุกกลุ่ม", callback_data: "del:aa" }]);
    await sendTelegramWithKeyboard(env, message.chat.id, "🗑 เลือกกลุ่มที่ต้องการลบข้อความของ Friday:", message.message_id, buttons);
  } catch (err) {
    console.error("handleDeleteCommand error:", err);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดค่ะนาย: " + err.message, message.message_id);
  }
}

async function handleDeleteCallback(env, callbackQuery) {
  const parts = callbackQuery.data.split(":");
  const action = parts[1];
  try {
    if (action === "g" || action === "p") {
      const targetChatId = parts[2];
      const offset = action === "p" ? parseInt(parts[3], 10) : 0;
      await showGroupMessages(env, callbackQuery, targetChatId, offset);
    } else if (action === "m") {
      const targetChatId = parts[2];
      const targetMsgId = parseInt(parts[3], 10);
      await executeDeleteMessage(env, callbackQuery, targetChatId, targetMsgId);
    } else if (action === "a") {
      const targetChatId = parts[2];
      await executeDeleteAll(env, callbackQuery, targetChatId);
    } else if (action === "aa") {
      await executeDeleteAllGroups(env, callbackQuery);
    } else if (action === "b") {
      await showGroupList(env, callbackQuery);
    }
  } catch (err) {
    console.error("handleDeleteCallback error:", err);
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQuery.id,
        text: "เกิดข้อผิดพลาด: " + err.message,
        show_alert: true,
      }),
    });
  }
}

async function showGroupMessages(env, callbackQuery, targetChatId, offset) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const limit = 10;
  const { results } = await env.DB
    .prepare(
      `SELECT message_id, text_preview, datetime(created_at, '+7 hours') as created_at
       FROM bot_messages
       WHERE chat_id = ? AND created_at > datetime('now', '-48 hours')
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(targetChatId, limit + 1, offset)
    .all();
  const hasNext = results.length > limit;
  const rows = results.slice(0, limit);
  if (!rows.length) {
    const buttons = [[{ text: "⬅️ กลับ", callback_data: "del:b" }]];
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: "ไม่มีข้อความของ Friday ในกลุ่มนี้ในช่วง 48 ชม.ที่ผ่านมาค่ะนาย",
        reply_markup: { inline_keyboard: buttons },
      }),
    });
    return;
  }
  const buttons = rows.map((r) => {
    const preview = (r.text_preview || "").substring(0, 30);
    const label = `Friday: ${preview}${(r.text_preview || "").length > 30 ? "…" : ""}`;
    return [{ text: label, callback_data: `del:m:${targetChatId}:${r.message_id}` }];
  });
  // ปุ่มลบทั้งหมด
  buttons.push([{ text: "🗑 ลบทั้งหมดในกลุ่มนี้", callback_data: `del:a:${targetChatId}` }]);
  const nav = [];
  nav.push({ text: "⬅️ กลับ", callback_data: "del:b" });
  if (hasNext) {
    nav.push({ text: "หน้าถัดไป ➡️", callback_data: `del:p:${targetChatId}:${offset + limit}` });
  }
  buttons.push(nav);
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: "🗑 แตะข้อความของ Friday ที่ต้องการลบ:",
      reply_markup: { inline_keyboard: buttons },
    }),
  });
}

async function showGroupList(env, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const { results } = await env.DB
    .prepare(
      `SELECT chat_id, MAX(created_at) as last_msg
       FROM bot_messages
       WHERE created_at > datetime('now', '-48 hours')
       GROUP BY chat_id
       ORDER BY last_msg DESC`
    )
    .all();
  if (!results.length) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: "ไม่พบข้อความของ Friday ในกลุ่มใดเลยในช่วง 48 ชม.ที่ผ่านมาค่ะนาย",
        reply_markup: { inline_keyboard: [] },
      }),
    });
    return;
  }
  // ดึงชื่อกลุ่ม
  const chatIds = results.map(r => r.chat_id);
  const placeholders = chatIds.map(() => "?").join(",");
  const { results: titles } = await env.DB
    .prepare(
      `SELECT chat_id, chat_title FROM messages
       WHERE chat_id IN (${placeholders}) AND chat_title IS NOT NULL
       GROUP BY chat_id`
    )
    .bind(...chatIds)
    .all();
  const titleMap = {};
  for (const t of titles) titleMap[t.chat_id] = t.chat_title;

  const buttons = results.map((r) => [
    { text: titleMap[r.chat_id] || `Group ${r.chat_id}`, callback_data: `del:g:${r.chat_id}` },
  ]);
  buttons.push([{ text: "🗑 ลบทั้งหมดทุกกลุ่ม", callback_data: "del:aa" }]);
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: "🗑 เลือกกลุ่มที่ต้องการลบข้อความของ Friday:",
      reply_markup: { inline_keyboard: buttons },
    }),
  });
}

async function executeDeleteMessage(env, callbackQuery, targetChatId, targetMsgId) {
  // ลบจาก Telegram
  const delRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: targetChatId, message_id: targetMsgId }),
  });
  const delResult = await delRes.json();
  // ลบจาก bot_messages DB
  await env.DB
    .prepare(`DELETE FROM bot_messages WHERE chat_id = ? AND message_id = ?`)
    .bind(targetChatId, targetMsgId)
    .run();
  let toastText;
  if (delResult.ok) {
    toastText = "ลบข้อความสำเร็จแล้วค่ะนาย ✓";
  } else {
    const desc = delResult.description || "";
    if (desc.includes("message to delete not found")) {
      toastText = "ข้อความถูกลบไปแล้วก่อนหน้านี้ (ลบจาก DB แล้ว)";
    } else if (desc.includes("message can't be deleted")) {
      toastText = "ไม่สามารถลบได้ — อาจเก่าเกิน 48 ชม.";
    } else if (desc.includes("upgraded to a supergroup")) {
      const migrateChatId = delResult.parameters?.migrate_to_chat_id;
      if (migrateChatId) {
        await env.DB.prepare(`UPDATE bot_messages SET chat_id = ? WHERE chat_id = ?`).bind(migrateChatId, targetChatId).run();
        await env.DB.prepare(`UPDATE messages SET chat_id = ? WHERE chat_id = ?`).bind(migrateChatId, targetChatId).run();
        toastText = "กลุ่มถูกอัพเกรดเป็น supergroup — อัพเดท DB แล้ว กรุณาลองใหม่";
      } else {
        await env.DB.prepare(`DELETE FROM bot_messages WHERE chat_id = ?`).bind(targetChatId).run();
        toastText = "กลุ่มถูกอัพเกรดเป็น supergroup — ลบข้อมูลเก่าจาก DB แล้ว";
      }
    } else {
      toastText = "ลบไม่สำเร็จ: " + desc;
    }
  }
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQuery.id,
      text: toastText,
      show_alert: true,
    }),
  });
  // Refresh รายการ
  await showGroupMessages(env, callbackQuery, targetChatId, 0);
}

async function executeDeleteAll(env, callbackQuery, targetChatId) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  // ดึงข้อความทั้งหมดของ Friday ในกลุ่มนี้
  const { results } = await env.DB
    .prepare(
      `SELECT message_id FROM bot_messages
       WHERE chat_id = ? AND created_at > datetime('now', '-48 hours')`
    )
    .bind(targetChatId)
    .all();

  if (!results.length) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQuery.id,
        text: "ไม่มีข้อความให้ลบค่ะนาย",
        show_alert: true,
      }),
    });
    return;
  }

  // อัพเดทสถานะ
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: `🗑 กำลังลบข้อความของ Friday ทั้งหมด ${results.length} ข้อความ...`,
      reply_markup: { inline_keyboard: [] },
    }),
  });

  let deleted = 0;
  let failed = 0;
  for (const row of results) {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: targetChatId, message_id: row.message_id }),
    });
    const result = await res.json();
    if (result.ok) {
      deleted++;
    } else {
      failed++;
    }
  }

  // ลบจาก DB
  await env.DB
    .prepare(`DELETE FROM bot_messages WHERE chat_id = ? AND created_at > datetime('now', '-48 hours')`)
    .bind(targetChatId)
    .run();

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: `🗑 ลบเสร็จแล้วค่ะนาย\n✅ ลบสำเร็จ: ${deleted}\n${failed > 0 ? `❌ ลบไม่ได้: ${failed} (อาจเก่าเกิน 48 ชม.)` : ""}`,
      reply_markup: { inline_keyboard: [[{ text: "⬅️ กลับ", callback_data: "del:b" }]] },
    }),
  });
}

async function executeDeleteAllGroups(env, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  // ดึงข้อความทั้งหมดของ Friday จากทุกกลุ่ม
  const { results } = await env.DB
    .prepare(
      `SELECT chat_id, message_id FROM bot_messages
       WHERE created_at > datetime('now', '-48 hours')`
    )
    .all();

  if (!results.length) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQuery.id,
        text: "ไม่มีข้อความให้ลบค่ะนาย",
        show_alert: true,
      }),
    });
    return;
  }

  // อัพเดทสถานะ
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: `🗑 กำลังลบข้อความของ Friday ทั้งหมด ${results.length} ข้อความจากทุกกลุ่ม...`,
      reply_markup: { inline_keyboard: [] },
    }),
  });

  let deleted = 0;
  let failed = 0;
  for (const row of results) {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: row.chat_id, message_id: row.message_id }),
    });
    const result = await res.json();
    if (result.ok) {
      deleted++;
    } else {
      failed++;
    }
  }

  // ลบจาก DB
  await env.DB
    .prepare(`DELETE FROM bot_messages WHERE created_at > datetime('now', '-48 hours')`)
    .run();

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: `🗑 ลบเสร็จแล้วค่ะนาย\n✅ ลบสำเร็จ: ${deleted}\n${failed > 0 ? `❌ ลบไม่ได้: ${failed} (อาจเก่าเกิน 48 ชม.)` : ""}`,
      reply_markup: { inline_keyboard: [] },
    }),
  });
}

async function handleDashboardCommand(env, message) {
  const dashUrl = env.DASHBOARD_URL || "https://friday-dashboard-3rf.pages.dev";
  await sendTelegramWithKeyboard(env, message.chat.id, "📊 Friday Dashboard", null, [
    [{ text: "Open Dashboard", web_app: { url: dashUrl } }],
  ]);
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
      await sendTelegram(env, message.chat.id, "ไม่มีงานค้างค่ะนาย", message.message_id);
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
    const input = args.trim();
    if (!input) {
      await sendTelegram(env, message.chat.id, "Usage: /resolve <id> หรือ /resolve 1 2 3 หรือ /resolve all", message.message_id);
      return;
    }

    // /resolve all — ปิดทั้งหมด
    if (input.toLowerCase() === "all") {
      const result = await env.DB
        .prepare(`UPDATE commitments SET status = 'resolved', resolved_at = datetime('now') WHERE status = 'pending'`)
        .run();
      await sendTelegram(env, message.chat.id, `✅ ปิดงานค้างทั้งหมด ${result.meta.changes} รายการแล้วค่ะนาย`, message.message_id);
      return;
    }

    // /resolve 1 2 3 หรือ /resolve 1,2,3 — รับหลาย ID
    const ids = input.split(/[\s,]+/).filter(id => id !== "" && !isNaN(id));
    if (ids.length === 0) {
      await sendTelegram(env, message.chat.id, "Usage: /resolve <id> หรือ /resolve 1 2 3 หรือ /resolve all", message.message_id);
      return;
    }

    for (const id of ids) {
      await env.DB
        .prepare(`UPDATE commitments SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?`)
        .bind(Number(id))
        .run();
    }

    if (ids.length === 1) {
      await sendTelegram(env, message.chat.id, `✅ งาน #${ids[0]} ปิดแล้วค่ะนาย`, message.message_id);
    } else {
      await sendTelegram(env, message.chat.id, `✅ ปิดงาน #${ids.join(", #")} แล้วค่ะนาย (${ids.length} รายการ)`, message.message_id);
    }
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
      .prepare(`SELECT id, content, category, priority, datetime(created_at, '+7 hours') as created_at FROM memories ORDER BY CASE priority WHEN 'hot' THEN 1 WHEN 'warm' THEN 2 WHEN 'cold' THEN 3 ELSE 4 END, created_at DESC LIMIT 30`)
      .all();

    if (results.length === 0) {
      await sendTelegram(env, message.chat.id, "ยังไม่มีความจำที่บันทึกไว้ค่ะนาย", message.message_id);
      return;
    }

    const tierEmoji = { hot: "🔴", warm: "🟡", cold: "🔵" };
    let reply = "ความจำถาวรของ Friday:\n\n";
    for (const m of results) {
      const emoji = tierEmoji[m.priority] || "⚪";
      reply += `#${m.id} ${emoji} ${m.priority} [${m.category}]\n${m.content}\nเมื่อ: ${m.created_at}\n\n`;
    }
    reply += "🔴 hot = ใช้ทุกครั้ง | 🟡 warm = ดึงเมื่อเกี่ยวข้อง | 🔵 cold = เก็บถาวร\n";
    reply += "/cooldown <id> ลดระดับ | /heatup <id> เพิ่มระดับ | /forget <id ...> ลบ";

    await sendTelegram(env, message.chat.id, reply, message.message_id);
  } catch (err) {
    console.error("handleMemoriesCommand error:", err);
  }
}

async function handleSummaryCommand(env, message, args) {
  try {
    const chatId = message.chat.id;
    const parts = args.trim().split(/\s+/);

    if (parts[0] === "backfill") {
      // /summary backfill — generate daily summaries for all missing dates (default last 7 days)
      // /summary backfill 2026-03-18 — from specific date
      const fromDate = parts[1] || null;
      const daysBack = fromDate ? null : 7;

      await sendTelegram(env, chatId, "⏳ กำลัง backfill daily summaries... รอสักครู่ค่ะนาย", message.message_id);

      // Find all group × date combos with messages but no daily summary
      let query, bindParams;
      if (fromDate) {
        query = `SELECT DISTINCT chat_id, chat_title, date(created_at, '+7 hours') as msg_date
                 FROM messages
                 WHERE chat_title IS NOT NULL AND date(created_at, '+7 hours') >= ?
                   AND date(created_at, '+7 hours') < date('now', '+7 hours')
                 ORDER BY msg_date ASC`;
        bindParams = [fromDate];
      } else {
        query = `SELECT DISTINCT chat_id, chat_title, date(created_at, '+7 hours') as msg_date
                 FROM messages
                 WHERE chat_title IS NOT NULL AND created_at >= datetime('now', '-' || ? || ' days')
                   AND date(created_at, '+7 hours') < date('now', '+7 hours')
                 ORDER BY msg_date ASC`;
        bindParams = [daysBack];
      }

      const { results: combos } = await env.DB.prepare(query).bind(...bindParams).all();

      let created = 0, skipped = 0, failed = 0;
      const processed = [];

      for (const combo of combos) {
        // Check if daily summary already exists
        const existing = await env.DB.prepare(
          `SELECT id FROM summaries WHERE chat_id = ? AND summary_type = 'daily' AND summary_date = ?`
        ).bind(combo.chat_id, combo.msg_date).first();

        if (existing) { skipped++; continue; }

        // Get messages for this group × date
        const { results: dayMessages } = await env.DB.prepare(
          `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at
           FROM messages WHERE chat_id = ? AND date(created_at, '+7 hours') = ?
           ORDER BY created_at ASC LIMIT 500`
        ).bind(combo.chat_id, combo.msg_date).all();

        if (dayMessages.length === 0) { skipped++; continue; }

        const conversationText = dayMessages
          .map(m => {
            const name = m.username ? `@${m.username}` : m.first_name || "Unknown";
            return `[${m.created_at}] ${name}: ${m.message_text}`;
          })
          .join("\n");

        const summary = await generateDailySummary(env, combo.chat_title || "Unknown", conversationText, combo.msg_date);

        if (summary) {
          await env.DB.prepare(
            `INSERT INTO summaries (chat_id, chat_title, week_start, week_end, summary_text, message_count, summary_type, summary_date)
             VALUES (?, ?, ?, ?, ?, ?, 'daily', ?)`
          ).bind(combo.chat_id, combo.chat_title, combo.msg_date, combo.msg_date, summary, dayMessages.length, combo.msg_date).run();
          created++;
          processed.push(`📅 ${combo.msg_date} | ${combo.chat_title} (${dayMessages.length} msg)`);
        } else {
          failed++;
        }
      }

      let reply = `✅ Backfill เสร็จแล้วค่ะนาย\n\n`;
      reply += `สร้างใหม่: ${created} | ข้าม (มีแล้ว): ${skipped} | ล้มเหลว: ${failed}\n\n`;
      if (processed.length > 0) {
        reply += processed.join("\n") + "\n\n";
      }
      reply += `ใช้ /summary ดูผลได้เลยค่ะ`;
      await sendTelegram(env, chatId, reply.trim(), message.message_id);
      return;
    }

    if (parts[0] === "search" && parts.length > 1) {
      // /summary search <keyword>
      const keyword = parts.slice(1).join(" ");
      const { results } = await env.DB.prepare(
        `SELECT chat_title, COALESCE(summary_date, week_end) as summary_date,
                COALESCE(summary_type, 'weekly') as summary_type, summary_text, message_count
         FROM summaries
         WHERE summary_text LIKE ?
         ORDER BY COALESCE(summary_date, week_end) DESC LIMIT 10`
      ).bind(`%${keyword}%`).all();

      if (results.length === 0) {
        await sendTelegram(env, chatId, `ไม่พบ summary ที่มีคำว่า "${keyword}" ค่ะนาย`, message.message_id);
        return;
      }

      let reply = `🔍 ค้นหา summary: "${keyword}" (${results.length} รายการ)\n\n`;
      for (const s of results) {
        const typeLabel = s.summary_type === "daily" ? "📅" : "📆";
        reply += `${typeLabel} ${s.summary_date} | ${s.chat_title} (${s.message_count} msg)\n`;
        reply += s.summary_text.substring(0, 300) + (s.summary_text.length > 300 ? "..." : "") + "\n\n";
      }
      await sendTelegram(env, chatId, reply.trim(), message.message_id);
    } else {
      // /summary หรือ /summary <N>
      const days = parseInt(parts[0]) || 7;
      const { results } = await env.DB.prepare(
        `SELECT chat_title, COALESCE(summary_date, week_end) as summary_date,
                COALESCE(summary_type, 'weekly') as summary_type, summary_text, message_count
         FROM summaries
         WHERE COALESCE(summary_date, week_end) >= date('now', '-' || ? || ' days')
         ORDER BY COALESCE(summary_date, week_end) DESC LIMIT 20`
      ).bind(days).all();

      if (results.length === 0) {
        await sendTelegram(env, chatId, `ไม่มี summary ใน ${days} วันที่ผ่านมาค่ะนาย`, message.message_id);
        return;
      }

      let reply = `📋 Summaries (${days} วันล่าสุด): ${results.length} รายการ\n\n`;
      for (const s of results) {
        const typeLabel = s.summary_type === "daily" ? "📅" : "📆";
        reply += `${typeLabel} ${s.summary_date} | ${s.chat_title} (${s.message_count} msg)\n`;
        reply += s.summary_text.substring(0, 300) + (s.summary_text.length > 300 ? "..." : "") + "\n\n";
      }
      reply += "💡 /summary <N> ดูย้อนหลัง N วัน\n/summary search <คำ> ค้นหา\n/summary backfill สร้าง summary ย้อนหลัง";
      await sendTelegram(env, chatId, reply.trim(), message.message_id);
    }
  } catch (err) {
    console.error("handleSummaryCommand error:", err);
    await sendTelegram(env, message.chat.id, "เกิดข้อผิดพลาดค่ะนาย ลองใหม่อีกครั้ง", message.message_id);
  }
}

async function handleCooldownCommand(env, message, args) {
  try {
    const id = args.trim();
    if (!id || isNaN(id)) {
      await sendTelegram(env, message.chat.id, "Usage: /cooldown <id> — ลด memory จาก hot → warm", message.message_id);
      return;
    }
    const { meta } = await env.DB
      .prepare(`UPDATE memories SET priority = 'warm' WHERE id = ?`)
      .bind(Number(id))
      .run();
    if (meta.changes > 0) {
      await sendTelegram(env, message.chat.id, `ปรับ memory #${id} เป็น warm แล้วค่ะนาย`, message.message_id);
    } else {
      await sendTelegram(env, message.chat.id, `ไม่พบ memory #${id} ค่ะนาย`, message.message_id);
    }
  } catch (err) {
    console.error("handleCooldownCommand error:", err);
  }
}

async function handleHeatupCommand(env, message, args) {
  try {
    const id = args.trim();
    if (!id || isNaN(id)) {
      await sendTelegram(env, message.chat.id, "Usage: /heatup <id> — ปรับ memory เป็น hot", message.message_id);
      return;
    }
    const { meta } = await env.DB
      .prepare(`UPDATE memories SET priority = 'hot' WHERE id = ?`)
      .bind(Number(id))
      .run();
    if (meta.changes > 0) {
      await sendTelegram(env, message.chat.id, `ปรับ memory #${id} เป็น hot แล้วค่ะนาย`, message.message_id);
    } else {
      await sendTelegram(env, message.chat.id, `ไม่พบ memory #${id} ค่ะนาย`, message.message_id);
    }
  } catch (err) {
    console.error("handleHeatupCommand error:", err);
  }
}

async function handleForgetCommand(env, message, args) {
  try {
    const ids = args.trim().split(/[\s,]+/).filter(s => s && !isNaN(s)).map(Number);
    if (ids.length === 0) {
      await sendTelegram(env, message.chat.id, "Usage: /forget <id> [id2 id3 ...]", message.message_id);
      return;
    }
    const placeholders = ids.map(() => "?").join(",");
    await env.DB
      .prepare(`DELETE FROM memories WHERE id IN (${placeholders})`)
      .bind(...ids)
      .run();
    const label = ids.map(id => `#${id}`).join(" ");
    await sendTelegram(env, message.chat.id, `ลบความจำ ${label} แล้วค่ะนาย`, message.message_id);
  } catch (err) {
    console.error("handleForgetCommand error:", err);
  }
}

// ===== Parse suggested replies from AI analysis =====

function parseSuggestions(text) {
  const strategies = [
    // Strategy 1: Original — quoted text with " or "
    /([1-4])\.\s+(.+?):\s*["\u201C]([\s\S]+?)["\u201D]/g,
    // Strategy 2: Bold HTML label — <b>label</b>: text
    /([1-4])\.\s+<b>(.+?)<\/b>:\s*([\s\S]+?)(?=\n[1-4]\.|$)/g,
    // Strategy 3: **bold** label — **label**: text
    /([1-4])\.\s+\*\*(.+?)\*\*:\s*([\s\S]+?)(?=\n[1-4]\.|$)/g,
    // Strategy 4: Simple colon — N. label: text (no quotes needed)
    /([1-4])\.\s+([^:\n]+?):\s+"?(.+?)"?\s*(?=\n[1-4]\.|$)/g,
  ];

  for (const regex of strategies) {
    const suggestions = [];
    let match;
    regex.lastIndex = 0;
    while ((match = regex.exec(text)) !== null) {
      suggestions.push({
        num: match[1],
        label: match[2].trim().replace(/\s*\(.*?\)\s*$/, ''),
        text: match[3].trim().replace(/^[""\u201C]+|[""\u201D]+$/g, '')
      });
    }
    if (suggestions.length >= 2) return suggestions;
  }
  return null;
}

// ===== Proactive Alert Callback Handler (pa:*) =====

async function handleProactiveAlertCallback(env, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  // Parse callback data: "pa:<mode>:<groupChatId>:<alertId>"
  const parts = callbackQuery.data.split(":");
  const mode = parts[1]; // s = short, d = detail, h = handled, x = dismissed
  const groupChatId = Number(parts[2]);
  const alertId = parts[3] ? Number(parts[3]) : 0;

  // Escape original text for HTML
  const originalText = (callbackQuery.message.text || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Helper: editMessageText
  const editPreview = async (html, keepButtons = false) => {
    const body = {
      chat_id: chatId,
      message_id: messageId,
      text: sanitizeHtml(html),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    };
    if (!keepButtons) body.reply_markup = { inline_keyboard: [] };
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error("pa editPreview failed:", await res.text());
    }
    return res.ok;
  };

  // Helper: update alert status in DB
  const updateAlertStatus = async (status, action) => {
    if (!alertId) return;
    try {
      await env.DB.prepare(
        `UPDATE alerts SET status = ?, boss_action = ? WHERE id = ?`
      ).bind(status, action, alertId).run();

      // Learning: adjust group priority_weight based on feedback
      if (status === 'handled' || status === 'analyzing') {
        await env.DB.prepare(
          `UPDATE group_registry SET priority_weight = MIN(3.0, priority_weight + 0.1) WHERE chat_id = ?`
        ).bind(groupChatId).run();
      } else if (status === 'dismissed') {
        await env.DB.prepare(
          `UPDATE group_registry SET priority_weight = MAX(0.2, priority_weight - 0.15) WHERE chat_id = ?`
        ).bind(groupChatId).run();
      }
    } catch (e) { console.error("Alert status update error:", e); }
  };

  // Handle "จัดการแล้ว" button
  if (mode === "h") {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQuery.id, text: "✅ จัดการแล้ว" }),
    });
    await updateAlertStatus("handled", "handled");
    await editPreview(`${originalText}\n\n✅ <b>จัดการแล้ว</b>`);
    return;
  }

  // Handle "ไม่สำคัญ" button
  if (mode === "x") {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQuery.id, text: "❌ ปัดทิ้ง" }),
    });
    await updateAlertStatus("dismissed", "dismissed");
    await editPreview(`${originalText}\n\n❌ <b>ไม่สำคัญ — ปัดทิ้งแล้ว</b>`);
    return;
  }

  const modeLabels = { s: "วิเคราะห์สั้น", d: "วิเคราะห์ละเอียด" };

  // Answer callback query (toast)
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQuery.id,
      text: "⏳ กำลังวิเคราะห์...",
    }),
  });

  // Update alert status to analyzing
  await updateAlertStatus("analyzing", modeLabels[mode]);

  // Update preview: กำลังวิเคราะห์ + ลบปุ่ม
  const editOk = await editPreview(`${originalText}\n\n⏳ <b>กำลัง${modeLabels[mode] || "วิเคราะห์"}...</b>`);
  if (!editOk) return;

  try {
    // Fetch recent messages จากกลุ่มนั้น
    const { results: recentMsgs } = await env.DB
      .prepare(
        `SELECT username, first_name, message_text, chat_title,
                datetime(created_at, '+7 hours') as created_at
         FROM messages
         WHERE chat_id = ? AND created_at > datetime('now', '-6 hours')
         ORDER BY created_at ASC LIMIT 200`
      )
      .bind(groupChatId)
      .all();

    if (recentMsgs.length === 0) {
      await editPreview(`${originalText}\n\n❌ <b>ไม่พบข้อความล่าสุดในกลุ่มนี้</b>`);
      return;
    }

    const groupTitle = recentMsgs[0].chat_title || "Unknown";
    let conversation = "";
    for (const msg of recentMsgs) {
      const name = msg.username ? `@${msg.username}` : msg.first_name || "Unknown";
      conversation += `[${msg.created_at}] ${name}: ${msg.message_text}\n`;
    }

    const alertText = callbackQuery.message.text || "";
    const depthInstruction = mode === "s"
      ? "วิเคราะห์สั้นกระชับ 3-5 ประโยค พร้อมแนะนำคำตอบ/แนวทางสั้นๆ ที่นายสามารถตอบกลับได้ทันที"
      : "วิเคราะห์ละเอียดครบทุกมิติ รวมถึงบริบท สาเหตุ ผลกระทบ ความเสี่ยง และแนะนำคำตอบ/แนวทางที่เหมาะสมให้นายพร้อมเหตุผล";

    const noIntro = "[คำสั่งสำคัญ: ห้ามขึ้นต้นด้วย 'รับทราบ' 'สรุปให้ดังนี้' หรือเกริ่นนำใดๆ — เริ่มเนื้อหาทันที]";
    const prompt = `${noIntro}
จาก Proactive Alert ที่แจ้งเตือนเรื่องนี้:
"${alertText}"

กลุ่ม: ${groupTitle}

${depthInstruction}

โครงสร้างคำตอบ:
1. วิเคราะห์สถานการณ์ — เกิดอะไรขึ้น ใครเกี่ยวข้อง
2. ประเมินความสำคัญ/ความเร่งด่วน
3. แนะนำคำตอบ — ข้อความที่นายสามารถตอบกลับในกลุ่มได้เลย (ให้ครบ 4 ตัวเลือกเสมอ โทนต่างกัน เช่น ทางการ/เป็นกันเอง/สั้นกระชับ/ถามกลับ)
4. แนวทางถัดไป — ควรทำอะไรต่อ

บทสนทนาล่าสุดในกลุ่ม:
${conversation}`;

    await sendTyping(env, chatId);
    const context = await getSmartContext(env.DB, groupChatId, false, "");
    const reply = await askGemini(env, prompt, context, null);
    const { cleanReply } = await parseAndExecuteActions(env, reply);
    if (cleanReply) {
      await sendTelegram(env, chatId, cleanReply, null, true);

      // Send copy buttons for suggested replies
      const suggestions = parseSuggestions(cleanReply);
      if (suggestions) {
        const numEmoji = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
        const buttons = suggestions.map((s, i) => [{
          text: `📋 ${numEmoji[i] || '▪️'} ${s.label}`,
          copy_text: { text: s.text.substring(0, 256) }
        }]);
        await sendTelegramWithKeyboard(env, chatId, '📋 กดเพื่อคัดลอกข้อความตอบกลับ:', null, buttons);
      }
    }
    await updateAlertStatus("handled", modeLabels[mode]);
    await editPreview(`${originalText}\n\n✅ <b>${modeLabels[mode] || "วิเคราะห์"}แล้ว</b>`);
  } catch (err) {
    console.error("handleProactiveAlertCallback error:", err.message, err.stack);
    await editPreview(`${originalText}\n\n❌ <b>เกิดข้อผิดพลาด</b> — ลองใหม่ภายหลังค่ะ`);
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

    let alert = "⏰ งานค้างเกิน 24 ชม. ค่ะ\n\n";
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

// ===== Proactive Insight Alert v2 — JSON output, dedup, urgency, per-group gathering =====

// Robust JSON parser: tries multiple strategies to extract JSON from AI response
function parseAlertJson(text) {
  const strategies = [
    // Strategy 1: Direct JSON parse
    (t) => JSON.parse(t),
    // Strategy 2: Extract ```json ... ``` block
    (t) => {
      const m = t.match(/```json\s*([\s\S]*?)```/);
      return m ? JSON.parse(m[1]) : null;
    },
    // Strategy 3: Find first { ... } block
    (t) => {
      const start = t.indexOf("{");
      const end = t.lastIndexOf("}");
      if (start === -1 || end === -1 || end <= start) return null;
      return JSON.parse(t.substring(start, end + 1));
    },
    // Strategy 4: Fallback — parse legacy ALERT|pipe|format
    (t) => {
      const lines = t.split("\n").filter(l => l.startsWith("ALERT|"));
      if (lines.length === 0) return null;
      return {
        alerts: lines.map(line => {
          const parts = line.split("|");
          if (parts.length < 5) return null;
          const categoryMap = { "💰": "money", "⚠️": "problem", "💡": "info", "📋": "decision", "👥": "mention" };
          return {
            chat_id: null,
            urgency: "medium",
            category: categoryMap[parts[1].trim()] || "info",
            who: parts[2].trim(),
            summary: parts[3].trim(),
            group_title: parts[4].trim(),
            topic_fingerprint: parts[3].trim().substring(0, 50),
          };
        }).filter(Boolean)
      };
    },
  ];

  for (const strategy of strategies) {
    try {
      const result = strategy(text);
      if (result?.alerts?.length > 0) return result;
    } catch (e) { /* try next strategy */ }
  }
  return null;
}

async function proactiveInsightAlert(env) {
  try {
    const bossId = env.BOSS_USER_ID;

    // Per-group message gathering: query groups from group_registry with priority_weight
    let groups;
    try {
      const { results: registeredGroups } = await env.DB
        .prepare(
          `SELECT chat_id, chat_title, priority_weight
           FROM group_registry
           WHERE is_active = 1 AND last_message_at > datetime('now', '-24 hours')
           ORDER BY priority_weight DESC`
        )
        .all();
      groups = registeredGroups;
    } catch (e) {
      // Fallback if group_registry doesn't exist yet (pre-migration)
      groups = null;
    }

    let messageContext = "";
    const chatIdMap = {}; // chat_id → title mapping

    if (groups && groups.length > 0) {
      // Per-group gathering with priority-based limits
      for (const group of groups) {
        const weight = group.priority_weight || 1.0;
        const limit = weight >= 2.0 ? 150 : weight >= 1.0 ? 80 : 30;
        const { results: msgs } = await env.DB
          .prepare(
            `SELECT username, first_name, message_text, chat_title, chat_id,
                    datetime(created_at, '+7 hours') as created_at
             FROM messages
             WHERE chat_id = ? AND created_at > datetime('now', '-4 hours')
             ORDER BY created_at ASC LIMIT ?`
          )
          .bind(group.chat_id, limit)
          .all();

        if (msgs.length === 0) continue;

        const title = msgs[0].chat_title || group.chat_title || "Unknown";
        chatIdMap[group.chat_id] = title;
        messageContext += `=== กลุ่ม: ${title} (chat_id: ${group.chat_id}) ===\n`;
        for (const msg of msgs) {
          const name = msg.username ? `@${msg.username}` : msg.first_name || "Unknown";
          messageContext += `[${msg.created_at}] ${name}: ${msg.message_text}\n`;
        }
        messageContext += "\n";
      }
    } else {
      // Fallback: flat query (pre-migration compatibility)
      const { results } = await env.DB
        .prepare(
          `SELECT username, first_name, message_text, chat_title, chat_id,
                  datetime(created_at, '+7 hours') as created_at
           FROM messages
           WHERE chat_title IS NOT NULL AND created_at > datetime('now', '-4 hours')
           ORDER BY created_at ASC LIMIT 300`
        )
        .all();

      if (results.length === 0) return;

      const byGroup = {};
      for (const msg of results) {
        if (!byGroup[msg.chat_id]) byGroup[msg.chat_id] = { title: msg.chat_title, msgs: [] };
        byGroup[msg.chat_id].msgs.push(msg);
      }

      for (const [cid, group] of Object.entries(byGroup)) {
        chatIdMap[cid] = group.title;
        messageContext += `=== กลุ่ม: ${group.title} (chat_id: ${cid}) ===\n`;
        for (const msg of group.msgs) {
          const name = msg.username ? `@${msg.username}` : msg.first_name || "Unknown";
          messageContext += `[${msg.created_at}] ${name}: ${msg.message_text}\n`;
        }
        messageContext += "\n";
      }
    }

    if (!messageContext) return;

    // ดึง memories เป็น context เสริม
    const { results: memories } = await env.DB
      .prepare(`SELECT content, category FROM memories WHERE priority = 'hot' ORDER BY created_at DESC LIMIT 30`)
      .all();

    if (memories.length > 0) {
      messageContext += "=== ความจำถาวร ===\n";
      messageContext += memories.map((m) => `(${m.category}) ${m.content}`).join("\n");
    }

    // ดึง recent alerts เพื่อป้องกัน dedup
    let recentAlertContext = "";
    try {
      const { results: recentAlerts } = await env.DB
        .prepare(
          `SELECT topic_fingerprint, summary, chat_title, created_at
           FROM alerts
           WHERE created_at > datetime('now', '-12 hours')
           ORDER BY created_at DESC LIMIT 20`
        )
        .all();
      if (recentAlerts.length > 0) {
        recentAlertContext = "\n\n=== ALERTS ที่แจ้งไปแล้ว (ห้ามแจ้งซ้ำ) ===\n";
        recentAlertContext += recentAlerts.map(a =>
          `- [${a.chat_title}] ${a.summary} (fingerprint: ${a.topic_fingerprint})`
        ).join("\n");
      }
    } catch (e) { /* alerts table may not exist yet */ }

    // ดึง boss feedback context
    let feedbackContext = "";
    try {
      const { results: groupStats } = await env.DB
        .prepare(
          `SELECT g.chat_title, g.priority_weight,
                  COUNT(CASE WHEN a.status IN ('analyzing','handled') THEN 1 END) as analyzed,
                  COUNT(CASE WHEN a.status = 'dismissed' THEN 1 END) as dismissed
           FROM group_registry g
           LEFT JOIN alerts a ON g.chat_id = a.chat_id AND a.created_at > datetime('now', '-7 days')
           WHERE g.is_active = 1
           GROUP BY g.chat_id
           HAVING analyzed + dismissed > 0
           ORDER BY g.priority_weight DESC`
        )
        .all();
      if (groupStats.length > 0) {
        feedbackContext = "\n\n=== Boss feedback pattern ===\n";
        feedbackContext += groupStats.map(s =>
          `${s.chat_title}: weight=${s.priority_weight}, วิเคราะห์=${s.analyzed}ครั้ง, ปัดทิ้ง=${s.dismissed}ครั้ง`
        ).join("\n");
      }
    } catch (e) { /* ignore */ }

    // ใช้ Gemini วิเคราะห์หาเรื่องสำคัญ — JSON output format
    const analysisPrompt = `คุณคือ Friday AI ผู้ช่วยส่วนตัว ทำหน้าที่เฝ้าดูบทสนทนาในกลุ่มต่างๆ ของนาย (บอส)

วิเคราะห์ข้อความล่าสุดด้านล่าง หาเรื่องสำคัญที่นายควรรู้

ประเภทและ urgency:
- 🔴 critical — ระบบล่ม, เงินหาย, เรื่องด่วนสุด (category: "problem" หรือ "money")
- 🟠 high — deadline, ลูกค้าร้องเรียน, ต้องตัดสินใจเร่ง (category: "decision" หรือ "problem")
- 🟡 medium — update สำคัญ, รอตัดสินใจ (category: "info" หรือ "decision")
- 🟢 low — FYI, ข้อมูลทั่วไปที่ควรรู้ (category: "info" หรือ "mention")

ถ้าไม่มีเรื่องสำคัญเลย ตอบแค่ NONE

ถ้ามี ตอบเป็น JSON เท่านั้น:
\`\`\`json
{
  "alerts": [
    {
      "chat_id": -100xxx,
      "urgency": "critical|high|medium|low",
      "category": "money|problem|decision|info|mention",
      "who": "username",
      "summary": "สรุปสั้นๆ",
      "topic_fingerprint": "คำสำคัญ 3-5 คำ เช่น server-down-db-replica"
    }
  ]
}
\`\`\`

กฎ:
- chat_id ต้องตรงกับที่ระบุใน header ของแต่ละกลุ่ม
- สรุปให้กระชับ ไม่เกิน 2 ประโยค
- เฉพาะเรื่องที่นายต้องรู้จริงๆ ไม่ใช่บทสนทนาทั่วไป
- ห้ามแต่งเรื่อง ต้องอ้างอิงจากข้อมูลจริง
- ชื่อคนให้ใช้ username หรือ first_name ตามที่ปรากฏ
- topic_fingerprint ต้องเป็น keyword ภาษาอังกฤษ ใช้ - คั่น
- ห้ามแจ้งเรื่องที่อยู่ในรายการ "ALERTS ที่แจ้งไปแล้ว"`;

    const model = "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: analysisPrompt }] },
        contents: [{ role: "user", parts: [{ text: messageContext + recentAlertContext + feedbackContext }] }],
        generationConfig: { maxOutputTokens: 2048 },
      }),
    });

    if (!response.ok) {
      console.error("Proactive insight Gemini error:", response.status);
      return;
    }

    const data = await response.json();
    const responseParts = data.candidates?.[0]?.content?.parts;
    if (!responseParts) return;

    // หา text part ที่ไม่ใช่ thought
    let replyText = null;
    for (let i = responseParts.length - 1; i >= 0; i--) {
      if (responseParts[i].text && !responseParts[i].thought) {
        replyText = responseParts[i].text;
        break;
      }
    }

    if (!replyText || replyText.trim() === "NONE") return;

    // Parse JSON response (with fallback strategies)
    const parsed = parseAlertJson(replyText);
    if (!parsed?.alerts?.length) return;

    // Urgency sorting: critical → high → medium → low
    const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    parsed.alerts.sort((a, b) => (urgencyOrder[a.urgency] ?? 3) - (urgencyOrder[b.urgency] ?? 3));

    const urgencyEmoji = { critical: "🔴", high: "🟠", medium: "🟡", low: "🟢" };
    const categoryEmoji = { money: "💰", problem: "⚠️", decision: "📋", info: "💡", mention: "👥" };
    const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    for (const alert of parsed.alerts) {
      // Resolve chat_id: use AI-provided or try to match group_title
      let groupChatId = alert.chat_id ? String(alert.chat_id) : null;
      let groupTitle = "";

      if (groupChatId && chatIdMap[groupChatId]) {
        groupTitle = chatIdMap[groupChatId];
      } else if (alert.group_title) {
        // Legacy fallback: try to match by title
        for (const [cid, title] of Object.entries(chatIdMap)) {
          if (title === alert.group_title) {
            groupChatId = cid;
            groupTitle = title;
            break;
          }
        }
      }

      if (!groupChatId) continue;
      if (!groupTitle) groupTitle = alert.group_title || "Unknown";

      // Dedup: check topic_fingerprint in last 12 hours
      if (alert.topic_fingerprint) {
        try {
          const { results: dupes } = await env.DB
            .prepare(
              `SELECT id FROM alerts
               WHERE topic_fingerprint = ? AND created_at > datetime('now', '-12 hours')
               LIMIT 1`
            )
            .bind(alert.topic_fingerprint)
            .all();
          if (dupes.length > 0) continue; // skip duplicate
        } catch (e) { /* alerts table may not exist yet */ }
      }

      // Store alert in DB
      let alertId = 0;
      const alertHash = `insight-${groupChatId}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      try {
        const insertResult = await env.DB
          .prepare(
            `INSERT INTO alerts (alert_hash, chat_id, chat_title, urgency, category, who, summary, topic_fingerprint, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')`
          )
          .bind(
            alertHash,
            Number(groupChatId),
            groupTitle,
            alert.urgency || "medium",
            alert.category || "info",
            alert.who || null,
            alert.summary,
            alert.topic_fingerprint || null,
          )
          .run();
        alertId = insertResult.meta?.last_row_id || 0;
      } catch (e) { console.error("Alert insert error:", e); }

      // Build alert message with urgency visual
      const uEmoji = urgencyEmoji[alert.urgency] || "🟡";
      const cEmoji = categoryEmoji[alert.category] || "💡";
      const urgencyLabel = alert.urgency === "critical" ? " <b>URGENT</b>" : "";
      const alertMsg = `${uEmoji}${urgencyLabel} Proactive Alert ${cEmoji}\n\n${cEmoji} ${esc(alert.who || "")}: ${esc(alert.summary)}\n\n📁 กลุ่ม: ${esc(groupTitle)}`;

      await sendTelegramWithKeyboard(env, bossId, alertMsg, null, [
        [
          { text: "📋 วิเคราะห์สั้น", callback_data: `pa:s:${groupChatId}:${alertId}` },
          { text: "📝 วิเคราะห์ละเอียด", callback_data: `pa:d:${groupChatId}:${alertId}` },
        ],
        [
          { text: "✅ จัดการแล้ว", callback_data: `pa:h:${groupChatId}:${alertId}` },
          { text: "❌ ไม่สำคัญ", callback_data: `pa:x:${groupChatId}:${alertId}` },
        ],
      ]);
    }

    // Expire old unhandled alerts (>24h)
    try {
      await env.DB.prepare(
        `UPDATE alerts SET status = 'expired' WHERE status = 'new' AND created_at < datetime('now', '-24 hours')`
      ).run();
    } catch (e) { /* ignore */ }

  } catch (err) {
    console.error("Proactive insight alert error:", err);
  }
}

// ===== Summarize & Cleanup (Cron ทุก 3 ชม.) =====

async function generateDailySummary(env, groupTitle, conversationText, dateStr) {
  const prompt = `สรุปบทสนทนาของกลุ่ม "${groupTitle}" วันที่ ${dateStr} อย่างละเอียด เน้น:
1. หัวข้อหลักที่คุยกัน — แต่ละหัวข้อสรุปประเด็นสำคัญ
2. การตัดสินใจสำคัญ — ใครตัดสินใจอะไร เหตุผล
3. งานที่มอบหมาย — ใคร ทำอะไร เมื่อไหร่ สถานะ
4. ตัวเลข/จำนวนเงินสำคัญ — ยอด ราคา จำนวน
5. ปัญหาหรือข้อกังวลที่ยังค้าง — อะไรยังไม่ได้แก้
6. ข้อมูลสำคัญอื่นๆ — ชื่อคน สถานที่ ลิงก์ รหัสอ้างอิง ที่อาจต้องใช้ภายหลัง

ถ้าไม่มีเรื่องสำคัญเลย ให้สรุปสั้นๆ 2-3 ประโยคว่าคุยเรื่องอะไร
ตอบเป็นภาษาไทย ละเอียดแต่กระชับ ไม่เกิน 1500 คำ`;

  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: prompt }] },
      contents: [{ role: "user", parts: [{ text: conversationText }] }],
      generationConfig: { maxOutputTokens: 4096 },
    }),
  });

  if (!response.ok) {
    console.error("Daily summary Gemini error:", response.status);
    return null;
  }

  const data = await response.json();
  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts) return null;

  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].text && !parts[i].thought) return parts[i].text;
  }
  return parts.find(p => p.text)?.text || null;
}

async function generateSummary(env, groupTitle, conversationText) {
  const prompt = `สรุปบทสนทนาของกลุ่ม "${groupTitle}" ให้กระชับที่สุด เน้น:
1. หัวข้อหลักที่คุยกัน
2. การตัดสินใจสำคัญ
3. งานที่มอบหมาย (ใคร ทำอะไร เมื่อไหร่)
4. ตัวเลข/จำนวนเงินสำคัญ
5. ปัญหาหรือข้อกังวลที่ยังค้าง

ถ้าไม่มีเรื่องสำคัญเลย ให้สรุปสั้นๆ 1-2 ประโยคว่าคุยเรื่องอะไร
ตอบเป็นภาษาไทย กระชับ ไม่เกิน 500 คำ`;

  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: prompt }] },
      contents: [{ role: "user", parts: [{ text: conversationText }] }],
      generationConfig: { maxOutputTokens: 2048 },
    }),
  });

  if (!response.ok) {
    console.error("Summary Gemini error:", response.status);
    return null;
  }

  const data = await response.json();
  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts) return null;

  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].text && !parts[i].thought) return parts[i].text;
  }
  return parts.find(p => p.text)?.text || null;
}

async function summarizeAndCleanup(env) {
  try {
    const bossId = env.BOSS_USER_ID;
    let totalDeletedMessages = 0;
    let totalSummaries = 0;
    let totalDailySummaries = 0;

    // === Daily summaries: สร้าง daily summary สำหรับข้อความเก่ากว่า 24 ชม. ===
    const { results: dailyGroups } = await env.DB
      .prepare(
        `SELECT DISTINCT chat_id, chat_title, date(created_at, '+7 hours') as msg_date
         FROM messages
         WHERE created_at < datetime('now', '-24 hours') AND chat_title IS NOT NULL
         AND date(created_at, '+7 hours') NOT IN (
           SELECT summary_date FROM summaries WHERE chat_id = messages.chat_id AND summary_type = 'daily' AND summary_date IS NOT NULL
         )
         LIMIT 15`
      )
      .all();

    for (const dg of dailyGroups) {
      // เช็คซ้ำอีกครั้ง (idempotency)
      const dup = await env.DB.prepare(
        `SELECT id FROM summaries WHERE chat_id = ? AND summary_type = 'daily' AND summary_date = ?`
      ).bind(dg.chat_id, dg.msg_date).first();
      if (dup) continue;

      const { results: dayMessages } = await env.DB
        .prepare(
          `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at
           FROM messages
           WHERE chat_id = ? AND date(created_at, '+7 hours') = ?
           ORDER BY created_at ASC LIMIT 500`
        )
        .bind(dg.chat_id, dg.msg_date)
        .all();

      if (dayMessages.length === 0) continue;

      const conversationText = dayMessages
        .map(m => {
          const name = m.username ? `@${m.username}` : m.first_name || "Unknown";
          return `[${m.created_at}] ${name}: ${m.message_text}`;
        })
        .join("\n");

      const summary = await generateDailySummary(env, dg.chat_title || "Unknown", conversationText, dg.msg_date);

      if (summary) {
        await env.DB
          .prepare(
            `INSERT INTO summaries (chat_id, chat_title, week_start, week_end, summary_text, message_count, summary_type, summary_date)
             VALUES (?, ?, ?, ?, ?, ?, 'daily', ?)`
          )
          .bind(dg.chat_id, dg.chat_title, dg.msg_date, dg.msg_date, summary, dayMessages.length, dg.msg_date)
          .run();
        totalDailySummaries++;
      }
    }

    // === Weekly summaries + message cleanup (เก่ากว่า 30 วัน) ===

    // 1. หากลุ่มที่มีข้อความเก่ากว่า 30 วัน (LIMIT 10 กลุ่มต่อ cron run)
    const { results: groups } = await env.DB
      .prepare(
        `SELECT DISTINCT chat_id, chat_title FROM messages
         WHERE created_at < datetime('now', '-30 days') AND chat_title IS NOT NULL
         LIMIT 10`
      )
      .all();

    for (const group of groups) {
      // 2. ดึงข้อความเก่าของกลุ่มนี้ (LIMIT 500)
      const { results: oldMessages } = await env.DB
        .prepare(
          `SELECT username, first_name, message_text, datetime(created_at, '+7 hours') as created_at
           FROM messages
           WHERE chat_id = ? AND created_at < datetime('now', '-30 days')
           ORDER BY created_at ASC LIMIT 500`
        )
        .bind(group.chat_id)
        .all();

      if (oldMessages.length === 0) continue;

      // คำนวณ week range จากข้อความ
      const weekStart = oldMessages[0].created_at.substring(0, 10);
      const weekEnd = oldMessages[oldMessages.length - 1].created_at.substring(0, 10);

      // 3. เช็ค idempotency — ถ้า summary ซ้ำ skip
      const { results: existing } = await env.DB
        .prepare(
          `SELECT id FROM summaries
           WHERE chat_id = ? AND week_start = ? AND week_end = ?`
        )
        .bind(group.chat_id, weekStart, weekEnd)
        .all();

      if (existing.length > 0) {
        // summary มีอยู่แล้ว ข้ามไปลบข้อความเลย
      } else {
        // 4. ส่งให้ Gemini Flash สรุป
        const conversationText = oldMessages
          .map(m => {
            const name = m.username ? `@${m.username}` : m.first_name || "Unknown";
            return `[${m.created_at}] ${name}: ${m.message_text}`;
          })
          .join("\n");

        const summary = await generateSummary(env, group.chat_title || "Unknown", conversationText);

        if (summary) {
          await env.DB
            .prepare(
              `INSERT INTO summaries (chat_id, chat_title, week_start, week_end, summary_text, message_count, summary_type, summary_date)
               VALUES (?, ?, ?, ?, ?, ?, 'weekly', ?)`
            )
            .bind(group.chat_id, group.chat_title, weekStart, weekEnd, summary, oldMessages.length, weekEnd)
            .run();
          totalSummaries++;
        }
      }

      // 5. ลบข้อความเก่าหลังสรุปเสร็จ (batch 500 × 5 รอบต่อกลุ่ม)
      for (let round = 0; round < 5; round++) {
        const result = await env.DB
          .prepare(
            `DELETE FROM messages WHERE id IN (
               SELECT id FROM messages WHERE chat_id = ? AND created_at < datetime('now', '-30 days') LIMIT 500
             )`
          )
          .bind(group.chat_id)
          .run();
        const deleted = result.meta.changes;
        totalDeletedMessages += deleted;
        if (deleted < 500) break;
      }
    }

    // 6. ลบ resolved commitments เก่ากว่า 30 วัน
    const commitResult = await env.DB
      .prepare(
        `DELETE FROM commitments
         WHERE status = 'resolved' AND resolved_at < datetime('now', '-30 days')`
      )
      .run();

    // 7. นับ memories (เฉพาะ hot) → ถ้าเกิน 200 แจ้งเตือนบอส
    const { results: memCount } = await env.DB
      .prepare(`SELECT COUNT(*) as count FROM memories WHERE priority = 'hot'`)
      .all();

    if (memCount[0].count > 200) {
      await sendTelegram(
        env,
        bossId,
        `Friday Alert — hot memories มี ${memCount[0].count} รายการแล้ว (เกิน 200) อาจต้องจัดระเบียบค่ะนาย\nใช้ /memories ดูรายการ แล้ว /cooldown <id> ลดลำดับ หรือ /forget <id> ลบที่ไม่ใช้`,
        null
      );
    }

    // ลบ readlink cache เก่ากว่า 24 ชม.
    await env.DB.prepare(
      `DELETE FROM readlink_cache WHERE created_at < datetime('now', '-24 hours')`
    ).run();

    // ลบ file_cache เก่ากว่า 24 ชม.
    await env.DB.prepare(
      `DELETE FROM file_cache WHERE created_at < datetime('now', '-24 hours')`
    ).run();

    // ลบ bot_messages เก่ากว่า 48 ชม.
    await env.DB.prepare(
      `DELETE FROM bot_messages WHERE created_at < datetime('now', '-48 hours')`
    ).run();

    // ลบ summaries เก่ากว่า 365 วัน
    await env.DB.prepare(
      `DELETE FROM summaries WHERE created_at < datetime('now', '-365 days')`
    ).run();

    if (totalDeletedMessages > 0 || totalSummaries > 0 || totalDailySummaries > 0 || commitResult.meta.changes > 0) {
      console.log(
        `Cleanup done: ${totalDeletedMessages} msgs deleted, ${totalSummaries} weekly + ${totalDailySummaries} daily summaries, ${commitResult.meta.changes} commitments deleted`
      );
    }
  } catch (err) {
    console.error("Summarize & cleanup error:", err);
  }
}
