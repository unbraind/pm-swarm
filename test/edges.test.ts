import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PmClient, runTest } from '@unbrained/pm-cli/sdk';
import { fixture } from './helpers.ts';
import { Swarm } from '../src/swarm.ts';
import { git, commit, predict, missingDrivers, branchExists } from '../src/git.ts';
import { verifyLinkedTests } from '../src/test-runner.ts';
import { settings } from '../src/settings.ts';

test('start refuses terminal lanes and rolls back newly acquired claims on Git or field failures', async t => {
  const f = await fixture(t); const closed = await f.item(); await f.client.update(closed, { status: 'canceled', message: 'Fixture canceled' });
  await assert.rejects(f.swarm.start(closed), /terminal/);
  const id = await f.item(); f.save();
  const path = join(f.root, 'lanes', `repo-${id}`); mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'occupied'), 'Keep this data');
  await assert.rejects(f.swarm.start(id, { root: join(f.root, 'lanes') }), /worktree failed/);
  assert.equal((await f.client.get(id)).claim_state?.claimed, false);
  await f.client.claim(id);
  await assert.rejects(f.swarm.start(id, { root: join(f.root, 'lanes') })); assert.equal((await f.client.get(id)).claim_state?.claimed, true);
  const native = new PmClient({ cwd: f.repo, pmRoot: f.pmRoot, author: 'swarm-test', noExtensions: true });
  await assert.rejects(new Swarm(f.repo, f.pmRoot, native, 'swarm-test').start(id), /active extension/);
  assert.equal(branchExists(f.repo, `swarm/${id}`), false);
  assert.equal((await f.client.get(id)).claim_state?.claimed, true);
  await f.client.release(id);
  await assert.rejects(new Swarm(f.repo, f.pmRoot, native, 'swarm-test').start(id));
  assert.equal((await f.client.get(id)).claim_state?.claimed, false);
});

test('lane discovery fails closed on missing base and resolves legacy target fallback', async t => {
  const f = await fixture(t); const id = await f.item(); f.save();
  await f.client.update(id, { field: ['swarm_branch=main'] });
  await assert.rejects(f.swarm.lanes(), /no base/);
  await f.client.update(id, { field: [`swarm_base=${commit(f.repo, 'HEAD')}`] });
  assert.equal((await f.swarm.lanes())[0].target, 'main');
  await assert.rejects(f.swarm.start(id), /already exists/);
  await f.client.update(id, { field: ['swarm_branch=gone'] }); assert.deepEqual(await f.swarm.lanes(), []);
  await assert.rejects(f.swarm.start(id), /already exists/);
});

test('Git failure and missing driver diagnostics remain explicit', async t => {
  const f = await fixture(t); assert.throws(() => commit(f.repo, 'absent'), /failed/); assert.throws(() => predict(f.repo, 'absent', 'main'), /unavailable/);
  git(f.repo, ['config', '--unset', 'merge.pm-item-toon.driver']); assert.ok(missingDrivers(f.repo).includes('pm-item-toon'));
  const empty = join(f.root, 'empty'); mkdirSync(empty); git(empty, ['init', '-b', 'main']); assert.deepEqual(missingDrivers(empty), ['pm merge attributes']);
  writeFileSync(join(empty, '.gitattributes'), '# No pm drivers\n'); git(empty, ['add', '.gitattributes']); git(empty, ['-c', 'user.name=SteveBot', '-c', 'user.email=1153461+unbraind@users.noreply.github.com', 'commit', '-m', 'Record attributes']); assert.deepEqual(missingDrivers(empty), ['pm merge attributes']);
  assert.equal((await settings(join(f.root, 'missing'))).base, 'main');
});

test('land refuses dirty worktrees, missing or failing tests and mismatched targets before moving base', async t => {
  const f = await fixture(t); assert.deepEqual(await f.swarm.land(true), { order: [], conflicting_set: [], executed: true });
  const id = await f.item(); f.save(); await f.swarm.start(id); const head = commit(f.repo, 'HEAD');
  await assert.rejects(f.swarm.land(true), /clean worktree/); f.save();
  await assert.rejects(f.swarm.land(true), /no linked tests/); assert.equal(commit(f.repo, 'HEAD'), commit(f.repo, 'main'));
  await f.client.run('test', { id, options: { add: ['command=node --test failing.test.js'] } });
  f.write('failing.test.js', "const {test}=require('node:test');test('fails',()=>{throw Error('fixture')});\n"); f.save(['.agents/pm', 'failing.test.js']);
  const before = commit(f.repo, 'HEAD'); await assert.rejects(f.swarm.land(true), /Linked tests failed/); assert.equal(commit(f.repo, 'HEAD'), before);
  await f.client.update(id, { field: ['swarm_base_ref=other'] }); await assert.rejects(f.swarm.land(), /configured swarm base/);
  assert.ok(head);
});

