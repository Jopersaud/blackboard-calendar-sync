#!/usr/bin/env node
/**
 * The app's single entry point.
 *
 *   node dist/sync.js                 sync once, print a summary
 *   node dist/sync.js --dry-run       show what would change; no Calendar API calls
 *   node dist/sync.js --xbar-output   print menu bar status instantly (xbar calls this);
 *                                     starts a background sync when one is due
 *   node dist/sync.js --spawn         start a background sync now ("Sync now")
 *   node dist/sync.js --background    the background sync itself: silent, then refreshes xbar
 */
import { blackboardLoginScript, distScript, flagValue, hasFlag } from './app.js';
import { refreshXbar, startBackgroundSync } from './background.js';
import { BlackboardClient } from './blackboard/client.js';
import { GoogleCalendar } from './calendar/client.js';
import { ConfigError, loadConfig, systemTimeZone, type Config } from './config.js';
import { SyncError, errorMessage, type ErrorKind } from './errors.js';
import { addDays, type CalendarEvent } from './events.js';
import { acquireLock, activeLock } from './lock.js';
import { logLine } from './log.js';
import { notify } from './notify.js';
import { ensureAppDir, paths } from './paths.js';
import { loadState, saveState } from './state.js';
import { waitForNetwork } from './network.js';
import { errorStatus, loadStatus, saveStatus, shouldNotify, shouldStartSync, successStatus } from './status.js';
import { runSync, type SyncResult } from './sync.engine.js';
import { renderXbar } from './xbar.js';

const args = process.argv.slice(2);
const xbar = hasFlag(args, '--xbar-output');
const dryRun = hasFlag(args, '--dry-run');
const spawnOnly = hasFlag(args, '--spawn');
const background = hasFlag(args, '--background');
const verbose = hasFlag(args, '--verbose', '-v');
const pluginName = flagValue(args, '--plugin');

/** A background run, frozen by sleep and resumed, shows up as a gap this long between ticks. */
const WATCHDOG_TICK_MS = 10_000;
const SLEEP_GAP_MS = 60_000;
/** Hard cap on one background run, so a hang can never hold the lock for long. */
const MAX_RUN_MS = 6 * 60_000;

/** The live blackboard-mcp connection, so the watchdog can shut it down (and its Chrome) before exiting. */
let activeBlackboard: BlackboardClient | undefined;

/** Exit after closing blackboard-mcp; a bare process.exit() would orphan it. */
async function closeAndExit(code: number): Promise<never> {
  await activeBlackboard?.close();
  process.exit(code);
}

const say = (line: string): void => {
  if (!xbar && !background) process.stdout.write(`${line}\n`);
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

async function sync(config: Config): Promise<SyncResult> {
  const { state, warning } = loadState();
  if (warning) logLine(`WARN ${warning}`);
  const calendar = dryRun ? undefined : GoogleCalendar.fromStoredToken();
  // Right after wake the network may not be back yet; wait rather than hang.
  await waitForNetwork({ host: config.networkCheckHost });
  const blackboard = await BlackboardClient.connect({
    serverPath: config.blackboardMcpPath,
    ...(config.nodePath ? { nodePath: config.nodePath } : {}),
    stderr: verbose ? 'inherit' : 'ignore',
  });
  activeBlackboard = blackboard;
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
    activeBlackboard = undefined;
  }
}

/**
 * Watch a background run by the wall clock. Node's timers pause while the Mac
 * sleeps, so a long gap between ticks means this run was frozen mid-sync; its
 * Blackboard/Chrome connection is almost certainly dead by then.
 */
function startWatchdog(handlers: { onSleep: () => void; onTimeout: () => void }): () => void {
  const started = Date.now();
  let last = started;
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - last > SLEEP_GAP_MS) handlers.onSleep();
    else if (now - started > MAX_RUN_MS) handlers.onTimeout();
    last = now;
  }, WATCHDOG_TICK_MS);
  return () => clearInterval(timer);
}

