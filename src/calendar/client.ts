import { google, type calendar_v3 } from 'googleapis';
import { SyncError, errorMessage, httpStatus, isGoogleAuthError } from '../errors.js';
import type { CalendarEvent } from '../events.js';
import { authorizedClient } from './auth.js';

export type UpsertResult = 'created' | 'updated';

/** The subset of Google Calendar the sync engine needs (faked in tests). */
export interface CalendarTarget {
  /** Find the calendar by id or name, creating a dedicated one if needed; returns its id. */
  ensureCalendar(opts: { calendarId?: string; name: string; timeZone: string }): Promise<string>;
  /** Insert with the deterministic id; on conflict, update in place. */
  upsertEvent(calendarId: string, event: CalendarEvent): Promise<UpsertResult>;
}

/** Wrap googleapis errors so auth failures are recognizable upstream. */
function wrap(err: unknown, what: string): never {
  if (err instanceof SyncError) throw err;
  if (isGoogleAuthError(err)) {
    throw new SyncError('google_auth', `Google Calendar authorization failed (${errorMessage(err)}). Run npm run auth again.`, { cause: err });
  }
  throw new SyncError('other', `Google Calendar ${what} failed: ${errorMessage(err)}`, { cause: err });
}

export class GoogleCalendar implements CalendarTarget {
  constructor(private readonly api: calendar_v3.Calendar) {}

  static fromStoredToken(): GoogleCalendar {
    return new GoogleCalendar(google.calendar({ version: 'v3', auth: authorizedClient() }));
  }

  async ensureCalendar(opts: { calendarId?: string; name: string; timeZone: string }): Promise<string> {
    try {
      if (opts.calendarId) {
        try {
          const res = await this.api.calendarList.get({ calendarId: opts.calendarId });
          if (res.data.id) return res.data.id;
        } catch (err) {
          // A remembered calendar the user deleted: fall through and find/create by name.
          if (httpStatus(err) !== 404) throw err;
        }
      }
      let pageToken: string | undefined;
      do {
        const res = await this.api.calendarList.list({ pageToken, maxResults: 250, minAccessRole: 'writer' });
        const match = res.data.items?.find((c) => c.summary === opts.name && c.id);
        if (match?.id) return match.id;
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
      const created = await this.api.calendars.insert({
        requestBody: {
          summary: opts.name,
          description: 'Due dates auto-synced from Blackboard by blackboard-calendar-sync.',
          timeZone: opts.timeZone,
        },
      });
      if (!created.data.id) throw new Error('calendars.insert returned no id');
      return created.data.id;
    } catch (err) {
      wrap(err, 'calendar lookup');
    }
  }

  async upsertEvent(calendarId: string, event: CalendarEvent): Promise<UpsertResult> {
    try {
      await this.api.events.insert({ calendarId, requestBody: event });
      return 'created';
    } catch (err) {
      // 409: an event with this id already exists (possibly deleted by the
      // user — Google keeps the id reserved; status "confirmed" restores it).
      if (httpStatus(err) !== 409) wrap(err, `insert of "${event.summary}"`);
    }
    try {
      await this.api.events.update({ calendarId, eventId: event.id, requestBody: event });
      return 'updated';
    } catch (err) {
      wrap(err, `update of "${event.summary}"`);
    }
  }

  /** Only used by the test-event script's cleanup; normal syncs never delete (§6.7). */
  async deleteEvent(calendarId: string, eventId: string): Promise<boolean> {
    try {
      await this.api.events.delete({ calendarId, eventId });
      return true;
    } catch (err) {
      if (httpStatus(err) === 404 || httpStatus(err) === 410) return false;
      wrap(err, 'delete');
    }
  }
}
