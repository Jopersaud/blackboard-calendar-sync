import fs from 'node:fs';
import { z } from 'zod';
import { paths, readJsonFile, writeFileAtomic } from './paths.js';

export const StateRecordSchema = z.object({
  contentId: z.string(),
  courseId: z.string(),
  title: z.string(),
  courseCode: z.string().optional(),
  dueAt: z.string(),
  allDay: z.boolean(),
  dueEventId: z.string(),
  reminderEventId: z.string(),
  lastSyncedAt: z.string(),
  /** Fingerprint of the event bodies last written; unchanged → no API call. */
  lastSeenHash: z.string(),
});

export type StateRecord = z.infer<typeof StateRecordSchema>;

export const StateSchema = z.object({
  version: z.literal(1),
  /** The calendar the events were written to (found or created on first run). */
  calendarId: z.string().optional(),
  assignments: z.record(z.string(), StateRecordSchema),
});

export type State = z.infer<typeof StateSchema>;

export function emptyState(): State {
  return { version: 1, assignments: {} };
}

/**
 * Load the change-detection cache. A missing or corrupt file just means
 * "start fresh": deterministic event IDs make the next sync update the
 * existing events instead of duplicating them, so this is never fatal.
 */
export function loadState(file = paths.state): { state: State; warning?: string } {
  let raw: unknown;
  try {
    raw = readJsonFile(file);
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, backup);
    } catch {
      /* ignore */
    }
    return { state: emptyState(), warning: `State file was unreadable (${(err as Error).message}); moved to ${backup}` };
  }
  if (raw === undefined) return { state: emptyState() };
  const parsed = StateSchema.safeParse(raw);
  if (!parsed.success) return { state: emptyState(), warning: `State file had an unexpected shape; starting fresh` };
  return { state: parsed.data };
}

export function saveState(state: State, file = paths.state): void {
  writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
}
