import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Everything this app stores lives in one folder in the user's home
 * directory, mirroring blackboard-mcp's "everything stays on your machine"
 * posture. BBCS_HOME overrides it (used by tests and for multiple profiles).
 */
export function appDir(): string {
  return process.env.BBCS_HOME ?? path.join(os.homedir(), '.blackboard-calendar-sync');
}

export const paths = {
  get dir() {
    return appDir();
  },
  get config() {
    return path.join(appDir(), 'config.json');
  },
  get state() {
    return path.join(appDir(), 'state.json');
  },
  get status() {
    return path.join(appDir(), 'status.json');
  },
  get lock() {
    return path.join(appDir(), 'sync.lock');
  },
  get log() {
    return path.join(appDir(), 'log.txt');
  },
  /** The OAuth client downloaded from Google Cloud Console (Desktop app). */
  get googleCredentials() {
    return path.join(appDir(), 'google-credentials.json');
  },
  /** The refresh token produced by `npm run auth`. */
  get googleToken() {
    return path.join(appDir(), 'google-token.json');
  },
};

/** Create the app folder, readable only by the current user. */
export function ensureAppDir(): void {
  fs.mkdirSync(appDir(), { recursive: true, mode: 0o700 });
}

/** Write a file atomically (temp file + rename) so a crash can't leave half a JSON file. */
export function writeFileAtomic(file: string, data: string, mode = 0o600): void {
  ensureAppDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

export function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
