import fs from 'node:fs';
import { ensureAppDir, paths } from './paths.js';

/**
 * A lock older than this is treated as stale even if its pid is alive: a run
 * frozen by sleep, or pid reuse. Longer than the sync watchdog's hard limit.
 */
export const STALE_AFTER_MS = 10 * 60_000;

export interface LockInfo {
  pid: number;
  startedAt: string;
}

export interface Lock {
  release(): void;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(file: string): LockInfo | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8')) as LockInfo;
    return typeof info.pid === 'number' ? info : undefined;
  } catch {
    return undefined;
  }
}

/** The holder of a live, recent lock, if any: i.e. a sync is running right now. */
export function activeLock(file = paths.lock, now = Date.now()): LockInfo | undefined {
  const holder = readLock(file);
  if (!holder || !isAlive(holder.pid)) return undefined;
  return now - Date.parse(holder.startedAt) < STALE_AFTER_MS ? holder : undefined;
}

/**
 * Take the sync lock, or return undefined when a live, recent run holds it.
 * xbar's timer and a manual "Refresh" can fire together; only one may sync.
 */
export function acquireLock(file = paths.lock, now = Date.now()): Lock | undefined {
  ensureAppDir();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString() } satisfies LockInfo));
      fs.closeSync(fd);
      return {
        release: () => {
          if (readLock(file)?.pid === process.pid) fs.rmSync(file, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = readLock(file);
      const age = holder ? now - Date.parse(holder.startedAt) : Infinity;
      if (holder && holder.pid !== process.pid && isAlive(holder.pid) && age < STALE_AFTER_MS) return undefined;
      fs.rmSync(file, { force: true });
    }
  }
  return undefined;
}
