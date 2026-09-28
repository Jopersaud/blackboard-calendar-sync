import fs from 'node:fs';
import { google } from 'googleapis';
import { z } from 'zod';
import { SyncError } from '../errors.js';
import { paths, readJsonFile, writeFileAtomic } from '../paths.js';

/** Full calendar scope: needed to find or create the dedicated calendar and write events. */
export const SCOPES = ['https://www.googleapis.com/auth/calendar'];

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

const ClientSecretSchema = z.object({
  client_id: z.string(),
  client_secret: z.string(),
});

/** The JSON Google Cloud Console downloads for a "Desktop app" OAuth client. */
const CredentialsFileSchema = z.union([
  z.object({ installed: ClientSecretSchema }).transform((v) => v.installed),
  z.object({ web: ClientSecretSchema }).transform((v) => v.web),
  ClientSecretSchema,
]);

const TokenSchema = z
  .object({
    refresh_token: z.string().min(1),
    access_token: z.string().optional().nullable(),
    expiry_date: z.number().optional().nullable(),
    scope: z.string().optional(),
    token_type: z.string().optional().nullable(),
  })
  .passthrough();

export function loadClientSecret(): z.infer<typeof ClientSecretSchema> {
  const raw = readJsonFile(paths.googleCredentials);
  if (raw === undefined) {
    throw new SyncError(
      'google_auth',
      `Google OAuth client not found at ${paths.googleCredentials}. Download it from Google Cloud Console (OAuth client, type "Desktop app") and save it there, then run npm run auth.`,
    );
  }
  const parsed = CredentialsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SyncError('google_auth', `${paths.googleCredentials} is not a Google OAuth client file.`);
  }
  return parsed.data;
}

export function createOAuthClient(redirectUri?: string): OAuth2Client {
  const secret = loadClientSecret();
  return new google.auth.OAuth2(secret.client_id, secret.client_secret, redirectUri);
}

export function saveToken(tokens: Record<string, unknown>): void {
  writeFileAtomic(paths.googleToken, `${JSON.stringify(tokens, null, 2)}\n`, 0o600);
  fs.chmodSync(paths.googleToken, 0o600);
}

/**
 * An authorized client for unattended runs, built from the stored refresh
 * token. No browser interaction; refreshed access tokens are persisted.
 */
export function authorizedClient(): OAuth2Client {
  const raw = readJsonFile(paths.googleToken);
  if (raw === undefined) {
    throw new SyncError('google_auth', 'Google Calendar is not authorized yet. Run npm run auth in blackboard-calendar-sync.');
  }
  const token = TokenSchema.safeParse(raw);
  if (!token.success) {
    throw new SyncError('google_auth', `${paths.googleToken} has no refresh token. Run npm run auth again.`);
  }
  const client = createOAuthClient();
  client.setCredentials(token.data);
  client.on('tokens', (fresh) => {
    // Google only sends refresh_token on first consent; keep the stored one.
    try {
      saveToken({ ...token.data, ...fresh, refresh_token: fresh.refresh_token ?? token.data.refresh_token });
    } catch {
      /* a failed cache write only costs a refresh next run */
    }
  });
  return client;
}
