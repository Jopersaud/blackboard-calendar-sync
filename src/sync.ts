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

function printDryRun(result: SyncResult): void {
  say(`Dry run — nothing was sent to Google Calendar.\n`);
  for (const o of result.outcomes) {
    const { due, reminder } = o.events;
    const when = 'date' in due.start ? `all-day ${due.start.date}` : `${due.start.dateTime} → ${'dateTime' in due.end ? due.end.dateTime : ''}`;
    const popup = due.reminders.useDefault ? 'default' : `${due.reminders.overrides[0]?.minutes} min`;
    say(`[${o.action}] ${due.summary}`);
    say(`    due event:      ${when} (popup ${popup} before start)`);
    say(`    reminder event: all-day ${'date' in reminder.start ? reminder.start.date : ''} — "${reminder.summary}"`);
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
      printDryRun(result);
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
