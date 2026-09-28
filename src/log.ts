import fs from 'node:fs';
import { ensureAppDir, paths } from './paths.js';

const MAX_BYTES = 512 * 1024;

/**
 * Append to ~/.blackboard-calendar-sync/log.txt, rotating to log.txt.1 once
 * it passes 512 KB. Logging must never break a sync, so errors are swallowed.
 */
export function logLine(message: string, file = paths.log): void {
  try {
    ensureAppDir();
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {
    /* ignore */
  }
}
