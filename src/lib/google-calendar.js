// Google Calendar API client for Cloudflare Workers
// Token management + CRUD via REST API

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/**
 * Get a valid access token, using D1 cache or refreshing from Google.
 */
export async function getAccessToken(env) {
  // Check D1 cache first
  const cached = await env.DB.prepare(
    `SELECT access_token, expires_at FROM calendar_tokens WHERE id = 1`
  ).first();

  if (cached && new Date(cached.expires_at) > new Date(Date.now() + 60_000)) {
    return cached.access_token;
  }

  // Refresh token → new access token
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_CALENDAR_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Google token refresh failed:", res.status, err);
    throw new Error("Failed to refresh Google Calendar token");
  }

  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  // Upsert into D1 cache
  await env.DB.prepare(
    `INSERT INTO calendar_tokens (id, access_token, expires_at)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token, expires_at = excluded.expires_at`
  ).bind(data.access_token, expiresAt).run();

  return data.access_token;
}

/**
 * Check if Google Calendar is configured for this instance.
 */
export function isCalendarConfigured(env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CALENDAR_REFRESH_TOKEN);
}

/**
 * List events in a time range.
 * Returns: [{ id, title, date, time, endTime, description, location }]
 */
export async function listEvents(env, timeMin, timeMax, maxResults = 20) {
  const token = await getAccessToken(env);
  const calId = encodeURIComponent(env.GOOGLE_CALENDAR_ID || "primary");
  const params = new URLSearchParams({
    timeMin: timeMin instanceof Date ? timeMin.toISOString() : timeMin,
    timeMax: timeMax instanceof Date ? timeMax.toISOString() : timeMax,
    maxResults: String(maxResults),
    singleEvents: "true",
    orderBy: "startTime",
    timeZone: "Asia/Bangkok",
  });

  const res = await fetch(`${CALENDAR_API}/calendars/${calId}/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Calendar listEvents error:", res.status, err);
    throw new Error("Failed to list calendar events");
  }

  const data = await res.json();
  return (data.items || []).map(formatEvent);
}

/**
 * Get a single event by ID.
 */
export async function getEvent(env, eventId) {
  const token = await getAccessToken(env);
  const calId = encodeURIComponent(env.GOOGLE_CALENDAR_ID || "primary");

  const res = await fetch(`${CALENDAR_API}/calendars/${calId}/events/${encodeURIComponent(eventId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Calendar getEvent error:", res.status, err);
    throw new Error("Failed to get calendar event");
  }

  return formatEvent(await res.json());
}

/**
 * Create a new event.
 * @param {Object} opts - { title, date (YYYY-MM-DD), time (HH:MM), duration (minutes), description }
 * Returns the created event formatted.
 */
export async function createEvent(env, { title, date, time, duration = 60, description = "" }) {
  const token = await getAccessToken(env);
  const calId = encodeURIComponent(env.GOOGLE_CALENDAR_ID || "primary");

  const startDt = `${date}T${time}:00`;
  const endMs = new Date(`${startDt}+07:00`).getTime() + duration * 60_000;
  const endDt = new Date(endMs).toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" }).replace(" ", "T").slice(0, 16) + ":00";

  const body = {
    summary: title,
    start: { dateTime: `${startDt}+07:00`, timeZone: "Asia/Bangkok" },
    end: { dateTime: `${endDt}+07:00`, timeZone: "Asia/Bangkok" },
  };
  if (description) body.description = description;

  const res = await fetch(`${CALENDAR_API}/calendars/${calId}/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Calendar createEvent error:", res.status, err);
    throw new Error("Failed to create calendar event");
  }

  return formatEvent(await res.json());
}

/**
 * Update an existing event.
 * @param {string} eventId
 * @param {Object} updates - partial: { title, date, time, duration, description }
 */
export async function updateEvent(env, eventId, updates) {
  const token = await getAccessToken(env);
  const calId = encodeURIComponent(env.GOOGLE_CALENDAR_ID || "primary");

  const body = {};
  if (updates.title) body.summary = updates.title;
  if (updates.description) body.description = updates.description;
  if (updates.date && updates.time) {
    const duration = updates.duration || 60;
    const startDt = `${updates.date}T${updates.time}:00`;
    const endMs = new Date(`${startDt}+07:00`).getTime() + duration * 60_000;
    const endDt = new Date(endMs).toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" }).replace(" ", "T").slice(0, 16) + ":00";
    body.start = { dateTime: `${startDt}+07:00`, timeZone: "Asia/Bangkok" };
    body.end = { dateTime: `${endDt}+07:00`, timeZone: "Asia/Bangkok" };
  }

  const res = await fetch(`${CALENDAR_API}/calendars/${calId}/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Calendar updateEvent error:", res.status, err);
    throw new Error("Failed to update calendar event");
  }

  return formatEvent(await res.json());
}

/**
 * Delete an event by ID.
 */
export async function deleteEvent(env, eventId) {
  const token = await getAccessToken(env);
  const calId = encodeURIComponent(env.GOOGLE_CALENDAR_ID || "primary");

  const res = await fetch(`${CALENDAR_API}/calendars/${calId}/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok && res.status !== 410) {
    const err = await res.text();
    console.error("Calendar deleteEvent error:", res.status, err);
    throw new Error("Failed to delete calendar event");
  }

  return true;
}

// ===== Helpers =====

function formatEvent(event) {
  const start = event.start?.dateTime || event.start?.date;
  const end = event.end?.dateTime || event.end?.date;

  let date = "", time = "", endTime = "";
  if (start?.includes("T")) {
    // DateTime event
    const startBkk = toBangkokTime(start);
    const endBkk = toBangkokTime(end);
    date = startBkk.slice(0, 10);
    time = startBkk.slice(11, 16);
    endTime = endBkk.slice(11, 16);
  } else {
    // All-day event
    date = start;
    time = "ทั้งวัน";
    endTime = "";
  }

  return {
    id: event.id,
    title: event.summary || "(ไม่มีชื่อ)",
    date,
    time,
    endTime,
    description: event.description || "",
    location: event.location || "",
  };
}

function toBangkokTime(isoString) {
  const d = new Date(isoString);
  // Format as YYYY-MM-DDTHH:MM in Bangkok timezone
  return d.toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" }).replace(" ", "T");
}
