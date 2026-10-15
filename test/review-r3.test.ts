import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from './helpers.ts';
import { fixtureGit as git } from './git-helpers.ts';
import { branchExists, commit, predict } from '../src/git.ts';
import { gitEnvironment } from '../src/git-environment.ts';
import { cleanOrder, minimalConflict } from '../src/order.ts';

/** Build a real directory split conflict with no higher-stage index entries. */
async function directorySplit(t: Parameters<typeof fixture>[0], pair = false) {
  const f = await fixture(t); const id = await f.item(['old']);
  const peer = pair ? await f.item(['old']) : null;
  git(f.repo, ['config', 'merge.directoryRenames', 'true']);
  f.write('old/a', 'a\n'); f.write('old/b', 'b\n'); f.save(['.agents/pm', 'old']);
  const lane = await f.swarm.start(id);
  mkdirSync(join(lane.worktree, 'one')); mkdirSync(join(lane.worktree, 'two'));
  git(lane.worktree, ['mv', 'old/a', 'one/a']); git(lane.worktree, ['mv', 'old/b', 'two/b']); f.save(['old', 'one', 'two'], lane.worktree);
  const cwd = peer === null ? f.repo : (await f.swarm.start(peer)).worktree;
  f.write('old/c', 'c\n', cwd); f.save(['old'], cwd);
  f.save();
  return { ...f, id, peer, lane };
}

test('directory split conflict without paths stays visible in status and refuses landing', async t => {
  const f = await directorySplit(t); const base = commit(f.repo, 'main');
  const raw = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', base, f.lane.branch], { cwd: f.repo, env: gitEnvironment(), encoding: 'utf8' });
  assert.equal(raw.status, 1); assert.deepEqual(raw.stdout.split('\0').slice(1).filter(Boolean), []);
  const status = await f.swarm.status(); assert.equal(status.clean_pairs, 0); assert.equal(status.predictions.length, 1);
  assert.equal(status.predictions[0].clean, false); assert.deepEqual(status.predictions[0].conflicts, []);
  assert.match(status.predictions[0].messages.join('\n'), /CONFLICT \(directory rename split\)/);
  const lanes = await f.swarm.lanes(); assert.equal(cleanOrder(f.repo, base, lanes), null); assert.deepEqual(minimalConflict(f.repo, base, lanes), [f.id]);
  const landed = await f.swarm.land(true); assert.deepEqual(landed.order, []); assert.equal(landed.exit_code, 1);
  assert.deepEqual(landed.blocked[0].conflicts, []); assert.match(landed.blocked[0].messages.join('\n'), /directory rename split/);
  assert.equal(landed.blocked[0].peers[0].id, 'base'); assert.match(landed.blocked[0].peers[0].messages.join('\n'), /directory rename split/);
  assert.equal(commit(f.repo, 'main'), base); assert.equal(existsSync(join(f.repo, '.git/MERGE_HEAD')), false);
});

test('directory split pair reports peer messages even with no conflicted files', async t => {
  const f = await directorySplit(t, true); const result = await f.swarm.land();
  assert.equal(result.order.length, 1); assert.equal(result.blocked.length, 1);
  assert.deepEqual(result.blocked[0].conflicts, []); assert.equal(result.blocked[0].peers[0].id, result.order[0]);
  assert.match(result.blocked[0].peers[0].messages.join('\n'), /directory rename split/);
  assert.equal((await f.swarm.status()).predictions[0].clean, false);
});

/** Create an eligible merged lane through the real tracker and worktree engine. */
async function terminalLane(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t); const id = (await f.client.create({ type: 'Task', title: 'Terminal lane fixture' })).item.id;
  f.save(); const lane = await f.swarm.start(id); await f.client.update(id, { status: 'closed', message: 'Fixture completed' });
  return { ...f, id, lane };
}

for (const stale of ['missing directory', 'orphan directory']) test(`reap repairs stale ${stale} and reports scoped cleanup`, async t => {
  const f = await terminalLane(t); const { id, lane } = f;
  const other = join(f.root, 'unrelated'); git(f.repo, ['worktree', 'add', '--detach', other, 'main']); rmSync(other, { recursive: true });
  if (stale === 'missing directory') rmSync(lane.worktree, { recursive: true });
  else {
    const marker = readFileSync(join(lane.worktree, '.git'), 'utf8').trim().slice('gitdir: '.length);
    rmSync(marker, { recursive: true });
  }
  const before = git(f.repo, ['worktree', 'list', '--porcelain', '-z']);
  const action = stale === 'missing directory' ? 'pruned_registration' : 'removed_orphan';
  const preview = await f.swarm.reap(true);
  assert.equal(git(f.repo, ['worktree', 'list', '--porcelain', '-z']), before); assert.equal(branchExists(f.repo, lane.branch), true);
  const result = await f.swarm.reap(); assert.deepEqual(result.removed, [id]);
  assert.equal(existsSync(lane.worktree), false); assert.equal(branchExists(f.repo, lane.branch), false);
  assert.deepEqual(preview.cleanup, [{ id, action }]); assert.deepEqual(result.cleanup, [{ id, action }]); assert.deepEqual(result.refused, []);
  const after = git(f.repo, ['worktree', 'list', '--porcelain', '-z']); assert.equal(after.includes(lane.worktree), false); assert.equal(after.includes(other), true);
  assert.equal(spawnSync('git', ['config', '--get', `swarm.lane.${id}`], { cwd: f.repo, env: gitEnvironment() }).status, 1);
});

