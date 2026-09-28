#!/usr/bin/env node
/**
 * One-time Google Calendar authorization (`npm run auth`).
 *
 * Opens the browser once for consent via a loopback redirect on 127.0.0.1,
 * then stores the refresh token in ~/.blackboard-calendar-sync/google-token.json
 * (mode 600). Scheduled runs use that token silently.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SCOPES, createOAuthClient, saveToken } from './calendar/auth.js';
import { GoogleCalendar } from './calendar/client.js';
import { loadConfig, systemTimeZone } from './config.js';
import { errorMessage } from './errors.js';
import { ensureAppDir, paths } from './paths.js';
import { loadState, saveState } from './state.js';

const AUTH_TIMEOUT_MS = 5 * 60_000;

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args, () => undefined);
}

function waitForCode(server: http.Server, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Google sign-in.')), AUTH_TIMEOUT_MS);
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (!code && !error) {
        res.writeHead(404).end();
        return;
      }
      const ok = Boolean(code) && url.searchParams.get('state') === expectedState;
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        ok
          ? '<h2>Google Calendar connected.</h2><p>You can close this tab and return to the terminal.</p>'
          : `<h2>Authorization failed.</h2><p>${error ?? 'State mismatch'}. Return to the terminal and try again.</p>`,
      );
      clearTimeout(timer);
      if (ok && code) resolve(code);
      else reject(new Error(`Google authorization failed: ${error ?? 'state mismatch'}`));
    });
  });
}

async function main(): Promise<void> {
  ensureAppDir();
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const client = createOAuthClient(`http://127.0.0.1:${port}`);
    const state = crypto.randomBytes(16).toString('hex');
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256' as never,
    });
    process.stdout.write(`Opening your browser to authorize Google Calendar.\nIf it doesn't open, visit:\n\n${url}\n\n`);
    openBrowser(url);

    const code = await waitForCode(server, state);
    const { tokens } = await client.getToken({ code, codeVerifier });
    if (!tokens.refresh_token) {
      throw new Error(
        'Google returned no refresh token. Remove this app at https://myaccount.google.com/permissions and run npm run auth again.',
      );
    }
    saveToken(tokens as Record<string, unknown>);
    process.stdout.write(`Saved Google token to ${paths.googleToken}\n`);

    // Confirm it works and set up the dedicated calendar now, not at 3 AM.
    let config;
    try {
      config = loadConfig();
    } catch {
      config = undefined;
    }
    const { state: syncState } = loadState();
    const calendarId = await GoogleCalendar.fromStoredToken().ensureCalendar({
      calendarId: config?.googleCalendarId ?? syncState.calendarId,
      name: config?.calendarName ?? 'Blackboard',
      timeZone: config?.timeZone ?? systemTimeZone(),
    });
    if (!config?.googleCalendarId) {
      syncState.calendarId = calendarId;
      saveState(syncState);
    }
    process.stdout.write(`Calendar ready: ${calendarId}\n`);
  } finally {
    server.close();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`${errorMessage(err)}\n`);
    process.exit(1);
  },
);
