#!/usr/bin/env node
/**
 * The app's single entry point.
 *
 *   node dist/sync.js                 sync once, print a summary
 *   node dist/sync.js --xbar-output   sync once, print status in xbar's format
 *   node dist/sync.js --dry-run       show what would change; no Calendar API calls
 */
import { blackboardLoginScript, distScript, hasFlag } from './app.js';
import { BlackboardClient } from './blackboard/client.js';
import { GoogleCalendar } from './calendar/client.js';
import { ConfigError, loadConfig, systemTimeZone, type Config } from './config.js';
import { SyncError, errorMessage, type ErrorKind } from './errors.js';
import { addDays, type CalendarEvent } from './events.js';
import { acquireLock } from './lock.js';
import { logLine } from './log.js';
import { notify } from './notify.js';
import { ensureAppDir, paths } from './paths.js';
import { loadState, saveState } from './state.js';
import { loadStatus, saveStatus, shouldNotify, type Status } from './status.js';
import { runSync, type SyncResult } from './sync.engine.js';
import { renderXbar } from './xbar.js';

const args = process.argv.slice(2);
const xbar = hasFlag(args, '--xbar-output');
const dryRun = hasFlag(args, '--dry-run');
const verbose = hasFlag(args, '--verbose', '-v');

const say = (line: string): void => {
  if (!xbar) process.stdout.write(`${line}\n`);
};

function classify(err: unknown): ErrorKind {
  if (err instanceof SyncError) return err.kind;
  if (err instanceof ConfigError) return 'config';
  return 'other';
}

const NOTIFICATIONS: Partial<Record<ErrorKind, [string, string]>> = {
  blackboard_auth: ['Blackboard login expired', 'Calendar sync is paused. Run `npm run login` in blackboard-mcp to sign in again.'],
  google_auth: ['Google Calendar access lost', 'Calendar sync is paused. Run `npm run auth` in blackboard-calendar-sync.'],
};

const fmt = (timeZone: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone, ...opts });

