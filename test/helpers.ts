import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, appendFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { TestContext } from 'node:test';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { fixtureGit as git, assertFixtureRepo } from './git-helpers.ts';
import type { TestResult } from '@unbrained/pm-cli/sdk';
import { gitEnvironment } from '../src/git-environment.ts';
import { Swarm } from '../src/swarm.ts';

/** Create a real Git repository and SDK tracker with isolated fixture identity. */
export async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pm-swarm-test-'))); const repo = join(root, 'repo'); mkdirSync(repo);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const sourceEnv = { ...process.env };
  const clean = gitEnvironment();
  for (const key of Object.keys(sourceEnv)) if (!(key in clean)) delete process.env[key];
  git(repo, ['init', '-b', 'main']);
  process.env.PM_SOURCE_WORKSPACE_ROOT = repo;
  delete process.env.GITHUB_HEAD_REF; delete process.env.GITHUB_REF_NAME;
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in sourceEnv)) delete process.env[key]; Object.assign(process.env, sourceEnv); });
  assertFixtureRepo(repo);
  const pmRoot = join(repo, '.agents/pm'); const client = new PmClient({ cwd: repo, pmRoot, author: 'swarm-test', noExtensions: false });
  await client.init('swarm-test', { defaults: true, agentGuidance: 'skip' });
  mkdirSync(join(pmRoot, 'extensions/pm-swarm'), { recursive: true });
  writeFileSync(join(pmRoot, 'extensions/pm-swarm/manifest.json'), JSON.stringify({ name: 'pm-swarm', version: '2026.10.15', entry: 'entry.js', capabilities: ['commands', 'schema', 'renderers'] }));
  writeFileSync(join(pmRoot, 'extensions/pm-swarm/entry.js'), `export { default } from '${new URL('../index.ts', import.meta.url).href}';\n`);
  appendFileSync(join(repo, '.gitignore'), '\n.agents/pm/extensions/\n');
  const swarm = new Swarm(repo, pmRoot, client, 'swarm-test');
  /** Write a relative fixture source file. */
  const write = (name: string, body: string, cwd = repo) => { assertFixtureRepo(cwd); const path = join(cwd, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };
  /** Commit explicit fixture paths under a public automation identity. */
  const save = (paths = ['.agents/pm', '.gitattributes', '.gitignore'], cwd = repo) => { git(cwd, ['add', '--', ...paths]); git(cwd, ['-c', 'user.name=SteveBot', '-c', 'user.email=1153461+unbraind@users.noreply.github.com', 'commit', '--allow-empty', '-m', 'Record fixture']); return git(cwd, ['rev-parse', 'HEAD']); };
  save();
  /** Create an SDK task and attach an optional linked footprint. */
  const item = async (files: string[] = []) => { const id = (await client.create({ type: 'Task', title: 'Fixture work' })).item.id; if (files.length > 0) await client.files(id, { add: files }); return id; };
  return { root, repo, pmRoot, client, swarm, write, save, item };
}

/** Add a real SDK linked command on a foreign branch and carry its provenance onto main. */
export async function linkFromBranch(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  git(f.repo, ['switch', '-c', 'authoring']);
  await f.client.run('test', { id, options: { add: ['command=node --test absent.test.js'] } });
  f.save(); git(f.repo, ['switch', 'main']); git(f.repo, ['merge', '--ff-only', 'authoring']);
  return (await f.client.run('test', { id, options: { list: true } }) as TestResult).tests;
}

/** Invoke native CLI option parsing against a real fixture with scrubbed Git targeting. */
export function swarmCli(f: Awaited<ReturnType<typeof fixture>>, args: string[]) {
  const command = join(import.meta.dirname, '../node_modules/.bin/pm');
  return spawnSync(process.execPath, [command, 'swarm', ...args, '--json'], {
    cwd: f.repo, encoding: 'utf8', env: gitEnvironment({ ...process.env, PM_PATH: f.pmRoot, PM_AUTHOR: 'swarm-test' }),
  });
}