test('reap preserves dirty and mismatched worktrees and safely handles already removed registrations', async t => {
  const f = await fixture(t); const id = await f.item(); f.save(); const lane = await f.swarm.start(id);
  await f.client.update(id, { status: 'closed', message: 'Fixture completed' });
  git(f.repo, ['config', '--local', `swarm.lane.${id}`, join(f.root, 'wrong')]); assert.deepEqual((await f.swarm.reap()).removed, []);
  git(f.repo, ['config', '--local', `swarm.lane.${id}`, lane.worktree]); f.write('dirty.txt', 'preserve', lane.worktree);
  await assert.rejects(f.swarm.reap(), /worktree failed/); assert.equal(branchExists(f.repo, lane.branch), true);
  rmSync(join(lane.worktree, 'dirty.txt')); git(f.repo, ['worktree', 'remove', lane.worktree]); git(f.repo, ['config', '--local', '--unset', `swarm.lane.${id}`]);
  assert.deepEqual((await f.swarm.reap()).removed, [id]);
});

test('land bounds exhaustive search and refuses untrusted linked tests', async t => {
  const f = await fixture(t); const original = commit(f.repo, 'HEAD');
  for (let index = 0; index < 9; index++) {
    const id = await f.item(); git(f.repo, ['branch', `lane-${index}`, original]); await f.client.update(id, { field: [`swarm_branch=lane-${index}`, `swarm_base=${original}`] });
  }
  await assert.rejects(f.swarm.land(), /at most 8/);
  for (let index = 1; index < 9; index++) git(f.repo, ['branch', '-d', `lane-${index}`]);
  const id = (await f.swarm.lanes())[0].id;
  // Record through the real SDK from a different branch to create foreign provenance.
  git(f.repo, ['switch', '-c', 'authoring']);
  await f.client.run('test', { id, options: { add: ['command=node --test absent.test.js'] } });
  f.save(); git(f.repo, ['switch', 'main']); git(f.repo, ['merge', '--ff-only', 'authoring']);
  await assert.rejects(f.swarm.land(true), /untrusted/);
});


test('verification refuses an empty test run and predictor refuses unrelated histories', async t => {
  const f = await fixture(t); assert.equal(await verifyLinkedTests([], f.pmRoot), false);
  const unrelated = git(f.repo, ['-c', 'user.name=SteveBot', '-c', 'user.email=1153461+unbraind@users.noreply.github.com', 'commit-tree', git(f.repo, ['rev-parse', 'HEAD^{tree}'])], 'Unrelated fixture\n');
  assert.throws(() => predict(f.repo, commit(f.repo, 'HEAD'), unrelated), /unavailable/);
});

test('landing notices a lane ref changed by a real Git merge hook', async t => {
  const f = await fixture(t); const ids = [await f.item(), await f.item()];
  f.write('verify.test.js', "const {test}=require('node:test');test('passes',()=>{});\n");
  for (const id of ids) await f.client.run('test', { id, options: { add: ['command=node --test verify.test.js'] } });
  f.save(['.agents/pm', 'verify.test.js']);
  const lanes = [];
  for (const [index, id] of ids.entries()) { const lane = await f.swarm.start(id); f.write(`file-${index}`, 'lane\n', lane.worktree); f.save([`file-${index}`], lane.worktree); lanes.push(lane); }
  f.save(); const ordered = (await f.swarm.land()).order; const last = lanes.find(lane => lane.id === ordered[1])!;
  writeFileSync(join(f.repo, '.git/hooks/pre-merge-commit'), `#!/bin/sh\ngit update-ref refs/heads/${last.branch} HEAD\n`, { mode: 0o755 });
  await assert.rejects(f.swarm.land(true), /Lane changed during landing/);
});
