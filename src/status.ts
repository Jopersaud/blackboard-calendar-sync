import { z } from 'zod';
import type { ErrorKind } from './errors.js';
import type { SyncResult } from './sync.engine.js';
import { paths, readJsonFile, writeFileAtomic } from './paths.js';

/**
 * What the last run did, persisted so the menu bar can still show something
 * useful while another run holds the lock, and so auth-failure notifications
 * fire once per new occurrence instead of every 30 minutes.
 */
export const StatusSchema = z.object({
  lastRunAt: z.string(),
  lastSuccessAt: z.string().optional(),
  error: z
    .object({
      kind: z.enum(['blackboard_auth', 'google_auth', 'config', 'offline', 'other']),
      message: z.string(),
      since: z.string(),
    })
    .optional(),
  counts: z
    .object({
      tracked: z.number(),
      created: z.number(),
      updated: z.number(),
      unchanged: z.number(),
      failed: z.number(),
    })
    .optional(),
  failures: z.array(z.object({ title: z.string(), error: z.string() })).default([]),
  upcoming: z.array(z.object({ title: z.string(), dueAt: z.string(), allDay: z.boolean() })).default([]),
  calendarId: z.string().optional(),
});

export type Status = z.infer<typeof StatusSchema>;

export function loadStatus(file = paths.status): Status | undefined {
  try {
    const parsed = StatusSchema.safeParse(readJsonFile(file));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function saveStatus(status: Status, file = paths.status): void {
  writeFileAtomic(file, `${JSON.stringify(status, null, 2)}\n`);
}

/** Notify only on entering an auth error state, not on every retry while in it. */
export function shouldNotify(previous: Status | undefined, kind: ErrorKind | undefined): boolean {
  if (kind !== 'blackboard_auth' && kind !== 'google_auth') return false;
  return previous?.error?.kind !== kind;
}

/**
 * Whether the menu bar should kick off a background sync. xbar re-runs the
 * plugin on its interval, on wake, and right after a sync finishes (to show
 * the new results); the minimum gap stops that last refresh from looping.
 */
export function shouldStartSync(status: Status | undefined, now: Date, minGapMs = 60_000): boolean {
  if (!status) return true;
  const last = Date.parse(status.lastRunAt);
  return Number.isNaN(last) || now.getTime() - last >= minGapMs;
}

export function successStatus(result: SyncResult, now: Date): Status {
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

export function errorStatus(previous: Status | undefined, kind: ErrorKind, message: string, now: Date): Status {
  const base: Status = { ...(previous ?? { failures: [], upcoming: [] }), lastRunAt: now.toISOString() };
  // Being offline is transient: don't let it hide a real problem (like an
  // expired login) that the user still needs to fix.
  if (kind === 'offline' && previous?.error && previous.error.kind !== 'offline') return base;
  const since = previous?.error?.kind === kind ? previous.error.since : now.toISOString();
  return { ...base, error: { kind, message, since } };
}
