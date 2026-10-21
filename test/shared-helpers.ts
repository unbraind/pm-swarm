import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { TestContext } from 'node:test';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { gitEnvironment } from '../src/git-environment.ts';

/** Create an SDK tracker outside Git, including the actual extension and a Git-free PATH. */
export async function sharedFixture(t: TestContext) {
  const repo = mkdtempSync(join(tmpdir(), 'swarm-shared-')); const pmRoot = join(repo, '.agents/pm');
  t.after(() => rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const original = { ...process.env };
  process.env.PM_SOURCE_WORKSPACE_ROOT = repo;
  process.env.GIT_CEILING_DIRECTORIES = dirname(repo);
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original); });
  const client = new PmClient({ cwd: repo, pmRoot, author: 'shared-test', noExtensions: false });
  await client.init('shared-test', { defaults: true, agentGuidance: 'skip' });
  const extension = join(pmRoot, 'extensions/pm-swarm'); mkdirSync(extension, { recursive: true });
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ name: 'pm-swarm', version: '2026.10.15', entry: 'entry.js', capabilities: ['commands', 'schema', 'renderers'] }));
  writeFileSync(join(extension, 'entry.js'), `export { default } from '${new URL('../index.ts', import.meta.url).href}';\n`);
  const bin = join(repo, 'bin'); mkdirSync(bin); symlinkSync(process.execPath, join(bin, 'node'));
  const env = gitEnvironment({ ...process.env, HOME: repo, PATH: bin, PM_PATH: pmRoot, PM_AUTHOR: 'shared-test', PM_GLOBAL_PATH: join(repo, '.pm-cli'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  const host = join(import.meta.dirname, '../node_modules/.bin/pm');
  /** Invoke real CLI parsing and rendering, with no Git executable available. */
  const cli = (...args: string[]) => spawnSync(process.execPath, [host, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 300000 });
  /** Require a successful real command and decode its JSON response. */
  const run = (...args: string[]) => { const result = cli(...args, '--json'); assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? '')); return JSON.parse(result.stdout) as Record<string, unknown>; };
  /** Create ranked real tasks with declared paths through the SDK. */
  const item = async (files: string[] = [], priority = 2, id?: string) => (await client.create({ type: 'Task', title: 'Shared work', id, priority, file: files.map(path => `path=${path}`) })).item.id;
  const shared = new SharedTracker(new Swarm(repo, pmRoot, client, 'shared-test'));
  return { repo, pmRoot, client, shared, cli, run, item, env, host };
}

