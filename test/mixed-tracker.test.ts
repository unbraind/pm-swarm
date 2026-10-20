import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { delimiter, join, relative } from 'node:path';
import { test } from 'node:test';
import { acquireLock } from '@unbrained/pm-cli/sdk';
import { fixture } from './helpers.ts';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { repositoryRoot } from '../src/workspace.ts';
import { gitEnvironment } from '../src/git-environment.ts';
import { fixtureGit as git } from './git-helpers.ts';

test('concurrent Git and non-Git CLI selections coordinate on the same tracker', { timeout: 60000 }, async t => {
  const f = await fixture(t); const sharedWorkspace = join(f.root, 'shared'); mkdirSync(sharedWorkspace);
  const parents: string[] = [];
  for (const title of ['Git work', 'Shared work']) parents.push((await f.client.create({ type: 'Epic', title })).item.id);
  const ids = [await f.item(['src']), await f.item(['src/code.ts'])];
  for (const [index, id] of ids.entries()) await f.client.update(id, { parent: parents[index] });
  f.save();
  const results = await Promise.all([f.repo, sharedWorkspace].map(async (cwd, index) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), 'swarm', 'next', '--parent', parents[index], '--agent', `mixed-worker-${index}`, '--json'], {
      cwd, env: gitEnvironment({ ...process.env, PM_PATH: f.pmRoot, PM_SOURCE_PM_PATH: f.pmRoot, PM_SOURCE_WORKSPACE_ROOT: cwd, GIT_CEILING_DIRECTORIES: f.root }), stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000,
    });
    t.after(() => child.kill('SIGKILL'));
    const closed = once(child, 'close'); let output = ''; let error = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { error += chunk; });
    const [code] = await closed; assert.equal(code, 0, output + error);
    return JSON.parse(output) as { selected: string | null };
  }));
  assert.equal(results.filter(row => row.selected !== null).length, 1, 'overlapping work has one winner across modes');
  const claims = await Promise.all(ids.map(id => f.client.get(id)));
  assert.equal(claims.filter(view => view.claim_state?.claimed).length, 1);
});

for (const ownership of ['claim', 'assignment', 'missing-branch', 'unknown', 'terminal', 'unassigned'] as const) {
  test(`Git selection includes shared ${ownership} footprints`, async t => {
    const f = await fixture(t);
    const active = await f.item(ownership === 'unknown' ? [] : ['src']);
    const ready = await f.item(['src/code.ts']);
    if (ownership === 'claim' || ownership === 'terminal') await f.client.claim(active, { author: 'shared-worker' });
    else if (ownership !== 'unassigned') await f.client.update(active, { assignee: 'shared-worker' });
    if (ownership === 'terminal') await f.client.update(active, { status: 'closed', message: 'Fixture complete' });
    if (ownership === 'missing-branch') await f.client.update(active, { field: ['swarm_branch=swarm/not-local'] });
    const blocked = !['terminal', 'unassigned'].includes(ownership);
    const preview = await f.swarm.next(undefined, true);
    if (blocked) {
      assert.equal(preview.selected, null);
      assert.ok(preview.skipped.find(row => row.id === ready)?.overlaps.some(row => row.lane_id === active));
      await assert.rejects(f.swarm.start(ready, {}, true), /Overlapping start refused/);
      assert.equal((await f.client.get(ready)).claim_state?.claimed, false);
      assert.equal((await f.swarm.next()).selected, null);
    } else assert.ok(preview.selected !== null);
  });
}

test('Git strict start can convert its own shared claim without a self overlap', async t => {
  const f = await fixture(t); const id = await f.item(['src']); f.save();
  await new SharedTracker(f.swarm).start(id);
  assert.deepEqual((await f.swarm.start(id, {}, true)).overlap_warnings, []);
});

test('Git operations hold the tracker lease throughout real SDK reads and release after failure', async t => {
  const f = await fixture(t); const id = await f.item(['src']); f.save();
  const corpus = f.swarm.corpus.bind(f.swarm); let checks = 0;
  // Observe the real lease during real SDK reads; no tracker response is substituted.
  f.swarm.corpus = async () => {
    const release = await acquireLock(f.pmRoot, 'swarm-operation', 1800, 'probe', false, false, 0).catch(() => undefined);
    if (release !== undefined) await release();
    assert.equal(release, undefined, 'Git and shared operations must hold the same tracker lease');
    checks++; return corpus();
  };
  assert.equal((await f.swarm.next()).selected, id);
  assert.ok(checks >= 2);
  await assert.rejects(f.swarm.start(id), /Lane already exists/);
  const release = await acquireLock(f.pmRoot, 'swarm-operation', 1800, 'probe', false, false, 0); await release();
  await f.swarm.reap(true);
  const releaseAgain = await acquireLock(f.pmRoot, 'swarm-operation', 1800, 'probe', false, false, 0); await releaseAgain();
});

