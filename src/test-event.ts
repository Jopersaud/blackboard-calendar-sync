#!/usr/bin/env node
/**
 * Throwaway check of the Google Calendar plumbing and reminder behavior
 * (`npm run test-event`). Creates a fake assignment due two days from now
 * as both an 11:59 PM (all-day) and a 6:35 PM (timed) item, using the same
 * event builder as a real sync, so you can see where each popup lands.
 *
 *   npm run test-event              create/update the test events
 *   npm run test-event -- --cleanup delete them again
 */
import { hasFlag } from './app.js';
import { GoogleCalendar } from './calendar/client.js';
import { loadConfig } from './config.js';
import { errorMessage } from './errors.js';
import { addDays, buildEvents, localParts, ymd } from './events.js';
import type { Assignment } from './normalize.js';
import { loadState, saveState } from './state.js';

/** The UTC instant at which the wall clock in `timeZone` reads `date` `hh:mm`. */
function zonedInstant(date: string, hh: number, mm: number, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 3; i += 1) {
    const p = localParts(new Date(guess), timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += Date.UTC(y, m - 1, d, hh, mm) - shown;
  }
  return new Date(guess);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const calendar = GoogleCalendar.fromStoredToken();
  const { state } = loadState();
  const calendarId = await calendar.ensureCalendar({
    calendarId: config.googleCalendarId ?? state.calendarId,
    name: config.calendarName,
    timeZone: config.timeZone,
  });
  if (!config.googleCalendarId) {
    state.calendarId = calendarId;
    saveState(state);
  }

  const dueDate = addDays(ymd(localParts(new Date(), config.timeZone)), 2);
  const fakes: Assignment[] = [
    { contentId: 'bbcs-test:all-day', courseId: 'test', courseCode: 'TEST 101', title: 'Sync test (11:59 PM → all-day)', dueAt: zonedInstant(dueDate, 23, 59, config.timeZone).toISOString() },
    { contentId: 'bbcs-test:timed', courseId: 'test', courseCode: 'TEST 101', title: 'Sync test (6:35 PM → timed)', dueAt: zonedInstant(dueDate, 18, 35, config.timeZone).toISOString() },
  ];

  for (const fake of fakes) {
    const events = buildEvents({ ...fake, courseName: 'blackboard-calendar-sync self-test' }, config);
    for (const event of [events.due, events.reminder]) {
      if (hasFlag(process.argv, '--cleanup')) {
        const removed = await calendar.deleteEvent(calendarId, event.id);
        process.stdout.write(`${removed ? 'Deleted' : 'Not found'}: ${event.summary}\n`);
      } else {
        const result = await calendar.upsertEvent(calendarId, event);
        const popup = event.reminders.useDefault ? 'calendar default' : `${event.reminders.overrides[0]?.minutes} min before start`;
        process.stdout.write(`${result}: ${event.summary} (${JSON.stringify(event.start)}; popup: ${popup})\n`);
      }
    }
  }
  if (!hasFlag(process.argv, '--cleanup')) {
    process.stdout.write(
      `\nCheck the "${config.calendarName}" calendar around ${dueDate}: each due-date event's popup should land about ` +
        `${config.reminderMinutesBefore} minutes before its deadline (all-day: ${config.allDayReminderTime} the day before).\n` +
        'Run npm run test-event -- --cleanup when done.\n',
    );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`${errorMessage(err)}\n`);
    process.exit(1);
  },
);
