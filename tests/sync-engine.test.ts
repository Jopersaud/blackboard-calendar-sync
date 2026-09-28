import { describe, expect, it } from 'vitest';
import type { BlackboardSource } from '../src/blackboard/client.js';
import type { UpcomingWork } from '../src/blackboard/schema.js';
import type { CalendarTarget, UpsertResult } from '../src/calendar/client.js';
import { SyncError } from '../src/errors.js';
import type { CalendarEvent } from '../src/events.js';
import { emptyState, type State } from '../src/state.js';
import { runSync } from '../src/sync.engine.js';
import { coursesFixture, testConfig, upcomingFixture } from './helpers.js';

class FakeBlackboard implements BlackboardSource {
  constructor(public work: UpcomingWork = upcomingFixture(), public coursesFail = false) {}
  async getUpcomingWork() {
    return structuredClone(this.work);
  }
  async listCourses() {
    if (this.coursesFail) throw new Error('boom');
    return coursesFixture();
  }
  async close() {}
}

/** Behaves like Google: inserting an existing id is a 409. */
class FakeCalendar implements CalendarTarget {
  events = new Map<string, CalendarEvent>();
  calls: string[] = [];
  failOn?: (e: CalendarEvent) => Error | undefined;
  calendarId = 'cal-1';

  async ensureCalendar() {
    return this.calendarId;
  }
  async upsertEvent(calendarId: string, event: CalendarEvent): Promise<UpsertResult> {
    const err = this.failOn?.(event);
    if (err) throw err;
    const key = `${calendarId}/${event.id}`;
    if (this.events.has(key)) {
      this.calls.push(`update ${event.summary}`);
      this.events.set(key, event);
      return 'updated';
    }
    this.calls.push(`insert ${event.summary}`);
    this.events.set(key, event);
    return 'created';
  }
}

const config = testConfig();
const now = () => new Date('2026-09-28T16:00:00Z');

async function sync(opts: { bb?: FakeBlackboard; cal?: FakeCalendar | null; state?: State } = {}) {
  const bb = opts.bb ?? new FakeBlackboard();
  const cal = opts.cal === null ? undefined : (opts.cal ?? new FakeCalendar());
  const state = opts.state ?? emptyState();
  const result = await runSync({ config, blackboard: bb, ...(cal ? { calendar: cal } : {}), state, now });
  return { result, bb, cal, state };
}

describe('runSync', () => {
  it('creates a due event and a reminder event per assignment on first run', async () => {
    const { result, cal, state } = await sync();
    expect(result.created).toBe(4);
    expect(cal!.events.size).toBe(8);
    expect(state.calendarId).toBe('cal-1');
    const rec = state.assignments['_26184_1:_3010_1']!;
    expect(rec).toMatchObject({ title: 'HW 3', allDay: true, courseCode: 'CIS 473', lastSyncedAt: '2026-09-28T16:00:00.000Z' });
    expect(cal!.events.has(`cal-1/${rec.dueEventId}`)).toBe(true);
    expect(cal!.events.has(`cal-1/${rec.reminderEventId}`)).toBe(true);
  });

  it('makes no API calls on an unchanged rerun', async () => {
    const first = await sync();
    first.cal!.calls = [];
    const { result } = await sync({ cal: first.cal!, state: first.state });
    expect(result.unchanged).toBe(4);
    expect(first.cal!.calls).toEqual([]);
  });

  it('updates both events in place when a due date moves', async () => {
    const first = await sync();
    first.cal!.calls = [];
    const bb = new FakeBlackboard();
    bb.work.items[0]!.due_date = '2026-10-03T03:59:00.000Z'; // HW 3 moves to Oct 2
    const { result, state } = await sync({ bb, cal: first.cal!, state: first.state });
    expect(result.updated).toBe(1);
    expect(first.cal!.calls).toEqual(['update [CIS 473] HW 3', 'update Due tomorrow: [CIS 473] HW 3']);
    const rec = state.assignments['_26184_1:_3010_1']!;
    expect(first.cal!.events.get(`cal-1/${rec.dueEventId}`)!.start).toEqual({ date: '2026-10-02' });
    expect(first.cal!.events.get(`cal-1/${rec.reminderEventId}`)!.start).toEqual({ date: '2026-10-01' });
    expect(first.cal!.events.size).toBe(8);
  });

  it('never duplicates when the state file is lost (insert conflict → update)', async () => {
    const first = await sync();
    const { result } = await sync({ cal: first.cal!, state: emptyState() });
    expect(result.created).toBe(0);
    expect(result.updated).toBe(4);
    expect(first.cal!.events.size).toBe(8);
  });

  it('does not delete events for assignments that disappear', async () => {
    const first = await sync();
    const bb = new FakeBlackboard();
    bb.work.items = [];
    bb.work.recently_overdue = [];
    const { state } = await sync({ bb, cal: first.cal!, state: first.state });
    expect(first.cal!.events.size).toBe(8);
    expect(Object.keys(state.assignments)).toHaveLength(4);
  });

  it('continues past a single failing item', async () => {
    const cal = new FakeCalendar();
    cal.failOn = (e) => (e.summary.includes('Quiz 2') ? new SyncError('other', 'quota') : undefined);
    const { result, state } = await sync({ cal });
    expect(result.failed).toBe(1);
    expect(result.created).toBe(3);
    expect(result.outcomes.find((o) => o.error)?.error).toBe('quota');
    expect(state.assignments['_26184_1:_3022_1']).toBeUndefined();
  });

  it('aborts the run on Google auth failure', async () => {
    const cal = new FakeCalendar();
    cal.failOn = () => new SyncError('google_auth', 'revoked');
    await expect(sync({ cal })).rejects.toMatchObject({ kind: 'google_auth' });
  });

  it('propagates a Blackboard session expiry', async () => {
    const bb = new FakeBlackboard();
    bb.getUpcomingWork = async () => {
      throw new SyncError('blackboard_auth', 'expired');
    };
    await expect(sync({ bb })).rejects.toMatchObject({ kind: 'blackboard_auth' });
  });

  it('still syncs when course codes cannot be loaded', async () => {
    const { result } = await sync({ bb: new FakeBlackboard(undefined, true) });
    expect(result.created).toBe(4);
    expect(result.outcomes[1]!.events.due.summary).toBe('HW 3');
    expect(result.warnings.some((w) => w.includes('course codes'))).toBe(true);
  });

  it('dry run plans without touching the calendar or state', async () => {
    const first = await sync();
    const bb = new FakeBlackboard();
    bb.work.items[1]!.title = 'Quiz 2 (rescheduled)';
    const before = structuredClone(first.state);
    const { result, state } = await sync({ bb, cal: null, state: first.state });
    expect(result.dryRun).toBe(true);
    expect(result.outcomes.map((o) => o.action)).toEqual(['unchanged', 'unchanged', 'update', 'unchanged']);
    expect(state).toEqual(before);
  });

  it('re-syncs everything when the target calendar changes', async () => {
    const first = await sync();
    const cal = new FakeCalendar();
    cal.calendarId = 'cal-2';
    const { result, state } = await sync({ cal, state: first.state });
    expect(result.created).toBe(4);
    expect(state.calendarId).toBe('cal-2');
  });
});
