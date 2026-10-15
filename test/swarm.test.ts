import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PmClient, runTest } from '@unbrained/pm-cli/sdk';
import { fixture } from './helpers.ts';
import { fixtureGit as git } from './git-helpers.ts';
import { predict, changedFiles, branchExists, missingDrivers, commit, chain } from '../src/git.ts';
import { partition, separation, overlaps, footprintPath } from '../src/planner.ts';
import { cleanOrder, minimalConflict, maximalCleanOrder } from '../src/order.ts';
import { settings } from '../src/settings.ts';
import { Swarm } from '../src/swarm.ts';
import type { Lane } from '../src/types.ts';

/** Scan every tracked tracker artifact, including history, for a private scratch root. */
function assertPrivate(repo: string, root: string): void {
  for (const path of git(repo, ['ls-files', '-z', '.agents/pm']).split('\0').filter(Boolean)) assert.equal(readFileSync(join(repo, path), 'utf8').includes(root), false, path);
}

test('partition separates overlaps, directories, dependencies and unknown footprints', () => {
  const a = { id: 'a', files: ['src'], dependencies: [] }; const b = { id: 'b', files: ['src/a.ts'], dependencies: ['a'] };
  const c = { id: 'c', files: ['docs'], dependencies: [] }; const d = { id: 'd', files: [], dependencies: [] };
  const result = partition([a, b, c, d], 4);
  assert.deepEqual(result.lanes.map(lane => lane.items.map(item => item.id)), [['a', 'c'], ['b'], ['d']]);
  assert.deepEqual(result.suggested_start_set, ['a', 'c']);
  assert.equal(result.separations.length, 5); assert.equal(result.lanes[2].items[0].footprint, 'unknown');
  assert.equal(separation(b, a).length, 2); assert.equal(overlaps('docs/a', 'docs'), true); assert.equal(overlaps('.', 'any'), true);
  assert.equal(overlaps('a', 'ab'), false); assert.equal(overlaps('a', 'a'), true); assert.equal(overlaps('a', '.'), true);
  assert.equal(footprintPath('./src/../docs/'), 'docs'); assert.equal(footprintPath('src\\a'), 'src/a');
  for (const path of ['/private', 'C:/private', '..', '../escape', 'a\0b']) assert.throws(() => footprintPath(path), /relative/);
  assert.equal(partition([], 1).lanes.length, 0); assert.equal(partition([a, c], 1).lanes.length, 2);
});

test('plan uses SDK readiness, excludes foreign and own claims, filters parent and ignores blocked work', async t => {
  const f = await fixture(t); const a = await f.item(['src']); const b = await f.item(['src/a']); const c = await f.item();
  const parent = (await f.client.create({ type: 'Epic', title: 'Container' })).item.id;
  await f.client.update(a, { parent }); await f.client.claim(b);
  const foreign = new PmClient({ cwd: f.repo, pmRoot: f.pmRoot, author: 'foreign-test', noExtensions: true }); await foreign.claim(c);
  const blocked = await f.item(['other']); await f.client.update(blocked, { blockedBy: a });
  const unknown = await f.item();
  const result = await f.swarm.plan(); assert.equal(result.complete_list.item_count, 6); assert.deepEqual(result.lanes.flatMap(lane => lane.items.map(item => item.id)).sort(), [a, unknown].sort());
  assert.equal(result.lanes.find(lane => lane.items[0].id === unknown)?.items[0].footprint, 'unknown');
  assert.deepEqual((await f.swarm.plan(parent, 1)).suggested_start_set, [a]);
  assert.deepEqual((await f.swarm.plan('absent')).lanes, []);
  const related = [await f.item(['left']), await f.item(['right'])];
  await f.client.update(related[1], { dep: [`id=${related[0]},kind=related`] });
  const linked = await f.swarm.plan(); assert.ok(linked.separations.some(pair => pair.reasons.includes('dependency') && [pair.left, pair.right].includes(related[0])));
});

