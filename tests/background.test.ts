import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SyncError } from '../src/errors.js';
import { activeLock } from '../src/lock.js';
import { waitForNetwork } from '../src/network.js';
import { paths } from '../src/paths.js';
import { errorStatus, shouldStartSync, type Status } from '../src/status.js';

const status = (over: Partial<Status> = {}): Status => ({
  lastRunAt: '2026-09-28T20:00:00Z',
  lastSuccessAt: '2026-09-28T20:00:00Z',
  failures: [],
  upcoming: [],
  ...over,
});

describe('shouldStartSync', () => {
  it('starts when nothing has run, or the last run is old enough', () => {
    expect(shouldStartSync(undefined, new Date())).toBe(true);
    expect(shouldStartSync(status(), new Date('2026-09-28T20:05:00Z'))).toBe(true);
  });

  it("doesn't loop on the refresh a finished sync triggers", () => {
    expect(shouldStartSync(status(), new Date('2026-09-28T20:00:30Z'))).toBe(false);
  });
});

describe('errorStatus', () => {
  const now = new Date('2026-09-28T21:00:00Z');

  it('records offline without hiding an existing login problem', () => {
    const expired = status({ error: { kind: 'blackboard_auth', message: 'expired', since: '2026-09-28T19:00:00Z' } });
    const next = errorStatus(expired, 'offline', 'No internet', now);
    expect(next.error?.kind).toBe('blackboard_auth');
    expect(next.lastRunAt).toBe(now.toISOString());
  });

  it('keeps the original "since" while the same error continues', () => {
    const first = errorStatus(status(), 'google_auth', 'revoked', now);
    const again = errorStatus(first, 'google_auth', 'revoked', new Date('2026-09-28T22:00:00Z'));
    expect(again.error?.since).toBe(now.toISOString());
    expect(again.lastSuccessAt).toBe('2026-09-28T20:00:00Z');
  });
});

describe('waitForNetwork', () => {
  it('retries until the host resolves', async () => {
    let calls = 0;
    await waitForNetwork({
      host: 'x',
      lookup: async () => {
        calls += 1;
        if (calls < 3) throw new Error('ENOTFOUND');
      },
      sleep: async () => undefined,
    });
    expect(calls).toBe(3);
  });

  it('gives up with an offline error', async () => {
    let t = 0;
    await expect(
      waitForNetwork({
        host: 'x',
        timeoutMs: 20_000,
        intervalMs: 5_000,
        lookup: async () => {
          throw new Error('ENOTFOUND');
        },
        sleep: async (ms) => {
          t += ms;
        },
        now: () => t,
      }),
    ).rejects.toMatchObject({ kind: 'offline' } satisfies Partial<SyncError>);
  });
});

describe('activeLock', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbcs-'));
    process.env.BBCS_HOME = dir;
  });
  afterEach(() => {
    delete process.env.BBCS_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports a live, recent holder only', () => {
    expect(activeLock()).toBeUndefined();
    fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    expect(activeLock()?.pid).toBe(process.pid);
    // Frozen by sleep for longer than the stale limit: no longer counts as running.
    fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 11 * 60_000).toISOString() }));
    expect(activeLock()).toBeUndefined();
  });
});

describe('sync.js --xbar-output (built CLI, fake Blackboard)', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const cli = path.join(root, 'dist', 'sync.js');
  const fake = path.join(root, 'tests', 'fixtures', 'fake-bb-server.mjs');
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbcs-e2e-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ blackboardMcpPath: fake, networkCheckHost: 'localhost' }));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (...args: string[]) =>
    new Promise<{ out: string; ms: number }>((resolve) => {
      const t0 = Date.now();
      const p = spawn(process.execPath, [cli, ...args], { env: { ...process.env, BBCS_HOME: dir } });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('close', () => resolve({ out, ms: Date.now() - t0 }));
    });

  it.skipIf(!fs.existsSync(cli))('prints immediately, syncs in the background, and does not loop', async () => {
    const first = await run('--xbar-output', '--plugin', 'blackboard-sync.30m.sh');
    expect(first.ms).toBeLessThan(3_000);
    expect(first.out.split('\n')[0]).toBe('🎓 syncing…');
    expect(first.out).toContain('Syncing… | color=gray');
    expect(first.out).toMatch(/Sync now \| bash=.* param2=--spawn param3=--plugin param4=blackboard-sync\.30m\.sh terminal=false refresh=true/);

    // The background run finishes on its own and records its result (no Google token here → auth error).
    const statusFile = path.join(dir, 'status.json');
    for (let i = 0; i < 100 && !fs.existsSync(statusFile); i += 1) await new Promise((r) => setTimeout(r, 100));
    const saved = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    expect(saved.error.kind).toBe('google_auth');
    for (let i = 0; i < 50 && fs.existsSync(path.join(dir, 'sync.lock')); i += 1) await new Promise((r) => setTimeout(r, 100));

    // The refresh right after must show the result without starting another sync.
    const second = await run('--xbar-output');
    expect(second.out.split('\n')[0]).toBe('⚠️ Google Calendar access needed | color=red');
    expect(second.out).not.toContain('Syncing…');
    const log = fs.readFileSync(path.join(dir, 'log.txt'), 'utf8');
    expect(log.match(/Sync started/g)).toHaveLength(1);
  }, 20_000);
});
