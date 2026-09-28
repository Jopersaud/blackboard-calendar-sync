import type { BlackboardSource } from './blackboard/client.js';
import type { CalendarTarget } from './calendar/client.js';
import type { Config } from './config.js';
import { SyncError, errorMessage } from './errors.js';
import { buildEvents, eventsHash, type AssignmentEvents } from './events.js';
import { normalizeUpcomingWork, type Assignment } from './normalize.js';
import type { State } from './state.js';

export type PlannedAction = 'create' | 'update' | 'unchanged';

export interface ItemOutcome {
  assignment: Assignment;
  events: AssignmentEvents;
  action: PlannedAction;
  error?: string;
}

export interface SyncResult {
  dryRun: boolean;
  calendarId?: string;
  outcomes: ItemOutcome[];
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  /** Things blackboard-mcp said it couldn't cover, plus our own soft warnings. */
  warnings: string[];
}

export interface SyncDeps {
  config: Config;
  blackboard: BlackboardSource;
  /** Omitted for a dry run: nothing is sent to Google. */
  calendar?: CalendarTarget;
  /** Mutated in place; the caller persists it (also after a partial run). */
  state: State;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * One sync pass: read upcoming work from Blackboard, build both events per
 * assignment, and write only what changed.
 *
 * Deliberately never deletes: an assignment missing from the upcoming list
 * may just have left the lookahead window (§6.7).
 */
export async function runSync(deps: SyncDeps): Promise<SyncResult> {
  const { config, blackboard, calendar, state } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const dryRun = !calendar;
  const warnings: string[] = [];

  const work = await blackboard.getUpcomingWork(config.lookaheadDays);
  warnings.push(...(work.limitations ?? []));
  // Course codes only make titles nicer; a failure here must not stop the sync.
  const courses = await blackboard.listCourses().catch((err: unknown) => {
    if (err instanceof SyncError && err.kind === 'blackboard_auth') throw err;
    warnings.push(`Could not load course codes (${errorMessage(err)}); titles use the assignment name only.`);
    return undefined;
  });
  const assignments = normalizeUpcomingWork(work, courses, { includeRecentlyOverdue: config.includeRecentlyOverdue });
  log(`Blackboard returned ${assignments.length} assignment(s) with due dates`);

  let calendarId: string | undefined;
  if (calendar) {
    calendarId = await calendar.ensureCalendar({
      calendarId: config.googleCalendarId ?? state.calendarId,
      name: config.calendarName,
      timeZone: config.timeZone,
    });
    if (state.calendarId && state.calendarId !== calendarId) {
      // Different calendar than last time: every event must be written there.
      log(`Calendar changed (${state.calendarId} → ${calendarId}); re-syncing all events`);
      state.assignments = {};
    }
    state.calendarId = calendarId;
  }

  const outcomes: ItemOutcome[] = [];
  const result: SyncResult = { dryRun, outcomes, created: 0, updated: 0, unchanged: 0, failed: 0, warnings };
  if (calendarId) result.calendarId = calendarId;

  for (const assignment of assignments) {
    const events = buildEvents(assignment, config);
    const hash = eventsHash(events);
    const previous = state.assignments[assignment.contentId];
    const action: PlannedAction = !previous ? 'create' : previous.lastSeenHash === hash ? 'unchanged' : 'update';
    const outcome: ItemOutcome = { assignment, events, action };
    outcomes.push(outcome);

    if (action === 'unchanged') {
      result.unchanged += 1;
      continue;
    }
    if (!calendar || !calendarId) {
      if (action === 'create') result.created += 1;
      else result.updated += 1;
      continue;
    }

    try {
      const dueResult = await calendar.upsertEvent(calendarId, events.due);
      const reminderResult = await calendar.upsertEvent(calendarId, events.reminder);
      // "created" only when both were new; a lost state file makes existing events read as updates.
      const effective = dueResult === 'created' && reminderResult === 'created' ? 'create' : 'update';
      outcome.action = effective;
      if (effective === 'create') result.created += 1;
      else result.updated += 1;
      state.assignments[assignment.contentId] = {
        contentId: assignment.contentId,
        courseId: assignment.courseId,
        title: assignment.title,
        ...(assignment.courseCode ? { courseCode: assignment.courseCode } : {}),
        dueAt: assignment.dueAt,
        allDay: events.allDay,
        dueEventId: events.due.id,
        reminderEventId: events.reminder.id,
        lastSyncedAt: now().toISOString(),
        lastSeenHash: hash,
      };
      log(`${effective === 'create' ? 'Created' : 'Updated'}: ${events.due.summary} (${assignment.dueAt})`);
    } catch (err) {
      // Revoked Google auth fails every item the same way: stop and surface it.
      if (err instanceof SyncError && err.kind === 'google_auth') throw err;
      result.failed += 1;
      outcome.error = errorMessage(err);
      log(`Failed: ${events.due.summary}: ${outcome.error}`);
    }
  }

  return result;
}
