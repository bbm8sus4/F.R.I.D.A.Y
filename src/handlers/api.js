import { validateTelegramWebApp } from "../lib/auth.js";

export async function handleApiRequest(request, url, env) {
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
        env.DB.prepare(`SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'`).first(),
        safeQuery(env.DB.prepare(`SELECT urgency, COUNT(*) as count FROM alerts WHERE created_at > datetime('now', '-7 days') GROUP BY urgency`).all()),
        env.DB.prepare(`SELECT COUNT(*) as count FROM memories`).first(),
        env.DB.prepare(`SELECT COUNT(*) as total, COUNT(DISTINCT chat_id) as chats FROM messages WHERE created_at > datetime('now', '-24 hours')`).first(),
        safeQuery(env.DB.prepare(`SELECT chat_id, chat_title, priority_weight, last_message_at, is_active FROM group_registry WHERE is_active = 1 ORDER BY priority_weight DESC`).all()),
      ]);

      return new Response(JSON.stringify({
        tasks: { pending: pending.count },
        alerts: Object.fromEntries((alertCounts?.results || []).map(r => [r.urgency, r.count])),
        memories: { total: memoryCount.count },
        messages: { last24h: msgStats.total, activeChats: msgStats.chats },
        groups: groups?.results || [],
      }), { headers });
    }

    // GET /api/tasks — list with filters
    if (path === "/tasks" && method === "GET") {
      const status = url.searchParams.get("status") || "pending";
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
      const offset = (page - 1) * limit;

      const countResult = await env.DB.prepare(
        `SELECT COUNT(*) as total FROM tasks WHERE status = ?`
      ).bind(status).first();
      const { results } = await env.DB.prepare(
        `SELECT id, description, status, result, due_on,
                datetime(created_at, '+7 hours') as created_at,
                datetime(completed_at, '+7 hours') as completed_at
         FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ).bind(status, limit, offset).all();

      return new Response(JSON.stringify({
        data: results, total: countResult.total, page, limit,
      }), { headers });
    }

    // PATCH /api/tasks/:id/done — mark task done
    const taskDoneMatch = path.match(/^\/tasks\/(\d+)\/done$/);
    if (taskDoneMatch && method === "PATCH") {
      const id = Number(taskDoneMatch[1]);
      await env.DB.prepare(
        `UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = ? AND status = 'pending'`
      ).bind(id).run();
      return new Response(JSON.stringify({ ok: true, id }), { headers });
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
