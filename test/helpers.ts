import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { TestContext } from 'node:test';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { git } from '../src/git.ts';
import { Swarm } from '../src/swarm.ts';

/** Create a real Git repository and SDK tracker with isolated fixture identity. */
export async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pm-swarm-test-')); const repo = join(root, 'repo'); mkdirSync(repo);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(repo, ['init', '-b', 'main']);
  const pmRoot = join(repo, '.agents/pm'); const client = new PmClient({ cwd: repo, pmRoot, author: 'swarm-test', noExtensions: false });
  await client.init('swarm-test', { defaults: true, agentGuidance: 'skip' });
  mkdirSync(join(pmRoot, 'extensions/pm-swarm'), { recursive: true });
  writeFileSync(join(pmRoot, 'extensions/pm-swarm/manifest.json'), JSON.stringify({ name: 'pm-swarm', version: '2026.10.15', entry: 'entry.js', capabilities: ['commands', 'schema'] }));
  writeFileSync(join(pmRoot, 'extensions/pm-swarm/entry.js'), `export { default } from '${new URL('../index.ts', import.meta.url).href}';\n`);
  appendFileSync(join(repo, '.gitignore'), '\n.agents/pm/extensions/\n');
  const swarm = new Swarm(repo, pmRoot, client, 'swarm-test');
  /** Write a relative fixture source file. */
  const write = (name: string, body: string, cwd = repo) => { const path = join(cwd, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };
  /** Commit explicit fixture paths under a public automation identity. */
  const save = (paths = ['.agents/pm', '.gitattributes', '.gitignore'], cwd = repo) => { git(cwd, ['add', '--', ...paths]); git(cwd, ['-c', 'user.name=SteveBot', '-c', 'user.email=1153461+unbraind@users.noreply.github.com', 'commit', '--allow-empty', '-m', 'Record fixture']); return git(cwd, ['rev-parse', 'HEAD']); };
  save();
  /** Create an SDK task and attach an optional linked footprint. */
  const item = async (files: string[] = []) => { const id = (await client.create({ type: 'Task', title: 'Fixture work' })).item.id; if (files.length > 0) await client.files(id, { add: files }); return id; };
  return { root, repo, pmRoot, client, swarm, write, save, item };
}
