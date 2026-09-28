import { execFile, spawn } from 'node:child_process';
import { distScript, projectDir } from './app.js';

/**
 * Start a sync as a detached process and return immediately, so the menu bar
 * never waits on Blackboard. The child outlives this process and xbar.
 */
export function startBackgroundSync(opts: { pluginName?: string } = {}): void {
  const args = [distScript('sync.js'), '--background', ...(opts.pluginName ? ['--plugin', opts.pluginName] : [])];
  const child = spawn(process.execPath, args, { cwd: projectDir, detached: true, stdio: 'ignore', env: process.env });
  child.unref();
}

/** Ask xbar to re-run the plugin so the menu bar shows fresh results (macOS only). */
export function refreshXbar(pluginName?: string): Promise<void> {
  if (process.platform !== 'darwin') return Promise.resolve();
  const url = pluginName
    ? `xbar://app.xbarapp.com/refreshPlugin?path=${encodeURIComponent(pluginName)}`
    : 'xbar://app.xbarapp.com/refreshAllPlugins';
  return new Promise((resolve) => {
    execFile('/usr/bin/open', ['-g', url], { timeout: 10_000 }, () => resolve());
  });
}
