// Calendar tools — create and list Google Calendar events via secretary

import { createEvent, listEvents, isCalendarConfigured } from '../../lib/google-calendar.js';

export const definitions = [
  {
    name: 'create_calendar_event',
    description: 'สร้างนัดหมายใน Google Calendar — ระบุชื่อ วันที่ เวลา ระยะเวลา',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING', description: 'ชื่อนัดหมาย (จำเป็น)' },
        date: { type: 'STRING', description: 'วันที่ YYYY-MM-DD (จำเป็น)' },
        time: { type: 'STRING', description: 'เวลา HH:MM เช่น 09:00, 17:30 (จำเป็น)' },
        duration: { type: 'INTEGER', description: 'ระยะเวลาเป็นนาที (default 60)' },
        description: { type: 'STRING', description: 'รายละเอียดเพิ่มเติม' },
      },
      required: ['title', 'date', 'time'],
    },
  },
  {
    name: 'list_calendar_events',
    description: 'ดูนัดหมายในปฏิทินตามช่วงวัน — ถ้าไม่ระบุ end_date จะดึง 7 วันข้างหน้าอัตโนมัติ',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING', description: 'วันเริ่ม YYYY-MM-DD' },
        end_date: { type: 'STRING', description: 'วันสิ้นสุด YYYY-MM-DD (default = start_date + 7 วัน)' },
      },
      required: ['start_date'],
    },
  },
];

export const executors = {
  async create_calendar_event(env, args) {
    if (!isCalendarConfigured(env)) {
      return { error: 'Google Calendar ยังไม่ได้ตั้งค่าค่ะ' };
    }
    const { title, date, time, duration, description } = args;
    const event = await createEvent(env, {
      title,
      date,
      time,
      duration: duration || 60,
      description: description || '',
    });
    return {
      success: true,
      event_id: event.id,
      title: event.title,
      date: event.date,
      time: event.time,
      endTime: event.endTime,
    };
  },

  async list_calendar_events(env, args) {
    if (!isCalendarConfigured(env)) {
      return { error: 'Google Calendar ยังไม่ได้ตั้งค่าค่ะ' };
    }
    const { start_date, end_date } = args;
    // Default: 7 วันข้างหน้า เพื่อให้ถามแบบกว้างๆ ได้ เช่น "มีนัดอะไรบ้าง"
    let endDate = end_date;
    if (!endDate) {
      const d = new Date(start_date + 'T00:00:00+07:00');
      d.setDate(d.getDate() + 7);
      endDate = d.toISOString().slice(0, 10);
    }
    const events = await listEvents(
      env,
      `${start_date}T00:00:00+07:00`,
      `${endDate}T23:59:59+07:00`,
      20
    );
    return {
      events: events.map(e => ({
        id: e.id,
        title: e.title,
        date: e.date,
        time: e.time,
        endTime: e.endTime,
        location: e.location || null,
        description: e.description ? e.description.slice(0, 100) : null,
      })),
      count: events.length,
    };
  },
};
