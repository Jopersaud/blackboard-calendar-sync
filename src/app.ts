import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';

/** The project root (the folder holding package.json and dist/). */
export const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const distScript = (name: string): string => path.join(projectDir, 'dist', name);

/** blackboard-mcp's `npm run login` entry point, when it can be found. */
export function blackboardLoginScript(config: Config | undefined): string | undefined {
  if (!config) return undefined;
  const script = path.join(path.dirname(path.resolve(config.blackboardMcpPath)), 'cli', 'login.js');
  return fs.existsSync(script) ? script : undefined;
}

export function hasFlag(args: string[], ...names: string[]): boolean {
  return args.some((a) => names.includes(a));
}

export function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq?.slice(name.length + 1);
}