test('reap refuses config outside root and arbitrary or redirected directories inside root untouched', async t => {
  const f = await terminalLane(t); const { id, lane } = f;
  git(f.repo, ['worktree', 'remove', lane.worktree]);
  const outside = join(f.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'preserve');
  git(f.repo, ['config', '--local', `swarm.lane.${id}`, outside]);
  let result = await f.swarm.reap(); assert.deepEqual(result.removed, []); assert.match(result.refused[0].reason, /outside/);
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'preserve'); assert.equal(branchExists(f.repo, lane.branch), true);
  assert.equal(git(f.repo, ['config', '--get', `swarm.lane.${id}`]), outside);
  git(f.repo, ['config', '--local', `swarm.lane.${id}`, lane.worktree]);
  symlinkSync(outside, lane.worktree, 'dir'); result = await f.swarm.reap(); assert.match(result.refused[0].reason, /symlink/); rmSync(lane.worktree);
  mkdirSync(lane.worktree); writeFileSync(join(lane.worktree, 'keep'), 'preserve');
  result = await f.swarm.reap(); assert.match(result.refused[0].reason, /no worktree marker/);
  const marker = join(lane.worktree, '.git'); writeFileSync(marker, 'invalid');
  result = await f.swarm.reap(); assert.match(result.refused[0].reason, /invalid worktree marker/);
  writeFileSync(marker, `gitdir: ${join(outside, 'gone')}\n`);
  result = await f.swarm.reap(); assert.match(result.refused[0].reason, /not an orphaned worktree/);
  assert.equal(readFileSync(join(lane.worktree, 'keep'), 'utf8'), 'preserve'); assert.equal(branchExists(f.repo, lane.branch), true);
  rmSync(lane.worktree, { recursive: true });
  result = await f.swarm.reap(); assert.deepEqual(result.removed, [id]);
});

test('reap refuses active detached and locked worktrees', async t => {
  const f = await terminalLane(t); const { id, lane } = f;
  git(f.repo, ['worktree', 'lock', lane.worktree]);
  assert.match((await f.swarm.reap()).refused[0].reason, /locked/);
  git(f.repo, ['worktree', 'unlock', lane.worktree]); git(lane.worktree, ['switch', '--detach']);
  assert.match((await f.swarm.reap()).refused[0].reason, /not an orphaned worktree/);
  assert.equal(existsSync(lane.worktree), true); assert.equal(branchExists(f.repo, lane.branch), true);
});

for (const preflight of [false, true]) test(`landing rechecks pathless conflicts after linked tests change merge config during ${preflight ? 'preflight' : 'execution'}`, async t => {
  const f = await directorySplit(t); const script = 'enable-directory-renames.test.js';
  process.env.SWARM_TEST_CONFIG = join(f.repo, '.git/config');
  f.write(script, "const {test}=require('node:test');const {execFileSync}=require('node:child_process');test('configure merge',()=>execFileSync('git',['config','--file',process.env.SWARM_TEST_CONFIG,'merge.renames','true']));\n");
  await f.client.run('test', { id: f.id, options: { add: [`command=node --test ${script}`] } });
  if (preflight) {
    const peer = await f.item(); git(f.repo, ['branch', `swarm/${peer}`, 'main']);
    await f.client.update(peer, { field: [`swarm_branch=swarm/${peer}`, `swarm_base=${commit(f.repo, 'main')}`, 'swarm_base_ref=main'] });
    // Ensure the harmless lane runs first, independent of generated item IDs.
    const ids = [f.id, peer].sort((left, right) => left.localeCompare(right));
    const original = f.lane.branch;
    await f.client.update(ids[0], { field: [`swarm_branch=swarm/${peer}`] });
    await f.client.update(ids[1], { field: [`swarm_branch=${original}`] });
    await f.client.run('test', { id: peer, options: { add: [`command=node --test ${script}`] } });
  }
  f.save(['.agents/pm', script]); git(f.repo, ['config', 'merge.renames', 'false']);
  const base = commit(f.repo, 'main'); assert.equal(predict(f.repo, base, f.lane.branch).clean, true, 'Rename detection disabled for initial simulation');
  await assert.rejects(f.swarm.land(true), /Lane changed during landing/);
  assert.equal(commit(f.repo, 'main'), base); assert.equal(existsSync(join(f.repo, '.git/MERGE_HEAD')), false);
});
