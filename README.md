# blackboard-calendar-sync

Keeps your Blackboard due dates mirrored into Google Calendar, unattended, with a macOS
menu bar status item (via [xbar](https://xbarapp.com) or [SwiftBar](https://swiftbar.app)).

For each assignment it creates **two** events on a dedicated **"Blackboard"** calendar:

| Event | When |
|---|---|
| **`[CIS 473] HW 3`** (the due-date event) | Due at **11:59 PM** → an **all-day** event on the due date. Any other time → a **timed** event that *ends* at the deadline and starts 30 min before (e.g. 6:05–6:35 PM). Has a popup reminder 1 day before. |
| **`Due tomorrow: [CIS 473] HW 3`** | Always **all-day**, on the day before the due date. |

Reruns never duplicate: event IDs are derived from the Blackboard content ID, so a sync
updates the existing events in place (including when a due date moves). Nothing is ever
deleted automatically. Blackboard is only read, never written to.

## How it works

`blackboard-mcp` talks to Blackboard through your real browser session, but only when
something calls its tools. This app is an **MCP client**: it spawns
[`blackboard-mcp`](https://github.com/alanwtom/blackboard-mcp)'s `dist/index.js` over stdio,
calls `get_upcoming_work` (plus `list_courses` for course codes), and writes the results to
Google Calendar. xbar runs it every 30 minutes and shows the status in the menu bar.

```
xbar ──(every 30m / "Sync now")──▶ node dist/sync.js --xbar-output
                                     │  MCP stdio ──▶ blackboard-mcp ──▶ Blackboard
                                     │  normalize → diff vs. state.json → all-day vs. timed
                                     └─ Google Calendar API (insert, or update on 409)
```

## Requirements

- macOS, Node 20+, Google Chrome (for blackboard-mcp)
- [blackboard-mcp](https://github.com/alanwtom/blackboard-mcp) cloned, built (`npm run build`)
  and signed in once (`npm run login`)
- [xbar](https://xbarapp.com) or SwiftBar, for the menu bar item
- The Mac needs to be on and logged in when syncs run (blackboard-mcp drives a real browser profile)

## Setup

```bash
git clone https://github.com/Jopersaud/blackboard-calendar-sync.git
cd blackboard-calendar-sync
npm install && npm run build
mkdir -p ~/.blackboard-calendar-sync
cp config.example.json ~/.blackboard-calendar-sync/config.json   # then set blackboardMcpPath
```

### 1. Check Blackboard connectivity

```bash
npm run probe -- --days 14 --normalized
```

Prints the raw `get_upcoming_work` / `list_courses` output and the normalized assignments.

### 2. Connect Google Calendar (one time)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and
   enable the **Google Calendar API**.
2. Configure the OAuth consent screen (External, add yourself as a test user).
3. Create credentials → **OAuth client ID** → application type **Desktop app**. Download
   the JSON and save it as `~/.blackboard-calendar-sync/google-credentials.json`.
4. Run `npm run auth`. A browser opens once for consent; the refresh token is stored in
   `~/.blackboard-calendar-sync/google-token.json` (mode 600) and the "Blackboard" calendar
   is created.

> While the consent screen is in "Testing" mode, Google expires refresh tokens after 7 days.
> Publish the app (no verification needed for personal use) to keep it signed in.

Optionally, `npm run test-event` creates a fake 11:59 PM item and a 6:35 PM item two days
out so you can check where the reminders land; `npm run test-event -- --cleanup` removes them.

### 3. Try a sync

```bash
npm run dry-run      # what would be created/updated; no Calendar API calls
npm run sync         # the real thing
```

### 4. Install the menu bar item

```bash
npm run install-xbar                       # every 30 minutes
npm run install-xbar -- --interval 1h      # or pick another interval
npm run install-xbar -- --dir "$HOME/Library/Application Support/SwiftBar/Plugins"
```

This writes `blackboard-sync.30m.sh` (a two-line launcher) into xbar's plugin folder. The
menu bar then shows `🎓 3 due` (items due in the next 7 days). The dropdown has the last
sync time, upcoming items, **Sync now**, **Open Google Calendar** and **View log**.

## When something breaks

| Menu bar | Cause | Fix |
|---|---|---|
| `⚠️ Blackboard login expired` (red) | blackboard-mcp's session lapsed | `npm run login` in blackboard-mcp, or click **Sign in to Blackboard now…** |
| `⚠️ Google Calendar access needed` (red) | Refresh token revoked/expired | `npm run auth`, or click **Authorize Google Calendar now…** |
| `⚠️ Calendar sync not set up` (red) | Missing/invalid `config.json` | See Setup |
| `🎓 3 due ⚠️` (orange) | Some other failure; last good data still shown | See **View log** |

The two auth failures also fire a macOS notification, once per new occurrence (not every
30 minutes). If one assignment fails to sync, the rest still do; the failure is listed in
the dropdown. Overlapping runs (timer + manual refresh) are prevented with a lock file.

## Configuration

`~/.blackboard-calendar-sync/config.json`:

| Key | Default | Meaning |
|---|---|---|
| `blackboardMcpPath` | *(required)* | Path to blackboard-mcp's `dist/index.js` |
| `nodePath` | this Node | Node binary used to run blackboard-mcp |
| `googleCalendarId` | — | Sync into this calendar instead of the dedicated one |
| `calendarName` | `"Blackboard"` | Name of the dedicated calendar (found or created) |
| `lookaheadDays` | `30` | How far ahead to pull (max 90) |
| `reminderMinutesBefore` | `1440` | Popup on the due-date event, before the deadline |
| `allDayReminderTime` | `"17:00"` | Local time of that popup for all-day due-date events |
| `dueEventLeadMinutes` | `30` | Length of a timed due-date event, ending at the deadline |
| `timeZone` | system zone | IANA zone used for the 11:59 PM rule and dates |
| `includeRecentlyOverdue` | `true` | Also sync work due in the last 3 days that isn't handed in |

### Reminder details

Google counts an event's popup from the event's **start**:

- **Timed events** start `dueEventLeadMinutes` before the deadline, so the override is
  `reminderMinutesBefore − dueEventLeadMinutes` (1410 by default), which puts the popup exactly
  24 h before the deadline.
- **All-day events** start at local midnight, so a plain 1440 would fire at midnight the night
  before. Instead the popup fires at `allDayReminderTime` on the day before (420 minutes by
  default = 5 PM the day before). Use `npm run test-event` to check this on your calendar.

## Local files

Everything lives in `~/.blackboard-calendar-sync/` (override with `BBCS_HOME`):
`config.json`, `google-credentials.json`, `google-token.json`, `state.json` (change-detection
cache; safe to delete), `status.json` (what the menu bar shows), `log.txt` (rotated at 512 KB).

## Development

```bash
npm test            # vitest: event logic, normalizer, sync engine, xbar output, MCP client
npm run typecheck
```

The tests exercise the real MCP stdio client against a fake blackboard-mcp server
(`tests/fixtures/fake-bb-server.mjs`) and the real googleapis client against a fake Calendar API.

## Not yet decided

- Whether to remove past-due synced events after some period. Today they are left alone.
- The right refresh interval. 30 minutes is the default; change it with `install-xbar --interval`.

## Contributors

- [Joshua Persaud](https://github.com/Jopersaud)