test('start claims, records portable extension fields, creates a real worktree and refuses a foreign holder', async t => {
  const f = await fixture(t); const id = await f.item(['code.txt']); f.write('code.txt', 'base\n'); f.save(['.agents/pm', 'code.txt']);
  const result = await f.swarm.start(id); assert.equal(existsSync(join(result.worktree, 'code.txt')), true);
  assert.equal((await f.client.get(id, { depth: 'full' })).item.swarm_branch, `swarm/${id}`);
  assert.equal((await f.client.get(id)).claim_state?.assignee, 'swarm-test'); assert.deepEqual(result.missing_merge_drivers, []);
  await assert.rejects(f.swarm.start(id), /already exists/);
  const other = await f.item(); await f.client.claim(other, { author: 'foreign-test' });
  await assert.rejects(f.swarm.start(other), /foreign-test/); assert.equal(branchExists(f.repo, `swarm/${other}`), false);
  f.save(); assertPrivate(f.repo, f.root);
});

test('status predicts real same-line conflicts, reports disjoint merges and footprint drift; sync defaults to preview', async t => {
  const f = await fixture(t); const ids = [await f.item(['same.txt']), await f.item(['same.txt']), await f.item(['other.txt'])];
  f.write('same.txt', 'base\n'); f.write('other.txt', 'base\n'); f.save(['.agents/pm', 'same.txt', 'other.txt']);
  for (const [i, id] of ids.entries()) {
    const lane = await f.swarm.start(id); f.write(i === 2 ? 'other.txt' : 'same.txt', `lane ${i}\n`, lane.worktree); f.save([i === 2 ? 'other.txt' : 'same.txt'], lane.worktree);
  }
  const status = await f.swarm.status(true); assert.equal(status.lanes.length, 3); assert.equal(status.predictions.length, 6);
  assert.deepEqual(status.predictions.filter(row => row.conflicts.length > 0).map(row => row.conflicts), [['same.txt']]);
  assert.equal(status.lanes[0].ahead, 1); assert.equal(status.lanes[0].behind, 0);
  await f.client.files(ids[0], { remove: ['same.txt'] });
  assert.deepEqual((await f.swarm.status()).lanes[0].footprint_drift, ['same.txt']);
  assert.deepEqual((await f.swarm.sync(ids[0])).add, ['same.txt']);
  assert.equal((await f.client.files(ids[0])).files.length, 0);
  assert.equal((await f.swarm.sync(ids[0], true)).dry_run, false); assert.deepEqual((await f.swarm.sync(ids[0], true)).add, []);
  await assert.rejects(f.swarm.sync('missing'), /No active/);
  assert.equal((await f.swarm.land()).conflicting_set.length, 2);
  f.save(); assertPrivate(f.repo, f.root);
});

test('merge-tree invokes the actual configured pm item and history merge drivers', async t => {
  const f = await fixture(t); const id = await f.item(['code.txt']); f.save(); const base = commit(f.repo, 'main');
  git(f.repo, ['switch', '-c', 'left']); await f.client.comments(id, { add: 'Left comment' }); f.save(); const left = commit(f.repo, 'left');
  git(f.repo, ['switch', '-c', 'right', base]); await f.client.comments(id, { add: 'Right comment' }); f.save();
  const result = predict(f.repo, left, commit(f.repo, 'right')); assert.deepEqual(result.conflicts, []);
  const files = git(f.repo, ['ls-tree', '-r', '--name-only', result.tree]).split('\n'); const itemPath = files.find(path => path.endsWith(`${id}.toon`)); assert.ok(itemPath);
  const merged = git(f.repo, ['show', `${result.tree}:${itemPath}`]); assert.match(merged, /Left comment/); assert.match(merged, /Right comment/);
  const history = git(f.repo, ['show', `${result.tree}:.agents/pm/history/${id}.jsonl`]); assert.match(history, /Left comment/); assert.match(history, /Right comment/);
  // A real failing driver proves merge-tree consults repository config rather than bypassing it.
  git(f.repo, ['config', 'merge.pm-item-toon.driver', 'false']);
  const refusal = predict(f.repo, left, commit(f.repo, 'right')); assert.ok(refusal.tracker_conflicts.includes(itemPath));
});