/** "Sun, Sep 27" for a YYYY-MM-DD calendar date. */
function formatDate(date: string): string {
  return fmt('UTC', { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
}

/** "5:00 PM" for minutes after midnight. */
function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** When a due event's popup fires, in local time. */
function describePopup(event: CalendarEvent, timeZone: string): string {
  if (event.reminders.useDefault) return 'calendar default';
  const minutes = event.reminders.overrides[0]?.minutes ?? 0;
  if ('date' in event.start) {
    // All-day: counted back from local midnight at the start of the day.
    const days = Math.ceil(minutes / 1440);
    return `${formatDate(addDays(event.start.date, -days))}, ${formatClock(days * 1440 - minutes)}`;
  }
  const at = new Date(Date.parse(event.start.dateTime) - minutes * 60_000);
  return fmt(timeZone, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at);
}

function printDryRun(result: SyncResult, timeZone: string): void {
  const time = fmt(timeZone, { hour: 'numeric', minute: '2-digit' });
  const day = fmt(timeZone, { weekday: 'short', month: 'short', day: 'numeric' });
  const zone = fmt(timeZone, { timeZoneName: 'short' });
  say(`Dry run — nothing was sent to Google Calendar. Times are ${timeZone}.\n`);
  for (const o of result.outcomes) {
    const { due, reminder } = o.events;
    const course = [o.assignment.courseCode, o.assignment.courseName].filter(Boolean).join(' · ');
    let when: string;
    if ('date' in due.start) {
      when = `all-day ${formatDate(due.start.date)}`;
    } else {
      const start = new Date(due.start.dateTime);
      const end = new Date('dateTime' in due.end ? due.end.dateTime : due.start.dateTime);
      const tz = zone.formatToParts(end).find((p) => p.type === 'timeZoneName')?.value ?? '';
      when = `${day.format(start)}, ${time.format(start)} – ${time.format(end)} ${tz}`;
    }
    say(`[${o.action}] ${due.summary}`);
    if (course) say(`    class:          ${course}`);
    say(`    due event:      ${when} (popup ${describePopup(due, timeZone)})`);
    say(`    reminder event: all-day ${'date' in reminder.start ? formatDate(reminder.start.date) : ''} — "${reminder.summary}"`);
  }
  say(`\n${result.created} to create, ${result.updated} to update, ${result.unchanged} unchanged.`);
}

function successStatus(result: SyncResult, now: Date): Status {
  const status: Status = {
    lastRunAt: now.toISOString(),
    lastSuccessAt: now.toISOString(),
    counts: {
      tracked: result.outcomes.length,
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      failed: result.failed,
    },
    failures: result.outcomes
      .filter((o) => o.error)
      .map((o) => ({ title: o.events.due.summary, error: o.error ?? '' })),
    upcoming: result.outcomes.map((o) => ({
      title: o.events.due.summary,
      dueAt: o.assignment.dueAt,
      allDay: o.events.allDay,
    })),
  };
  if (result.calendarId) status.calendarId = result.calendarId;
  return status;
}

function errorStatus(previous: Status | undefined, kind: ErrorKind, message: string, now: Date): Status {
  const since = previous?.error?.kind === kind ? previous.error.since : now.toISOString();
  return {
    ...(previous ?? { failures: [], upcoming: [] }),
    lastRunAt: now.toISOString(),
    error: { kind, message, since },
  };
}

async function sync(config: Config): Promise<SyncResult> {
  const { state, warning } = loadState();
  if (warning) logLine(`WARN ${warning}`);
  const calendar = dryRun ? undefined : GoogleCalendar.fromStoredToken();
  const blackboard = await BlackboardClient.connect({
    serverPath: config.blackboardMcpPath,
    ...(config.nodePath ? { nodePath: config.nodePath } : {}),
    stderr: verbose ? 'inherit' : 'ignore',
  });
  try {
    return await runSync({
      config,
      blackboard,
      ...(calendar ? { calendar } : {}),
      state,
      log: (line) => {
        logLine(line);
        if (verbose) say(line);
      },
    });
  } finally {
    // Save even after a partial run so what did sync isn't re-sent.
    if (!dryRun) saveState(state);
    await blackboard.close();
  }
}

async function main(): Promise<number> {
  ensureAppDir();
  let config: Config | undefined;
  try {
    config = loadConfig();
  } catch {
    /* reported below, inside the normal error path */
  }
  const ctx = () => ({
    now: new Date(),
    timeZone: config?.timeZone ?? systemTimeZone(),
    logPath: paths.log,
    nodePath: process.execPath,
    authScript: distScript('auth.js'),
    ...(blackboardLoginScript(config) ? { blackboardLoginScript: blackboardLoginScript(config) } : {}),
  });

  const lock = acquireLock();
  if (!lock) {
    if (xbar) process.stdout.write(renderXbar(loadStatus(), { ...ctx(), inProgress: true }));
    else say('A sync is already in progress; skipping.');
    return 0;
  }

  const previous = loadStatus();
  const started = new Date();
  try {
    logLine(`Sync started${dryRun ? ' (dry run)' : ''}`);
    const result = await sync(config ?? loadConfig());
    for (const w of result.warnings) logLine(`NOTE ${w}`);
    logLine(`Sync finished: ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged, ${result.failed} failed`);
    if (dryRun) {
      printDryRun(result, (config ?? loadConfig()).timeZone);
      return 0;
    }
    const status = successStatus(result, new Date());
    saveStatus(status);
    if (xbar) process.stdout.write(renderXbar(status, ctx()));
    else {
      say(`Synced ${result.outcomes.length} assignment(s): ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged, ${result.failed} failed.`);
      for (const f of status.failures) say(`  failed: ${f.title}: ${f.error}`);
    }
    return result.failed > 0 ? 1 : 0;
  } catch (err) {
    const kind = classify(err);
    const message = errorMessage(err);
    logLine(`ERROR [${kind}] ${message}`);
    if (dryRun) {
      process.stderr.write(`Dry run failed [${kind}]: ${message}\n`);
      return 1;
    }
    const status = errorStatus(previous, kind, message, started);
    saveStatus(status);
    if (shouldNotify(previous, kind)) {
      const [title, body] = NOTIFICATIONS[kind] ?? ['Blackboard sync failed', message];
      await notify(title, body);
    }
    if (xbar) {
      process.stdout.write(renderXbar(status, ctx()));
      return 0;
    }
    process.stderr.write(`Sync failed [${kind}]: ${message}\n`);
    return 1;
  } finally {
    lock.release();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
