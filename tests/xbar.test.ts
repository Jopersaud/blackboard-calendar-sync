import { describe, expect, it } from 'vitest';
import type { Status } from '../src/status.js';
import { shouldNotify } from '../src/status.js';
import { pluginScript, relativeTime, renderXbar, sanitize, type XbarContext } from '../src/xbar.js';

const ctx: XbarContext = {
  now: new Date('2026-09-28T16:00:00Z'),
  timeZone: 'America/New_York',
  logPath: '/Users/me/.blackboard-calendar-sync/log.txt',
  nodePath: '/opt/homebrew/bin/node',
  authScript: '/Users/me/My Projects/bbcs/dist/auth.js',
  blackboardLoginScript: '/Users/me/blackboard-mcp/dist/cli/login.js',
};

const ok: Status = {
  lastRunAt: '2026-09-28T15:58:00Z',
  lastSuccessAt: '2026-09-28T15:58:00Z',
  counts: { tracked: 5, created: 0, updated: 1, unchanged: 4, failed: 0 },
  failures: [],
  upcoming: [
    { title: '[CIS 473] HW 3', dueAt: '2026-10-01T03:59:00Z', allDay: true },
    { title: '[CIS 473] Quiz | 2', dueAt: '2026-10-02T22:35:00Z', allDay: false },
    { title: 'Essay', dueAt: '2026-10-20T03:59:00Z', allDay: true },
    { title: 'Old', dueAt: '2026-09-27T03:59:00Z', allDay: true },
  ],
};

const split = (out: string) => {
  const lines = out.trimEnd().split('\n');
  const i = lines.indexOf('---');
  return { header: lines.slice(0, i), body: lines.slice(i + 1) };
};

describe('renderXbar', () => {
  it('shows the count due in the next 7 days in the menu bar', () => {
    const { header, body } = split(renderXbar(ok, ctx));
    expect(header).toEqual(['🎓 2 due']);
    expect(body).toContain('Last synced: 2 minutes ago');
    expect(body).toContain('5 assignments tracked, 1 updated this run');
    expect(body).toContain('Sync now | refresh=true');
    const withAction = split(renderXbar(ok, { ...ctx, syncScript: '/p/dist/sync.js', pluginName: 'blackboard-sync.3h.sh' })).body;
    expect(withAction).toContain(
      'Sync now | bash=/opt/homebrew/bin/node param1=/p/dist/sync.js param2=--spawn param3=--plugin param4=blackboard-sync.3h.sh terminal=false refresh=true',
    );
    expect(body).toContain('View log | bash=/usr/bin/open param1=/Users/me/.blackboard-calendar-sync/log.txt terminal=false');
  });

  it('lists future items only, and keeps titles from injecting xbar syntax', () => {
    const out = renderXbar(ok, ctx);
    expect(out).toContain('Wed, 9/30 · [CIS 473] HW 3 | href=');
    expect(out).toContain('Fri, 10/2 6:35 PM · [CIS 473] Quiz ¦ 2 | href=');
    expect(out).not.toContain('Old');
  });

  it('turns red with a fix-it action when the Blackboard session expired', () => {
    const status: Status = { ...ok, error: { kind: 'blackboard_auth', message: 'Blackboard session expired', since: '2026-09-28T15:00:00Z' } };
    const { header, body } = split(renderXbar(status, ctx));
    expect(header).toEqual(['⚠️ Blackboard login expired | color=red']);
    expect(body).toContain('Fix: run `npm run login` in blackboard-mcp');
    expect(body).toContain(
      'Sign in to Blackboard now… | bash=/opt/homebrew/bin/node param1=/Users/me/blackboard-mcp/dist/cli/login.js terminal=true refresh=true',
    );
    expect(body).toContain('Failing since 1 hour ago | color=gray');
  });

  it('quotes paths with spaces for the Google re-auth action', () => {
    const status: Status = { ...ok, error: { kind: 'google_auth', message: 'invalid_grant', since: ok.lastRunAt } };
    const { header, body } = split(renderXbar(status, ctx));
    expect(header[0]).toContain('color=red');
    expect(body).toContain('Authorize Google Calendar now… | bash=/opt/homebrew/bin/node param1="/Users/me/My Projects/bbcs/dist/auth.js" terminal=true refresh=true');
  });

  it('shows in-progress and never-synced states', () => {
    expect(split(renderXbar(undefined, { ...ctx, inProgress: true })).header).toEqual(['🎓 syncing…']);
    expect(renderXbar(ok, { ...ctx, inProgress: true })).toContain('Syncing… | color=gray');
    expect(split(renderXbar(undefined, ctx)).header).toEqual(['🎓 not synced yet']);
  });

  it('shows offline as a quiet note, keeping the normal count', () => {
    const status: Status = { ...ok, error: { kind: 'offline', message: 'No internet', since: ok.lastRunAt } };
    const { header, body } = split(renderXbar(status, ctx));
    expect(header).toEqual(['🎓 2 due']);
    expect(body).toContain("Offline — will sync when you're back online | color=gray");
    expect(body.join('\n')).not.toContain('color=red');
  });

  it('lists partial failures in a submenu', () => {
    const out = renderXbar({ ...ok, failures: [{ title: 'Quiz 2', error: 'quota' }] }, ctx);
    expect(out).toContain('1 item(s) failed to sync | color=orange');
    expect(out).toContain('--Quiz 2: quota | color=orange');
  });
});

describe('helpers', () => {
  it('sanitize strips newlines, pipes and leading dashes', () => {
    expect(sanitize('--a|b\nc')).toBe('a¦b c');
  });

  it('relativeTime', () => {
    const now = new Date('2026-09-28T16:00:00Z');
    expect(relativeTime(new Date('2026-09-28T15:59:30Z'), now)).toBe('just now');
    expect(relativeTime(new Date('2026-09-28T15:59:00Z'), now)).toBe('1 minute ago');
    expect(relativeTime(new Date('2026-09-26T16:00:00Z'), now)).toBe('2 days ago');
  });

  it('shouldNotify fires once per new auth failure', () => {
    const expired: Status = { ...ok, error: { kind: 'blackboard_auth', message: '', since: '' } };
    expect(shouldNotify(ok, 'blackboard_auth')).toBe(true);
    expect(shouldNotify(expired, 'blackboard_auth')).toBe(false);
    expect(shouldNotify(expired, 'google_auth')).toBe(true);
    expect(shouldNotify(undefined, 'other')).toBe(false);
  });

  it('pluginScript is a thin launcher with safely quoted paths', () => {
    const s = pluginScript({ projectDir: "/Users/me/it's here", nodePath: '/opt/homebrew/bin/node' });
    expect(s.startsWith('#!/bin/bash\n')).toBe(true);
    expect(s).toContain(`cd '/Users/me/it'\\''s here' && exec '/opt/homebrew/bin/node' dist/sync.js --xbar-output --plugin "$(basename "$0")"`);
  });
});