test('reap removes only merged terminal lanes, previews, and releases only own stale claims', async t => {
  const f = await fixture(t); const ids = [await f.item(), await f.item(), await f.item(), await f.item()]; f.save();
  const starts = [];
  for (const id of ids) starts.push(await f.swarm.start(id));
  // Closed unmerged lane must survive.
  f.write('pending.txt', 'pending\n', starts[2].worktree); f.save(['pending.txt'], starts[2].worktree);
  await f.client.release(ids[1]); await f.client.claim(ids[1], { author: 'foreign-test' });
  await f.client.update(ids[0], { status: 'closed', message: 'Fixture completed' }); await f.client.update(ids[1], { status: 'canceled', message: 'Fixture canceled' }); await f.client.update(ids[2], { status: 'closed', message: 'Fixture completed' });
  await f.client.claim(ids[0], { force: true }); await f.client.claim(ids[1], { author: 'foreign-test', force: true });
  const preview = await f.swarm.reap(true); assert.deepEqual(preview.removed.sort(), ids.slice(0, 2).sort()); assert.deepEqual(preview.released, [ids[0]]);
  assert.equal(existsSync(starts[0].worktree), true);
  const result = await f.swarm.reap(); assert.equal(result.removed.length, 2); assert.equal(branchExists(f.repo, starts[0].branch), false);
  assert.equal(existsSync(starts[2].worktree), true); assert.equal(existsSync(starts[3].worktree), true);
  assert.equal((await f.client.get(ids[0])).claim_state?.claimed, false); assert.equal((await f.client.get(ids[1])).claim_state?.assignee, 'foreign-test');
});

test('settings use SDK paths, reject malformed values and preserve flag precedence', async t => {
  const f = await fixture(t); assert.equal((await settings(f.pmRoot)).base, 'main');
  const path = join(f.pmRoot, 'settings.json'); const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...document, swarm: { base: 'develop', lane_limit: 2 } }));
  assert.equal((await settings(f.pmRoot)).base, 'develop'); assert.equal((await settings(f.pmRoot, { base: 'main' })).base, 'main');
  for (const limit of [0, 9, NaN, 1.2]) await assert.rejects(settings(f.pmRoot, { lane_limit: limit }), /integer/);
  for (const value of ['', '\n', 'a\0b']) await assert.rejects(settings(f.pmRoot, { base: value }), /Invalid/);
  await assert.rejects(settings(f.pmRoot, { root: 4 as unknown as string }), /Invalid/);
});

test('land backtracks to the only clean three-lane order, chains ancestry, tests each merged tree and executes locally', async t => {
  const f = await fixture(t); const ids = [await f.item(['x.txt']), await f.item(['x.txt', 'y.txt']), await f.item(['y.txt'])];
  f.write('x.txt', '0\n'); f.write('y.txt', '0\n');
  f.write('verify.test.js', "const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');test('merged source',()=>assert.equal(fs.readFileSync('x.txt','utf8'),'2\\n'));\n");
  for (const id of ids) await f.client.run('test', { id, options: { add: ['command=node --test verify.test.js'] } });
  const original = f.save(['.agents/pm', 'x.txt', 'y.txt', 'verify.test.js']);
  git(f.repo, ['switch', '-c', 'intermediate']); f.write('y.txt', '1\n'); const shared = f.save(['y.txt']);
  git(f.repo, ['switch', '-c', 'b']); f.write('x.txt', '2\n'); f.write('y.txt', '2\n'); const b = f.save(['x.txt', 'y.txt']);
  git(f.repo, ['switch', 'main']); f.write('x.txt', '1\n'); f.write('y.txt', '1\n'); const main = f.save(['x.txt', 'y.txt']);
  git(f.repo, ['switch', '-c', 'a']); f.write('x.txt', '2\n'); f.save(['x.txt']);
  const a = chain(f.repo, main, shared, git(f.repo, ['rev-parse', 'HEAD^{tree}'])); git(f.repo, ['update-ref', 'refs/heads/a', a]);
  git(f.repo, ['switch', '-c', 'c', original]); f.write('y.txt', '2\n'); const c = f.save(['y.txt']); git(f.repo, ['switch', 'main']);
  for (const [index, branch] of ['a', 'b', 'c'].entries()) await f.client.update(ids[index], { field: [`swarm_branch=${branch}`, `swarm_base=${original}`, 'swarm_base_ref=main'] });
  f.save(); const base = commit(f.repo, 'main'); const lanes = await f.swarm.lanes(); const laneA = lanes.find(lane => lane.branch === 'a')!; const laneB = lanes.find(lane => lane.branch === 'b')!; const laneC = lanes.find(lane => lane.branch === 'c')!;
  // Input begins at a dead end, so selecting the first clean branch alone is insufficient.
  const permutations = [[laneA, laneB, laneC], [laneA, laneC, laneB], [laneB, laneA, laneC], [laneB, laneC, laneA], [laneC, laneA, laneB], [laneC, laneB, laneA]];
  const clean = permutations.filter(sequence => { let current = base; for (const lane of sequence) { const merge = predict(f.repo, current, lane.sha); if (!merge.clean) return false; current = chain(f.repo, current, lane.sha, merge.tree); } return true; });
  assert.deepEqual(clean.map(sequence => sequence.map(lane => lane.branch)), [['a', 'b', 'c']]);
  const found = cleanOrder(f.repo, base, [laneC, laneB, laneA]); assert.deepEqual(found?.map(lane => lane.branch), ['a', 'b', 'c']);
  assert.equal(predict(f.repo, base, b).conflicts.length > 0, true); assert.equal(predict(f.repo, a, c).conflicts.length > 0, true);
  assert.deepEqual(minimalConflict(f.repo, base, [laneA]), []);
  const before = commit(f.repo, 'HEAD'); assert.deepEqual((await f.swarm.land()).order, ids); assert.equal(commit(f.repo, 'HEAD'), before);
  const result = await f.swarm.land(true); assert.equal(result.executed, true); assert.deepEqual(result.order, ids);
  assert.equal(git(f.repo, ['show', 'HEAD:x.txt']), '2'); assert.equal(git(f.repo, ['show', 'HEAD:y.txt']), '2'); assertPrivate(f.repo, f.root);
});


