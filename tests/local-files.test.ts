import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../src/lock.js';
import { paths } from '../src/paths.js';
import { emptyState, loadState, saveState } from '../src/state.js';
import { parseConfig } from '../src/config.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbcs-'));
  process.env.BBCS_HOME = dir;
});
afterEach(() => {
  delete process.env.BBCS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('lock', () => {
  it('lets only one holder in at a time', () => {
    const a = acquireLock();
    expect(a).toBeDefined();
    // Simulate another live process holding it.
    fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
    expect(acquireLock()).toBeUndefined();
  });

  it('takes over a lock whose process is gone', () => {
    fs.writeFileSync(paths.lock, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: new Date().toISOString() }));
    const lock = acquireLock();
    expect(lock).toBeDefined();
    lock!.release();
    expect(fs.existsSync(paths.lock)).toBe(false);
  });

  it('takes over a lock that is too old', () => {
    fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.ppid, startedAt: '2020-01-01T00:00:00Z' }));
    expect(acquireLock()).toBeDefined();
  });
});

describe('state', () => {
  it('round-trips with restrictive permissions', () => {
    const s = emptyState();
    s.calendarId = 'cal';
    saveState(s);
    expect(loadState().state).toEqual(s);
    expect(fs.statSync(paths.state).mode & 0o777).toBe(0o600);
  });

  it('recovers from a corrupt file', () => {
    fs.writeFileSync(paths.state, '{not json');
    const { state, warning } = loadState();
    expect(state).toEqual(emptyState());
    expect(warning).toMatch(/unreadable/);
    expect(fs.existsSync(paths.state)).toBe(false);
  });
});

describe('config', () => {
  it('applies defaults', () => {
    const c = parseConfig({ blackboardMcpPath: '/x/dist/index.js', timeZone: 'America/New_York' });
    expect(c).toMatchObject({ calendarName: 'Blackboard', lookaheadDays: 30, reminderMinutesBefore: 1440, dueEventLeadMinutes: 30, allDayReminderTime: '17:00' });
  });

  it('rejects bad values with a readable message', () => {
    expect(() => parseConfig({})).toThrow(/blackboardMcpPath/);
    expect(() => parseConfig({ blackboardMcpPath: 'x', lookaheadDays: 365 })).toThrow(/lookaheadDays/);
    expect(() => parseConfig({ blackboardMcpPath: 'x', timeZone: 'Mars/Olympus' })).toThrow(/time zone/);
  });
});