async function main(): Promise<number> {
  ensureAppDir();
  let config: Config | undefined;
  try {
    config = loadConfig();
  } catch {
    /* reported below, inside the normal error path */
  }

  if (xbar) return showMenuBar(config);
  if (spawnOnly) {
    startBackgroundSync(pluginName ? { pluginName } : {});
    return 0;
  }
  return runOnce(config);
}

/**
 * What xbar calls. Prints the last saved results immediately — the menu bar
 * is never left blank waiting on Blackboard — and starts a background sync
 * when one is due and none is running.
 */
function showMenuBar(config: Config | undefined): number {
  const status = loadStatus();
  const now = new Date();
  let running = activeLock() !== undefined;
  if (!running && shouldStartSync(status, now)) {
    startBackgroundSync(pluginName ? { pluginName } : {});
    running = true;
  }
  process.stdout.write(
    renderXbar(status, {
      now,
      timeZone: config?.timeZone ?? systemTimeZone(),
      inProgress: running,
      logPath: paths.log,
      nodePath: process.execPath,
      authScript: distScript('auth.js'),
      syncScript: distScript('sync.js'),
      ...(pluginName ? { pluginName } : {}),
      ...(blackboardLoginScript(config) ? { blackboardLoginScript: blackboardLoginScript(config) } : {}),
    }),
  );
  return 0;
}

/** One sync, in the foreground (npm run sync / dry-run) or as the silent background run. */
async function runOnce(config: Config | undefined): Promise<number> {
  const lock = acquireLock();
  if (!lock) {
    say('A sync is already in progress; skipping.');
    return 0;
  }

  const previous = loadStatus();
  const started = new Date();
  const stopWatchdog = background
    ? startWatchdog({
        onSleep: () => {
          logLine('Sync was interrupted by sleep; starting a fresh one');
          lock.release();
          startBackgroundSync(pluginName ? { pluginName } : {});
          void closeAndExit(0);
        },
        onTimeout: () => {
          logLine(`ERROR [other] Sync timed out after ${MAX_RUN_MS / 60_000} minutes`);
          saveStatus(errorStatus(previous, 'other', 'Sync timed out; will retry at the next refresh.', new Date()));
          lock.release();
          void refreshXbar(pluginName).finally(() => closeAndExit(1));
        },
      })
    : () => undefined;

  try {
    logLine(`Sync started${dryRun ? ' (dry run)' : background ? ' (background)' : ''}`);
    const result = await sync(config ?? loadConfig());
    for (const w of result.warnings) logLine(`NOTE ${w}`);
    logLine(`Sync finished: ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged, ${result.failed} failed`);
    if (dryRun) {
      printDryRun(result, (config ?? loadConfig()).timeZone);
      return 0;
    }
    const status = successStatus(result, new Date());
    saveStatus(status);
    say(`Synced ${result.outcomes.length} assignment(s): ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged, ${result.failed} failed.`);
    for (const f of status.failures) say(`  failed: ${f.title}: ${f.error}`);
    return result.failed > 0 ? 1 : 0;
  } catch (err) {
    const kind = classify(err);
    const message = errorMessage(err);
    logLine(`ERROR [${kind}] ${message}`);
    if (dryRun) {
      process.stderr.write(`Dry run failed [${kind}]: ${message}\n`);
      return 1;
    }
    saveStatus(errorStatus(previous, kind, message, started));
    if (shouldNotify(previous, kind)) {
      const [title, body] = NOTIFICATIONS[kind] ?? ['Blackboard sync failed', message];
      await notify(title, body);
    }
    if (!background) process.stderr.write(`Sync failed [${kind}]: ${message}\n`);
    return 1;
  } finally {
    stopWatchdog();
    lock.release();
    // Show the new results right away instead of at the next interval.
    if (background && !dryRun) await refreshXbar(pluginName);
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