test('status and sync exclude inherited base changes after a lane updates its base', async t => {
  const f = await fixture(t); const id = await f.item(['code.txt']); f.write('code.txt', 'base\n'); f.save(['.agents/pm', 'code.txt']);
  const lane = await f.swarm.start(id); f.write('inherited.txt', 'upstream\n'); f.save(['.agents/pm', 'inherited.txt']);
  git(lane.worktree, ['merge', '--ff-only', 'main']); f.write('code.txt', 'lane\n', lane.worktree); f.save(['code.txt'], lane.worktree);
  const status = await f.swarm.status(); assert.deepEqual(status.lanes[0].changed_files, ['code.txt']); assert.deepEqual(status.lanes[0].footprint_drift, []);
  assert.deepEqual((await f.swarm.sync(id)).add, []);
});

test('status names conflicting lanes and base while full output preserves every SHA and tree', async t => {
  const f = await fixture(t); const ids = [await f.item(['same']), await f.item(['same'])];
  f.write('same', 'base\n'); f.save(['.agents/pm', 'same']);
  const starts = [];
  for (const [index, id] of ids.entries()) {
    const lane = await f.swarm.start(id); starts.push(lane);
    f.write('same', `lane ${index}\n`, lane.worktree); f.save(['same'], lane.worktree);
  }
  const compact = await f.swarm.status();
  assert.equal(compact.predictions.length, 1); assert.equal(compact.clean_pairs, 2);
  const pair = compact.predictions[0];
  assert.deepEqual([pair.left_id, pair.right_id].sort(), [...ids].sort());
  assert.equal(pair.left_branch, `swarm/${pair.left_id}`); assert.equal(pair.right_branch, `swarm/${pair.right_id}`);
  assert.deepEqual(pair.conflicts, ['same']); assert.equal('left' in pair, false); assert.equal('tree' in pair, false);
  const full = await f.swarm.status(true); assert.equal(full.predictions.length, 3);
  assert.equal(full.predictions.filter(row => row.right_id === 'base' && row.right_branch === 'main').length, 2);
  for (const row of full.predictions) { assert.ok('left' in row); assert.ok('right' in row); assert.ok('tree' in row); }
  f.write('same', 'changed base\n'); f.save(['.agents/pm', 'same']);
  assert.equal((await f.swarm.status()).predictions.filter(row => row.right_id === 'base').length, 2);
});

