import type { Status } from './status.js';

/**
 * Render status in xbar's plugin format: lines before the first "---" show
 * in the menu bar, lines after it in the dropdown; "| key=value" modifiers
 * style lines or make them clickable. Pure, so it's unit-tested.
 */

export interface XbarContext {
  now: Date;
  timeZone: string;
  /** Another run holds the lock right now. */
  inProgress?: boolean;
  logPath: string;
  /** Node binary used for the clickable fix-it actions. */
  nodePath: string;
  /** blackboard-mcp's dist/cli/login.js, when known. */
  blackboardLoginScript?: string;
  /** This app's dist/auth.js. */
  authScript: string;
  /** How many days ahead the menu bar count covers. */
  countDays?: number;
}

const CALENDAR_URL = 'https://calendar.google.com/calendar/u/0/r';
const MAX_LISTED = 8;

/** Keep user-supplied text from being parsed as xbar syntax. */
export function sanitize(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/\|/g, '¦').replace(/^-+/, '').trim();
}

/** An xbar parameter value, quoted when it contains spaces. */
function param(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, "'")}"` : value;
}

export function relativeTime(then: Date, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}

function formatDue(dueAt: string, allDay: boolean, timeZone: string): string {
  const d = new Date(dueAt);
  const date = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'numeric', day: 'numeric' }).format(d);
  if (allDay) return date;
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(d);
  return `${date} ${time}`;
}

function runAction(ctx: XbarContext, script: string): string {
  return `bash=${param(ctx.nodePath)} param1=${param(script)} terminal=true refresh=true`;
}

export function renderXbar(status: Status | undefined, ctx: XbarContext): string {
  const header: string[] = [];
  const body: string[] = [];
  const countDays = ctx.countDays ?? 7;
  const horizon = ctx.now.getTime() + countDays * 86_400_000;
  const upcoming = (status?.upcoming ?? []).filter((u) => Date.parse(u.dueAt) >= ctx.now.getTime());
  const dueSoon = upcoming.filter((u) => Date.parse(u.dueAt) <= horizon).length;
  const error = status?.error;

  if (error?.kind === 'blackboard_auth') {
    header.push('⚠️ Blackboard login expired | color=red');
  } else if (error?.kind === 'google_auth') {
    header.push('⚠️ Google Calendar access needed | color=red');
  } else if (error?.kind === 'config') {
    header.push('⚠️ Calendar sync not set up | color=red');
  } else if (!status) {
    header.push(ctx.inProgress ? '🎓 syncing…' : '🎓 not synced yet');
  } else if (error) {
    header.push(`🎓 ${dueSoon} due ⚠️ | color=orange`);
  } else {
    header.push(`🎓 ${dueSoon} due`);
  }

  if (ctx.inProgress) body.push('Sync in progress… | color=gray');

  if (error) {
    body.push(`${sanitize(error.message).slice(0, 160)} | color=red`);
    if (error.kind === 'blackboard_auth') {
      body.push('Fix: run `npm run login` in blackboard-mcp');
      if (ctx.blackboardLoginScript) body.push(`Sign in to Blackboard now… | ${runAction(ctx, ctx.blackboardLoginScript)}`);
    } else if (error.kind === 'google_auth') {
      body.push('Fix: run `npm run auth` in blackboard-calendar-sync');
      body.push(`Authorize Google Calendar now… | ${runAction(ctx, ctx.authScript)}`);
    } else if (error.kind === 'config') {
      body.push('Fix: edit ~/.blackboard-calendar-sync/config.json (see README)');
    }
    body.push(`Failing since ${relativeTime(new Date(error.since), ctx.now)} | color=gray`);
  }

  if (status?.lastSuccessAt) {
    body.push(`Last synced: ${relativeTime(new Date(status.lastSuccessAt), ctx.now)}`);
  } else if (status) {
    body.push('Last synced: never');
  }
  if (status?.counts && !error) {
    const c = status.counts;
    const changes = [c.created && `${c.created} created`, c.updated && `${c.updated} updated`].filter(Boolean).join(', ');
    body.push(`${c.tracked} assignment${c.tracked === 1 ? '' : 's'} tracked${changes ? `, ${changes} this run` : ''}`);
  }
  if (status?.failures.length) {
    body.push(`${status.failures.length} item(s) failed to sync | color=orange`);
    for (const f of status.failures) body.push(`--${sanitize(f.title)}: ${sanitize(f.error).slice(0, 120)} | color=orange`);
  }

  if (upcoming.length) {
    body.push('---', 'Upcoming');
    const line = (u: (typeof upcoming)[number]) =>
      `${formatDue(u.dueAt, u.allDay, ctx.timeZone)} · ${sanitize(u.title)} | href=${CALENDAR_URL}`;
    for (const u of upcoming.slice(0, MAX_LISTED)) body.push(line(u));
    const rest = upcoming.slice(MAX_LISTED);
    if (rest.length) {
      body.push(`${rest.length} more…`);
      for (const u of rest) body.push(`--${line(u)}`);
    }
  }

  body.push(
    '---',
    'Sync now | refresh=true',
    `Open Google Calendar | href=${CALENDAR_URL}`,
    `View log | bash=/usr/bin/open param1=${param(ctx.logPath)} terminal=false`,
  );

  return `${[...header, '---', ...body].join('\n')}\n`;
}

/** The bash launcher xbar runs; a thin shim so all logic stays in the tested Node app. */
export function pluginScript(opts: { projectDir: string; nodePath: string }): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    '#!/bin/bash',
    '# blackboard-calendar-sync — xbar plugin shim. All logic lives in the Node app.',
    '# <xbar.title>Blackboard → Google Calendar sync</xbar.title>',
    '# <xbar.desc>Mirrors Blackboard due dates into Google Calendar.</xbar.desc>',
    '# <xbar.dependencies>node</xbar.dependencies>',
    'export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"',
    `cd ${q(opts.projectDir)} && exec ${q(opts.nodePath)} dist/sync.js --xbar-output`,
    '',
  ].join('\n');
}
