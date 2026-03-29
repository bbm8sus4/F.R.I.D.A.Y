// Calendar tools — create, list, update, delete Google Calendar events via secretary

import { createEvent, listEvents, getEvent, updateEvent, deleteEvent, isCalendarConfigured } from '../../lib/google-calendar.js';

export const definitions = [
  {
    name: 'create_calendar_event',
    description: 'สร้างนัดหมายใน Google Calendar — ระบุชื่อ วันที่ เวลา ระยะเวลา สถานที่',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING', description: 'ชื่อนัดหมาย (จำเป็น)' },
        date: { type: 'STRING', description: 'วันที่ YYYY-MM-DD (จำเป็น)' },
        time: { type: 'STRING', description: 'เวลา HH:MM เช่น 09:00, 17:30 (จำเป็น)' },
        duration: { type: 'INTEGER', description: 'ระยะเวลาเป็นนาที (default 60)' },
        description: { type: 'STRING', description: 'รายละเอียดเพิ่มเติม' },
        location: { type: 'STRING', description: 'สถานที่ เช่น "ออฟฟิศ", "ร้านอาหารญี่ปุ่น"' },
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
  {
    name: 'update_calendar_event',
    description: 'แก้ไขนัดหมายที่มีอยู่ — เปลี่ยนชื่อ วันที่ เวลา ระยะเวลา สถานที่ ได้ (ดู event_id จาก context)',
    parameters: {
      type: 'OBJECT',
      properties: {
        event_id: { type: 'STRING', description: 'ID ของนัดหมาย (ดูจาก context [id:xxx])' },
        title: { type: 'STRING', description: 'ชื่อนัดหมายใหม่' },
        date: { type: 'STRING', description: 'วันที่ใหม่ YYYY-MM-DD' },
        time: { type: 'STRING', description: 'เวลาใหม่ HH:MM' },
        duration: { type: 'INTEGER', description: 'ระยะเวลาใหม่เป็นนาที' },
        description: { type: 'STRING', description: 'รายละเอียดใหม่' },
        location: { type: 'STRING', description: 'สถานที่ใหม่' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'delete_calendar_event',
    description: 'ลบนัดหมายออกจาก Google Calendar (ต้องยืนยันก่อนลบ) — ดู event_id จาก context',
    parameters: {
      type: 'OBJECT',
      properties: {
        event_id: { type: 'STRING', description: 'ID ของนัดหมายที่จะลบ (ดูจาก context [id:xxx])' },
      },
      required: ['event_id'],
    },
  },
];

export const executors = {
  async create_calendar_event(env, args) {
    if (!isCalendarConfigured(env)) {
      return { error: 'Google Calendar ยังไม่ได้ตั้งค่าค่ะ' };
    }
    const { title, date, time, duration, description, location } = args;
    const event = await createEvent(env, {
      title,
      date,
      time,
      duration: duration || 60,
      description: description || '',
      location: location || '',
    });
    return {
      success: true,
      event_id: event.id,
      title: event.title,
      date: event.date,
      time: event.time,
      endTime: event.endTime,
      location: event.location || null,
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

  async update_calendar_event(env, args) {
    if (!isCalendarConfigured(env)) {
      return { error: 'Google Calendar ยังไม่ได้ตั้งค่าค่ะ' };
    }
    const { event_id, title, date, time, duration, description, location } = args;

    // Smart merge: if time is given but date is not, fetch existing event to get its date
    const updates = {};
    if (title) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (location !== undefined) updates.location = location;

    if (time || date || duration) {
      let resolvedDate = date;
      let resolvedTime = time;
      let resolvedDuration = duration;

      // Need both date+time for datetime update — fetch existing if missing
      if ((time && !date) || (date && !time) || (duration && !time)) {
        const existing = await getEvent(env, event_id);
        if (!resolvedDate) resolvedDate = existing.date;
        if (!resolvedTime) resolvedTime = existing.time;
        if (!resolvedDuration && existing.endTime && existing.time) {
          // Calculate existing duration from time strings
          const [sh, sm] = existing.time.split(':').map(Number);
          const [eh, em] = existing.endTime.split(':').map(Number);
          resolvedDuration = (eh * 60 + em) - (sh * 60 + sm);
          if (resolvedDuration <= 0) resolvedDuration = 60;
        }
      }

      if (resolvedDate && resolvedTime) {
        updates.date = resolvedDate;
        updates.time = resolvedTime;
        if (resolvedDuration) updates.duration = resolvedDuration;
      }
    }

    try {
      const event = await updateEvent(env, event_id, updates);
      return {
        success: true,
        event_id: event.id,
        title: event.title,
        date: event.date,
        time: event.time,
        endTime: event.endTime,
        location: event.location || null,
      };
    } catch (e) {
      return { error: `แก้ไขนัดหมายไม่สำเร็จ: ${e.message}` };
    }
  },

  async delete_calendar_event(env, args) {
    if (!isCalendarConfigured(env)) {
      return { error: 'Google Calendar ยังไม่ได้ตั้งค่าค่ะ' };
    }
    const { event_id } = args;

    // Fetch event info before deleting (for result message)
    let eventTitle = '';
    try {
      const event = await getEvent(env, event_id);
      eventTitle = event.title;
    } catch {
      return { error: `ไม่พบนัดหมาย event_id="${event_id}" — อาจถูกลบไปแล้วหรือ ID ไม่ถูกต้องค่ะ` };
    }

    try {
      await deleteEvent(env, event_id);
    } catch (e) {
      return { error: `ลบนัดหมายไม่สำเร็จ: ${e.message}` };
    }
    return {
      success: true,
      event_id,
      title: eventTitle,
    };
  },
};
