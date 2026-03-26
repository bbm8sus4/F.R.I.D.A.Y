import { sendTelegram } from '../lib/telegram.js';
import { isCalendarConfigured, listEvents } from '../lib/google-calendar.js';

export async function calendarReminder(env) {
  try {
    if (!isCalendarConfigured(env)) return;

    const now = new Date();
    const threeHoursLater = new Date(now.getTime() + 3 * 60 * 60 * 1000);

    const events = await listEvents(env, now, threeHoursLater);
    if (events.length === 0) return;

    // Check which events already got reminders
    const dates = [...new Set(events.map(e => e.date))];
    const datePlaceholders = dates.map(() => '?').join(', ');
    const { results: existing } = await env.DB
      .prepare(
        `SELECT event_id, event_date FROM calendar_reminders WHERE event_date IN (${datePlaceholders})`
      )
      .bind(...dates)
      .all();

    const sentSet = new Set(existing.map(r => `${r.event_id}|${r.event_date}`));
    const newEvents = events.filter(e => !sentSet.has(`${e.id}|${e.date}`));

    if (newEvents.length === 0) return;

    // Format reminder message
    let msg = '🔔 <b>นัดหมายที่กำลังจะถึง:</b>\n';
    for (const e of newEvents) {
      const timeRange = e.endTime ? `${e.time}-${e.endTime}` : e.time;
      msg += `\n📅 ${timeRange} ${escapeHtml(e.title)}`;
      if (e.location) msg += `\n📍 ${escapeHtml(e.location)}`;
      if (e.meetLink) msg += `\n🔗 <a href="${escapeHtml(e.meetLink)}">Google Meet</a>`;
      if (e.phone) msg += `\n📞 ${escapeHtml(e.phone)}`;
      if (e.organizer) msg += `\n👤 ${escapeHtml(e.organizer)}`;
      if (e.attendees?.length) {
        const names = e.attendees.filter(a => !a.self).map(a => a.name);
        if (names.length) msg += `\n👥 ${escapeHtml(names.join(", "))}`;
      }
    }

    await sendTelegram(env, env.BOSS_USER_ID, msg, null, true);

    // Insert dedup records
    const stmt = env.DB.prepare(
      'INSERT OR IGNORE INTO calendar_reminders (event_id, event_date) VALUES (?, ?)'
    );
    await env.DB.batch(
      newEvents.map(e => stmt.bind(e.id, e.date))
    );

    // Cleanup old reminders (> 7 days)
    await env.DB.prepare(
      "DELETE FROM calendar_reminders WHERE reminded_at < datetime('now', '-7 days')"
    ).run();
  } catch (err) {
    console.error('Calendar reminder error:', err);
  }
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