test('partial land maximizes the clean subset, explains blocked peers and executes only selected lanes', async t => {
  const f = await fixture(t); const ids = [await f.item(['same']), await f.item(['same']), await f.item(['other'])].sort();
  f.write('same', 'base\n'); f.write('other', 'base\n');
  f.write('pass.test.js', "const {test}=require('node:test');test('pass',()=>{});\n");
  for (const id of ids) await f.client.run('test', { id, options: { add: ['command=node --test pass.test.js'] } });
  f.save(['.agents/pm', 'same', 'other', 'pass.test.js']);
  const starts = [];
  for (const [index, id] of ids.entries()) {
    const lane = await f.swarm.start(id); starts.push(lane);
    const path = index === 2 ? 'other' : 'same'; f.write(path, `lane ${index}\n`, lane.worktree); f.save([path], lane.worktree);
  }
  f.save(); const before = commit(f.repo, 'HEAD');
  const preview = await f.swarm.land();
  assert.deepEqual(preview.order, [ids[0], ids[2]]); assert.equal(preview.exit_code, 1); assert.equal(preview.executed, false);
  assert.deepEqual(preview.conflicting_set.sort(), ids.slice(0, 2));
  assert.match(preview.blocked[0].messages.join('\n'), /CONFLICT \(content\)/);
  assert.match(preview.blocked[0].peers[0].messages.join('\n'), /CONFLICT \(content\)/);
  assert.deepEqual(preview.blocked.map(({ messages: _messages, ...row }) => ({ ...row, peers: row.peers.map(({ messages: _peerMessages, ...peer }) => peer) })), [{ id: ids[1], branch: starts[1].branch, conflicts: ['same'], peers: [{ id: ids[0], branch: starts[0].branch, conflicts: ['same'], next_step: `rebase ${starts[1].branch} after ${starts[0].branch} lands` }] }]);
  assert.equal(commit(f.repo, 'HEAD'), before);
  const blockedSha = commit(f.repo, starts[1].branch); const blockedStatus = git(starts[1].worktree, ['status', '--porcelain']);
  const execution = spawnSync(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), 'swarm', 'land', '--execute', '--json'], { cwd: f.repo, env: { ...process.env, PM_PATH: f.pmRoot, PM_AUTHOR: 'swarm-test' }, encoding: 'utf8' });
  assert.equal(execution.status, 1, execution.stderr);
  const landed = JSON.parse(execution.stdout) as typeof preview; assert.deepEqual(landed.order, preview.order); assert.equal(landed.exit_code, 1); assert.equal(landed.executed, true);
  assert.equal(git(f.repo, ['show', 'HEAD:same']), 'lane 0'); assert.equal(git(f.repo, ['show', 'HEAD:other']), 'lane 2');
  assert.equal(commit(f.repo, starts[1].branch), blockedSha); assert.equal(git(starts[1].worktree, ['status', '--porcelain']), blockedStatus);
  const retry = await f.swarm.land(); assert.equal(retry.exit_code, 1); assert.ok(retry.blocked[0].peers.some(peer => peer.id === 'base'));
});

test('maximal clean order beats a greedy prefix and handles no clean lane', async t => {
  const f = await fixture(t); f.write('x', 'base\n'); f.write('y', 'base\n'); f.save(['x', 'y']); const base = commit(f.repo, 'HEAD');
  const lanes: Lane[] = [];
  for (const id of ['a', 'b', 'c']) {
    git(f.repo, ['switch', '-c', id, base]);
    const files = id === 'a' ? ['x', 'y'] : [id === 'b' ? 'x' : 'y'];
    for (const file of files) f.write(file, `${id}\n`);
    const sha = f.save(files);
    lanes.push({ id, branch: id, sha, base, target: 'main', agent: null, files, terminal: false });
  }
  git(f.repo, ['switch', 'main']);
  assert.deepEqual(maximalCleanOrder(f.repo, base, lanes).map(lane => lane.id), ['b', 'c']);
  assert.deepEqual(maximalCleanOrder(f.repo, base, [...lanes].reverse()).map(lane => lane.id), ['b', 'c']);
  f.write('x', 'base changed\n'); f.write('y', 'base changed\n'); const moved = f.save(['x', 'y']);
  assert.deepEqual(maximalCleanOrder(f.repo, moved, lanes), []);
  assert.deepEqual(maximalCleanOrder(f.repo, moved, []), []);
});