test('Git releases the tracker lease when repository discovery fails', async t => {
  const f = await fixture(t); const id = await f.item();
  // The engine still owns a real tracker, while its repository argument is invalid.
  const invalid = new Swarm(join(f.root, 'missing-repository'), f.pmRoot, f.client, 'swarm-test');
  await assert.rejects(invalid.start(id), /git rev-parse failed/);
  const release = await acquireLock(f.pmRoot, 'swarm-operation', 1800, 'probe', false, false, 0); await release();
});

for (const suffix of ['/', '/nested/..', '/.'] as const) {
  test(`workspace detection normalizes absolute Git ceiling ${suffix}`, async t => {
    const f = await fixture(t); const workspace = join(f.repo, 'nested', 'workspace'); mkdirSync(workspace, { recursive: true });
    process.env.GIT_CEILING_DIRECTORIES = `${delimiter}${f.repo}${suffix}`;
    assert.equal(repositoryRoot(workspace), undefined);
    assert.equal(repositoryRoot(f.repo), f.repo, 'the current directory remains discoverable');
  });
}

test('workspace detection ignores relative ceiling entries', async t => {
  const f = await fixture(t); const workspace = join(f.repo, 'nested', 'workspace'); mkdirSync(workspace, { recursive: true });
  process.env.GIT_CEILING_DIRECTORIES = [relative(process.cwd(), f.repo), '../..', '.'].join(delimiter);
  assert.equal(repositoryRoot(workspace), f.repo);
});

test('workspace detection canonicalizes ceiling symlinks until an empty entry', async t => {
  const f = await fixture(t); const workspace = join(f.repo, 'nested', 'workspace'); mkdirSync(workspace, { recursive: true });
  const alias = join(f.root, 'alias'); symlinkSync(f.repo, alias);
  process.env.GIT_CEILING_DIRECTORIES = alias;
  assert.equal(repositoryRoot(workspace), undefined);
  process.env.GIT_CEILING_DIRECTORIES = `${delimiter}${alias}`;
  assert.equal(repositoryRoot(workspace), f.repo, 'an empty entry disables subsequent ceiling symlink resolution');
  process.env.GIT_CEILING_DIRECTORIES = f.repo;
  assert.equal(repositoryRoot(join(alias, 'nested', 'workspace')), undefined, 'workspace symlinks use the physical working directory');
});

test('workspace detection ignores nonexistent absolute ceilings and accepts missing workspace paths', async t => {
  const f = await fixture(t);
  process.env.GIT_CEILING_DIRECTORIES = join(f.root, 'missing-ceiling');
  assert.equal(repositoryRoot(f.pmRoot), f.repo);
  assert.equal(repositoryRoot(join(f.root, 'missing-workspace')), undefined);
});

for (const kind of ['repository', 'symlink', 'linked worktree'] as const) {
  test(`workspace detection resolves missing descendants of a ${kind}`, async t => {
    const f = await fixture(t); let workspace = f.repo; let expected = f.repo;
    if (kind === 'symlink') { workspace = join(f.root, 'alias'); symlinkSync(f.repo, workspace); }
    if (kind === 'linked worktree') {
      workspace = join(f.root, 'linked'); expected = workspace;
      git(f.repo, ['worktree', 'add', '--detach', workspace, 'HEAD']);
    }
    const missing = join(workspace, 'missing', 'nested');
    assert.equal(existsSync(missing), false);
    process.env.GIT_CEILING_DIRECTORIES = f.root;
    assert.equal(repositoryRoot(missing), expected);
    assert.equal(existsSync(missing), false, 'discovery must not create the requested path');
    process.env.GIT_CEILING_DIRECTORIES = workspace;
    assert.equal(repositoryRoot(missing), undefined, 'a ceiling still excludes the repository ancestor');
  });
}

test('shared assigned-only lanes block selection and are documented as assigned items', async t => {
  const f = await fixture(t); const active = await f.item(['src']); const ready = await f.item(['src/code.ts']);
  await f.client.update(active, { assignee: 'assigned-worker' });
  const shared = new SharedTracker(f.swarm);
  assert.equal((await shared.status()).lanes.find(row => row.id === active)?.claimed_at, null);
  assert.equal((await shared.plan()).blocked.some(row => row.id === ready), true);
  assert.equal((await shared.next()).selected, null);
  for (const path of ['README.md', 'docs/shared-tracker-verification.md']) {
    const body = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.match(body, /Shared lanes are all items with a nonblank assignee/);
    assert.doesNotMatch(body, /Shared lanes are (?:all )?claimed items/);
  }
});
