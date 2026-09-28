import dns from 'node:dns';
import { SyncError } from './errors.js';

export interface WaitForNetworkOptions {
  host: string;
  /** Give up after this long (wall clock). */
  timeoutMs?: number;
  intervalMs?: number;
  lookup?: (host: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Resolve once `host` resolves in DNS, retrying for a while. Right after the
 * Mac wakes, Wi-Fi takes a few seconds to come back; syncing before then
 * made Chrome and Blackboard hang instead of failing.
 */
export async function waitForNetwork(opts: WaitForNetworkOptions): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const lookup = opts.lookup ?? ((host: string) => dns.promises.lookup(host));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      await lookup(opts.host);
      return;
    } catch {
      if (now() + intervalMs > deadline) break;
      await sleep(intervalMs);
    }
  }
  throw new SyncError('offline', "No internet connection; will sync when you're back online.");
}
