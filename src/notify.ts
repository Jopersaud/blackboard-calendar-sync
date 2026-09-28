import { execFile } from 'node:child_process';

/** AppleScript string literal. */
function osaString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Show an OS notification (macOS only; elsewhere a no-op). Resolves even on
 * failure — a missing notification must never fail the sync.
 */
export function notify(title: string, message: string): Promise<void> {
  if (process.platform !== 'darwin') return Promise.resolve();
  const script = `display notification ${osaString(message)} with title ${osaString(title)}`;
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 10_000 }, () => resolve());
  });
}
