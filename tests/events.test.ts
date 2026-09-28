import { describe, expect, it } from 'vitest';
import {
  addDays,
  allDayReminderMinutes,
  buildEvents,
  dueEventId,
  eventIdFor,
  reminderEventId,
  timedReminderMinutes,
} from '../src/events.js';
import type { Assignment } from '../src/normalize.js';
import { testConfig } from './helpers.js';

const config = testConfig();
const base: Assignment = {
  contentId: '_26184_1:_3010_1',
  courseId: '_26184_1',
  courseName: 'Operating Systems',
  courseCode: 'CIS 473',
  title: 'HW 3',
  dueAt: '2026-10-01T03:59:00.000Z', // Wed Sep 30, 11:59 PM EDT
  pointsPossible: 50,
};

describe('event IDs', () => {
  it('are deterministic, Google-safe, and distinct per event kind', () => {
    const id = dueEventId(base.contentId);
    expect(id).toBe(dueEventId(base.contentId));
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(reminderEventId(base.contentId)).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(reminderEventId(base.contentId)).not.toBe(id);
    expect(dueEventId('_26184_1:_3011_1')).not.toBe(id);
  });

  it('encodes SHA-256 as 52 base32hex characters', () => {
    expect(eventIdFor('x')).toHaveLength(52);
  });
});

describe('addDays', () => {
  it('handles month, year and leap-day boundaries', () => {
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });
});

describe('buildEvents: 11:59 PM → all-day', () => {
  const ev = buildEvents(base, config);

  it('uses the local due date with an exclusive end date', () => {
    expect(ev.allDay).toBe(true);
    expect(ev.due.start).toEqual({ date: '2026-09-30' });
    expect(ev.due.end).toEqual({ date: '2026-10-01' });
  });

  it('treats 23:59:59 the same as 23:59', () => {
    const e = buildEvents({ ...base, dueAt: '2026-10-01T03:59:59.000Z' }, config);
    expect(e.allDay).toBe(true);
    expect(e.due.start).toEqual({ date: '2026-09-30' });
  });

  it('anchors the popup to 5 PM the day before by default', () => {
    expect(ev.due.reminders).toEqual({ useDefault: false, overrides: [{ method: 'popup', minutes: 420 }] });
  });

  it('titles the event with the course code', () => {
    expect(ev.due.summary).toBe('[CIS 473] HW 3');
    expect(ev.due.description).toContain('Course: Operating Systems');
    expect(ev.due.description).toContain('Points possible: 50');
    expect(ev.due.description).toContain('Auto-synced from Blackboard');
  });

  it('is judged in the configured zone, not UTC', () => {
    // The same instant is 8:59 PM in Los Angeles: a timed event there.
    const la = buildEvents(base, testConfig({ timeZone: 'America/Los_Angeles' }));
    expect(la.allDay).toBe(false);
  });
});

describe('buildEvents: other times → timed', () => {
  const ev = buildEvents({ ...base, dueAt: '2026-10-02T22:35:00.000Z' }, config); // 6:35 PM EDT

  it('ends at the deadline and starts the lead time before it', () => {
    expect(ev.allDay).toBe(false);
    expect(ev.due.start).toEqual({ dateTime: '2026-10-02T22:05:00Z', timeZone: 'America/New_York' });
    expect(ev.due.end).toEqual({ dateTime: '2026-10-02T22:35:00Z', timeZone: 'America/New_York' });
  });

  it('sets the popup so it lands 24h before the deadline (relative to start)', () => {
    expect(ev.due.reminders).toEqual({ useDefault: false, overrides: [{ method: 'popup', minutes: 1410 }] });
  });

  it('respects a custom lead time', () => {
    const e = buildEvents({ ...base, dueAt: '2026-10-02T22:35:00.000Z' }, testConfig({ dueEventLeadMinutes: 60 }));
    expect(e.due.start).toEqual({ dateTime: '2026-10-02T21:35:00Z', timeZone: 'America/New_York' });
  });

  it('treats midnight as timed on its own date', () => {
    const e = buildEvents({ ...base, dueAt: '2026-10-02T04:00:00.000Z' }, config); // 12:00 AM Oct 2
    expect(e.allDay).toBe(false);
    expect(e.dueDate).toBe('2026-10-02');
    expect(e.reminder.start).toEqual({ date: '2026-10-01' });
  });
});

describe('buildEvents: day-before reminder event', () => {
  it('is always all-day on the previous local day, ending (exclusively) on the due date', () => {
    const allDay = buildEvents(base, config);
    expect(allDay.reminder.start).toEqual({ date: '2026-09-29' });
    expect(allDay.reminder.end).toEqual({ date: '2026-09-30' });
    const timed = buildEvents({ ...base, dueAt: '2026-10-01T15:00:00.000Z' }, config); // Oct 1, 11 AM
    expect(timed.reminder.start).toEqual({ date: '2026-09-30' });
    expect(timed.reminder.end).toEqual({ date: '2026-10-01' });
  });

  it('crosses month boundaries (due Nov 2 → reminder Nov 1)', () => {
    const ev = buildEvents({ ...base, dueAt: '2026-11-03T04:59:00.000Z' }, config); // Nov 2 11:59 PM EST
    expect(ev.allDay).toBe(true);
    expect(ev.due.start).toEqual({ date: '2026-11-02' });
    expect(ev.due.end).toEqual({ date: '2026-11-03' });
    expect(ev.reminder.start).toEqual({ date: '2026-11-01' });
    expect(ev.reminder.end).toEqual({ date: '2026-11-02' });
  });

  it('is clearly titled and uses default reminders', () => {
    const ev = buildEvents(base, config);
    expect(ev.reminder.summary).toBe('Due tomorrow: [CIS 473] HW 3');
    expect(ev.reminder.reminders).toEqual({ useDefault: true });
    expect(ev.reminder.id).toBe(reminderEventId(base.contentId));
  });

  it('falls back to the bare title without a course code', () => {
    const { courseCode: _omit, ...noCode } = base;
    const ev = buildEvents(noCode, config);
    expect(ev.due.summary).toBe('HW 3');
    expect(ev.reminder.summary).toBe('Due tomorrow: HW 3');
  });
});

describe('reminder minute math', () => {
  it('all-day: whole days before, at the configured local time', () => {
    expect(allDayReminderMinutes(1440, '17:00')).toBe(420);
    expect(allDayReminderMinutes(1440, '09:30')).toBe(870);
    expect(allDayReminderMinutes(2880, '17:00')).toBe(1860);
    expect(allDayReminderMinutes(60, '17:00')).toBe(420);
    expect(allDayReminderMinutes(0, '17:00')).toBe(0);
  });

  it('timed: offset by the lead time, never negative', () => {
    expect(timedReminderMinutes(1440, 30)).toBe(1410);
    expect(timedReminderMinutes(10, 30)).toBe(0);
  });
});
