#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainInvocation } from './main-invocation.ts';

/** Adapt the pinned changelog reader to explicit full core list projections.
 * Keep all tracker reads, history reconstruction and completeness certification
 * in their existing packages. Forward schema reads unchanged and preserve any
 * host failure. The host override is a process boundary for executable checks.
 */
export function runChangelogPm(args: string[], host = fileURLToPath(new URL('../node_modules/.bin/pm', import.meta.url))): number {
  const full = args.includes('list') && args.includes('--all') ? ['--full'] : [];
  const result = spawnSync(process.execPath, [host, ...args, ...full], { stdio: 'inherit' });
  return result.status ?? 1;
}

if (isMainInvocation(process.argv, import.meta.url)) process.exitCode = runChangelogPm(process.argv.slice(2));
