# iPhone Access — Optional Spec

> **Status:** optional / not started. Future work, to be done later.

## 1. Goal

Use Blackboard Calendar Sync from an iPhone: see due dates, get alerts when something
breaks, trigger a sync on demand, and ideally keep syncing when the Mac is off.

## 2. Constraint

The sync **can't run on an iPhone**. It depends on blackboard-mcp, which needs desktop
Chrome, Playwright, and a saved Blackboard browser session — none of which iOS allows.
That leaves two designs:

- **A. Mac stays the engine; the iPhone gets visibility and control** (Phases 1–2). Cheap
  and reliable. Recommended starting point.
- **B. Move the engine to the cloud** (Phase 3). Only practical if Blackboard offers a
  calendar feed link.

## 3. Phase 1 — See everything on the phone (no code)

The events already live in Google Calendar, so this is phone settings only:

1. Install the **Google Calendar** app and sign in with the account the sync writes to
   (or add that account under iOS **Settings → Calendar → Accounts** to use Apple Calendar).
2. Make sure the **"Blackboard"** calendar is switched on.
3. Custom popup reminders are delivered by the Google Calendar app; Apple Calendar ignores
   Google's custom reminder overrides. Use the Google app to get the 24-hour popups.

**Outcome:** due dates and reminders on the phone. Nothing to build.

## 4. Phase 2 — Alerts and control from the phone (Mac still required)

### 4a. Push alerts when something breaks

- Add an optional `notifyUrl` config key, using [ntfy.sh](https://ntfy.sh) (free, iPhone
  app; subscribe to a private, hard-to-guess topic name).
- On a new auth failure (Blackboard session expired, Google access lost) or sync failure,
  POST one message to that URL. Reuse the existing "notify once per new occurrence" logic
  (`shouldNotify` in `src/status.ts`) so it doesn't repeat every 30 minutes.
- Optional: a daily or weekly digest ("3 due this week: …").
- **Code:** ~30 lines in `src/notify.ts` and `src/config.ts`, plus tests. Alternatives to
  ntfy: Pushover (one-time $5), email.

### 4b. "Sync now" from the phone

- Apple **Shortcuts** has a built-in **"Run script over SSH"** action. Point it at the Mac
  (System Settings → General → Sharing → **Remote Login**) to run
  `cd <project> && node dist/sync.js` and show the summary line.
- Can live on the Home Screen, as a widget, or behind Siri ("Hey Siri, sync Blackboard").
- **Away from home Wi-Fi:** install [Tailscale](https://tailscale.com) (free) on the Mac
  and the iPhone so they can reach each other anywhere.
- **Code:** none. Add a README section with exact Shortcut setup steps.

### 4c. Keep the Mac reachable

- System Settings → Battery → Options → **"Wake for network access"**, and keep the Mac
  plugged in. A closed or sleeping Mac is the main limit of Phase 2.

### Known limitation

When the **Blackboard** session expires, signing in again (NetID + Duo) needs a browser on
the Mac. It can be done from the phone via Screen Sharing over Tailscale, but it's clunky.
Phase 3 removes this.

## 5. Phase 3 (optional) — No Mac at all, via a Blackboard calendar feed

### Step 0: check feasibility

Many Blackboard Ultra sites let you export your calendar as a private **iCal/ICS** feed
(usually labelled something like **Calendar → Settings → Get external calendar link**).
Check whether Syracuse's Blackboard offers this. If it doesn't, stop at Phase 2.

If it does:

- The link is a secret URL that anything can fetch: no Duo, no Chrome.
- A scheduled **GitHub Actions** job (free at this volume) fetches the feed every
  30–60 minutes, applies the same rules (11:59 PM → all-day, "Due tomorrow" events, the
  same deterministic event IDs so nothing duplicates), and writes to Google Calendar.
- The Mac can be off. The phone shows the calendar, plus ntfy alerts from Phase 2a.

### Code changes

- **Second data source:** `source: "mcp" | "ics"` in config. An ICS parser produces the
  same `Assignment` shape as `normalizeUpcomingWork`, so events, the sync engine and state
  are reused unchanged.
- **Workflow:** a scheduled GitHub Actions job. The feed URL and the Google OAuth
  token are stored as repo **secrets**.
- **State between runs:** keep `state.json` in the Actions cache or a small committed file.
  Deterministic event IDs make this forgiving: losing it never causes duplicates, only a
  round of no-op updates.
- **Tests:** ICS parsing against a sample feed; the existing engine tests cover the rest.

### Trade-offs

- The feed may carry less data than blackboard-mcp: likely no points or submission
  status, and course names in whatever format the feed uses.
- The feed URL and the Google token would be stored as GitHub secrets. **Keep the repo
  private** if going this route.
- **Don't** run blackboard-mcp itself in the cloud with copied session cookies. It's
  fragile (Duo and Microsoft sign-in tend to block logins from server IP addresses), and it
  would mean storing SU login cookies on someone else's server.

## 6. Recommended order

1. **Phase 1** — phone settings only.
2. **Phase 2a** — ntfy alerts; the most useful small addition.
3. **Check for a Blackboard calendar feed link.** If one exists, Phase 3 is the long-term
   answer and Phases 2b/2c become unnecessary.
4. **Phase 2b** — only if staying on the Mac-based setup and remote syncs are wanted.

## 7. Open questions

- Does Syracuse's Blackboard offer an external calendar (iCal) link? This decides whether
  Phase 3 is possible.
- Push provider: ntfy.sh, Pushover, or email?
- If Phase 3: OK to make the repo private?
