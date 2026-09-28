import { z } from 'zod';
import { paths, readJsonFile } from './paths.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected "HH:MM" (24-hour)');

export const ConfigSchema = z.object({
  /** Path to blackboard-mcp's built server, e.g. "/Users/me/blackboard-mcp/dist/index.js". */
  blackboardMcpPath: z.string().min(1),
  /** Node binary used to run blackboard-mcp. Defaults to the one running this app. */
  nodePath: z.string().min(1).optional(),
  /**
   * Google Calendar to sync into. When omitted, a dedicated calendar named
   * `calendarName` is found or created on first run and remembered in state.
   */
  googleCalendarId: z.string().min(1).optional(),
  calendarName: z.string().min(1).default('Blackboard'),
  /** How far ahead to ask get_upcoming_work for (blackboard-mcp caps this at 90). */
  lookaheadDays: z.number().int().min(1).max(90).default(30),
  /** Popup reminder on the due-date event, in minutes before the deadline. */
  reminderMinutesBefore: z.number().int().min(0).max(40320).default(1440),
  /**
   * All-day events have no time, so Google anchors their reminders to local
   * midnight. The popup for an all-day due-date event fires at this local
   * time on the day that is `reminderMinutesBefore` rounded up to whole days
   * before the due date (default: 5 PM the day before).
   */
  allDayReminderTime: hhmm.default('17:00'),
  /** A timed due-date event ends at the deadline and starts this many minutes earlier. */
  dueEventLeadMinutes: z.number().int().min(1).max(24 * 60).default(30),
  /** IANA time zone for all date logic. Defaults to the system time zone. */
  timeZone: z.string().min(1).optional(),
  /** Also sync work due in the last few days that hasn't been handed in. */
  includeRecentlyOverdue: z.boolean().default(true),
});

export type Config = z.infer<typeof ConfigSchema> & { timeZone: string };

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid config (${paths.config}): ${issues}`);
  }
  const timeZone = result.data.timeZone ?? systemTimeZone();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new ConfigError(`Invalid config: timeZone "${timeZone}" is not a known IANA time zone`);
  }
  return { ...result.data, timeZone };
}

export function loadConfig(): Config {
  const raw = readJsonFile(paths.config);
  if (raw === undefined) {
    throw new ConfigError(
      `No config found at ${paths.config}. Create it with at least {"blackboardMcpPath": "/path/to/blackboard-mcp/dist/index.js"}.`,
    );
  }
  return parseConfig(raw);
}
