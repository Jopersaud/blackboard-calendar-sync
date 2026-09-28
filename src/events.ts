import crypto from 'node:crypto';
import type { Assignment } from './normalize.js';

/**
 * Pure event-building logic: all-day vs. timed, reminders, the day-before
 * event, and deterministic IDs. No network, no clock — easy to unit test.
 */

export interface EventSettings {
  timeZone: string;
  reminderMinutesBefore: number;
  /** "HH:MM" local time for the popup on an all-day due-date event. */
  allDayReminderTime: string;
  dueEventLeadMinutes: number;
}

/** The subset of a Google Calendar event resource we write. */
export interface CalendarEvent {
  id: string;
  summary: string;
  description: string;
  start: { date: string } | { dateTime: string; timeZone: string };
  end: { date: string } | { dateTime: string; timeZone: string };
  reminders: { useDefault: true } | { useDefault: false; overrides: { method: 'popup'; minutes: number }[] };
  /** Revives an event the user deleted: Google keeps deleted IDs reserved. */
  status: 'confirmed';
  transparency: 'transparent' | 'opaque';
  extendedProperties: { private: Record<string, string> };
}

export interface AssignmentEvents {
  allDay: boolean;
  /** Local due date, YYYY-MM-DD. */
  dueDate: string;
  due: CalendarEvent;
  reminder: CalendarEvent;
}

/** Google's max reminder override: 4 weeks. */
const MAX_REMINDER_MINUTES = 40320;

// ---------- deterministic IDs ----------

const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';

function base32hex(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32HEX[(value << (5 - bits)) & 31];
  return out;
}

/**
 * A Google Calendar event ID derived from a string: lowercase base32hex
 * (a–v, 0–9) of its SHA-256, 52 characters — within Google's 5–1024 limit.
 */
export function eventIdFor(key: string): string {
  return base32hex(crypto.createHash('sha256').update(key, 'utf8').digest());
}

export function dueEventId(contentId: string): string {
  return eventIdFor(`due:${contentId}`);
}

export function reminderEventId(contentId: string): string {
  return eventIdFor(`remind:${contentId}`);
}

// ---------- time zone helpers ----------

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function localParts(instant: Date, timeZone: string): LocalParts {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, fmt);
  }
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(fmt.formatToParts(instant).find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

export function ymd(p: { year: number; month: number; day: number }): string {
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** Calendar-date arithmetic on YYYY-MM-DD, independent of time zones and DST. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return ymd({ year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() });
}

/** An RFC 3339 timestamp in UTC without milliseconds (Google accepts either). */
function rfc3339(instant: Date): string {
  return instant.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------- event content ----------

/** 11:59 PM local (Blackboard often stores 23:59:59) means "due by end of day". */
export function isEndOfDay(p: LocalParts): boolean {
  return p.hour === 23 && p.minute === 59;
}

export function dueTitle(a: Assignment): string {
  return a.courseCode ? `[${a.courseCode}] ${a.title}` : a.title;
}

export function reminderTitle(a: Assignment): string {
  return `Due tomorrow: ${dueTitle(a)}`;
}

function formatDueTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(instant);
}

export function describe(a: Assignment, timeZone: string): string {
  const lines: string[] = [];
  if (a.courseName) lines.push(`Course: ${a.courseName}`);
  lines.push(`Due: ${formatDueTime(new Date(a.dueAt), timeZone)}`);
  if (a.pointsPossible !== undefined) lines.push(`Points possible: ${a.pointsPossible}`);
  lines.push('', 'Auto-synced from Blackboard by blackboard-calendar-sync. Edits here are overwritten on the next sync.');
  return lines.join('\n');
}

/**
 * Popup minutes for an all-day event. Google anchors all-day reminders to
 * local midnight at the event's start, so "1440 minutes" would fire at
 * midnight the night before. Instead fire at `atTime` on the day that is
 * ceil(minutesBefore / 1 day) days earlier: 1440 + 17:00 → 420 minutes
 * (5 PM the day before).
 */
export function allDayReminderMinutes(minutesBefore: number, atTime: string): number {
  if (minutesBefore <= 0) return 0;
  const [h, m] = atTime.split(':').map(Number) as [number, number];
  const days = Math.ceil(minutesBefore / 1440);
  return Math.min(MAX_REMINDER_MINUTES, Math.max(0, days * 1440 - (h * 60 + m)));
}

/**
 * Popup minutes for a timed event. Google counts from the event's start,
 * which is `leadMinutes` before the deadline, so subtract that to make the
 * popup land exactly `minutesBefore` ahead of the deadline itself.
 */
export function timedReminderMinutes(minutesBefore: number, leadMinutes: number): number {
  return Math.min(MAX_REMINDER_MINUTES, Math.max(0, minutesBefore - leadMinutes));
}

export function buildEvents(a: Assignment, s: EventSettings): AssignmentEvents {
  const due = new Date(a.dueAt);
  const local = localParts(due, s.timeZone);
  const dueDate = ymd(local);
  const allDay = isEndOfDay(local);
  const description = describe(a, s.timeZone);
  const privateProps = { source: 'blackboard-calendar-sync', contentId: a.contentId, courseId: a.courseId };

  const dueEvent: CalendarEvent = allDay
    ? {
        id: dueEventId(a.contentId),
        summary: dueTitle(a),
        description,
        // All-day end dates are exclusive: a one-day event ends the day after.
        start: { date: dueDate },
        end: { date: addDays(dueDate, 1) },
        reminders: {
          useDefault: false,
          overrides: [{ method: 'popup', minutes: allDayReminderMinutes(s.reminderMinutesBefore, s.allDayReminderTime) }],
        },
        status: 'confirmed',
        transparency: 'transparent',
        extendedProperties: { private: { ...privateProps, kind: 'due' } },
      }
    : {
        id: dueEventId(a.contentId),
        summary: dueTitle(a),
        description,
        // Ends at the deadline and starts leadMinutes before it.
        start: { dateTime: rfc3339(new Date(due.getTime() - s.dueEventLeadMinutes * 60_000)), timeZone: s.timeZone },
        end: { dateTime: rfc3339(due), timeZone: s.timeZone },
        reminders: {
          useDefault: false,
          overrides: [{ method: 'popup', minutes: timedReminderMinutes(s.reminderMinutesBefore, s.dueEventLeadMinutes) }],
        },
        status: 'confirmed',
        transparency: 'opaque',
        extendedProperties: { private: { ...privateProps, kind: 'due' } },
      };

  const reminderDate = addDays(dueDate, -1);
  const reminder: CalendarEvent = {
    id: reminderEventId(a.contentId),
    summary: reminderTitle(a),
    description,
    start: { date: reminderDate },
    end: { date: dueDate },
    // The event's presence on the calendar the day before is the reminder.
    reminders: { useDefault: true },
    status: 'confirmed',
    transparency: 'transparent',
    extendedProperties: { private: { ...privateProps, kind: 'reminder' } },
  };

  return { allDay, dueDate, due: dueEvent, reminder };
}

/** A stable fingerprint of what we'd write, for change detection. */
export function eventsHash(events: AssignmentEvents): string {
  return crypto.createHash('sha256').update(JSON.stringify([events.due, events.reminder])).digest('hex');
}
