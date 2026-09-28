import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { google } from 'googleapis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GoogleCalendar } from '../src/calendar/client.js';
import { buildEvents } from '../src/events.js';
import { testConfig } from './helpers.js';

/** A tiny in-memory stand-in for the Calendar v3 REST API. */
const events = new Map<string, unknown>();
const calendars: { id: string; summary: string }[] = [{ id: 'primary@x', summary: 'Me' }];
let revoked = false;
const requests: string[] = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname.replace(/^\/calendar\/v3/, '');
    requests.push(`${req.method} ${p}`);
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    };
    if (revoked) return send(401, { error: { code: 401, message: 'Invalid Credentials' } });
    if (req.method === 'GET' && p === '/users/me/calendarList') return send(200, { items: calendars });
    if (req.method === 'POST' && p === '/calendars') {
      const cal = { id: 'bb@group.calendar.google.com', summary: JSON.parse(body).summary };
      calendars.push(cal);
      return send(200, cal);
    }
    let m = /^\/calendars\/([^/]+)\/events$/.exec(p);
    if (req.method === 'POST' && m) {
      const ev = JSON.parse(body);
      const key = `${decodeURIComponent(m[1]!)}/${ev.id}`;
      if (events.has(key)) return send(409, { error: { code: 409, message: 'The requested identifier already exists.' } });
      events.set(key, ev);
      return send(200, ev);
    }
    m = /^\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(p);
    if (req.method === 'PUT' && m) {
      const key = `${decodeURIComponent(m[1]!)}/${m[2]}`;
      events.set(key, JSON.parse(body));
      return send(200, JSON.parse(body));
    }
    send(404, { error: { code: 404, message: 'Not Found' } });
  });
});

let cal: GoogleCalendar;
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const auth = new google.auth.OAuth2('id', 'secret');
  auth.setCredentials({ access_token: 'tok', expiry_date: Date.now() + 3600_000 });
  const rootUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  cal = new GoogleCalendar(google.calendar({ version: 'v3', auth, rootUrl }));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('GoogleCalendar against a fake Calendar API', () => {
  const config = testConfig();
  const ev = buildEvents(
    { contentId: 'c:1', courseId: 'c', title: 'HW', dueAt: '2026-10-01T03:59:00.000Z' },
    config,
  );

  it('creates the dedicated calendar once, then finds it by name', async () => {
    const id = await cal.ensureCalendar({ name: 'Blackboard', timeZone: config.timeZone });
    expect(id).toBe('bb@group.calendar.google.com');
    expect(await cal.ensureCalendar({ name: 'Blackboard', timeZone: config.timeZone })).toBe(id);
    expect(calendars.filter((c) => c.summary === 'Blackboard')).toHaveLength(1);
  });

  it('inserts with the deterministic id, and updates on conflict', async () => {
    const calId = 'bb@group.calendar.google.com';
    expect(await cal.upsertEvent(calId, ev.due)).toBe('created');
    expect(await cal.upsertEvent(calId, { ...ev.due, summary: 'HW (moved)' })).toBe('updated');
    expect(events.size).toBe(1);
    expect(events.get(`${calId}/${ev.due.id}`)).toMatchObject({ summary: 'HW (moved)', start: { date: '2026-09-30' } });
    expect(requests.filter((r) => r.startsWith('PUT'))).toEqual([`PUT /calendars/${encodeURIComponent(calId)}/events/${ev.due.id}`]);
  });

  it('surfaces 401 as a google_auth error', async () => {
    revoked = true;
    try {
      await expect(cal.upsertEvent('bb@group.calendar.google.com', ev.reminder)).rejects.toMatchObject({ kind: 'google_auth' });
    } finally {
      revoked = false;
    }
  });
});
