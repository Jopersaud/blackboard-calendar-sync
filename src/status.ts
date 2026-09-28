import { z } from 'zod';
import type { ErrorKind } from './errors.js';
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
      kind: z.enum(['blackboard_auth', 'google_auth', 'config', 'other']),
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
