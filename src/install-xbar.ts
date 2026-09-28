#!/usr/bin/env node
/**
 * Install the xbar plugin shim (`npm run install-xbar -- --interval 30m`).
 *
 * Writes an executable launcher into xbar's plugins folder; its filename's
 * ".30m." segment is how xbar knows to run it every 30 minutes. Pass
 * --dir to target SwiftBar's (or any other) plugin folder instead.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flagValue, projectDir } from './app.js';
import { errorMessage } from './errors.js';
import { pluginScript } from './xbar.js';

function main(): void {
  const args = process.argv.slice(2);
  const interval = flagValue(args, '--interval') ?? '30m';
  if (!/^\d+[smhd]$/.test(interval)) throw new Error(`--interval must look like 15m, 30m, 1h (got "${interval}")`);
  const dir = flagValue(args, '--dir') ?? path.join(os.homedir(), 'Library', 'Application Support', 'xbar', 'plugins');
  fs.mkdirSync(dir, { recursive: true });

  // Replace any previous install with a different interval.
  for (const f of fs.readdirSync(dir)) {
    if (/^blackboard-sync\.\d+[smhd]\.sh$/.test(f)) fs.rmSync(path.join(dir, f));
  }
  const file = path.join(dir, `blackboard-sync.${interval}.sh`);
  fs.writeFileSync(file, pluginScript({ projectDir, nodePath: process.execPath }), { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  process.stdout.write(`Installed ${file}\nIn xbar, choose "Refresh all" (or restart xbar) to pick it up.\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`${errorMessage(err)}\n`);
  process.exit(1);
}
