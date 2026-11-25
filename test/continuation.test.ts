import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimatePmOutputTokens, getHistoryPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { decodeToon, encodeToon } from '@unbrained/pm-cli/sdk/testing';
import { Capacities, SharedTracker, Swarm } from '../index.ts';
import type { ContinuationPacket } from '../index.ts';
import { sharedFixture } from './shared-helpers.ts';
import { fixture } from './helpers.ts';
import { join } from 'node:path';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fixtureGit as git } from './git-helpers.ts';
import { declareService } from './privacy-mutations.ts';

/** Declare and admit a capacity through the native SDK for fixture use. */
async function enableCapacity(capacity: Capacities, name: string) {
  await capacity.run(name, { action: 'declare', limit: 100, unit: 'percent', window: '7d', resetsAt: new Date(Date.now() + 3_600_000).toISOString() });
  await capacity.run(name, { action: 'policy', else: 1 });
}

test('non-Git continuation transfers the fence and ordered post-claim work within both formats', async t => {
  const f = await sharedFixture(t);
  const capacity = new Capacities(f.shared.engine);
  await enableCapacity(capacity, 'first');
  await enableCapacity(capacity, 'second');
  const id = await f.item(['src/initial.ts']);
  await f.client.update(id, { acceptanceCriteria: 'Parser handles empty inputs' });
  await f.client.update(id, { comment: ['Existing context before claim'] });
  const { token } = await f.shared.start(id, {}, true, 'first');
  await f.client.files(id, { add: ['src/linked.ts'] });
  await f.client.update(id, { comment: ['Implemented parser path'] });
  await f.shared.sync(id, true, ['src/synced.ts'], token);
  await f.client.run('test', { id, options: { add: ['command=node --test test/parser.test.ts'] } });
  f.run('swarm', 'interrupt', id, '--token', token, '--capacity', 'first', '--reason', 'capacity_exhausted');
  const getHistory = () => readHistoryEntries(getHistoryPath(f.pmRoot, id), id);
  const count = (await getHistory()).length;
  const options = ['swarm', 'brief', id, '--continuation', '--to', 'receiver', '--token', token, '--capacity', 'second'];
  const tooSmall = f.cli(...options, '--token-budget', '1', '--json');
  assert.equal(tooSmall.status, 2);
  assert.match(tooSmall.stdout + tooSmall.stderr, /Increase --token-budget/);
  assert.equal((await getHistory()).length, count);
  const packet = f.run(...options, '--token-budget', '1000') as unknown as ContinuationPacket;
  assert.equal(packet.token, '2');
  assert.equal(packet.capacity, 'second');
  assert.equal(packet.interruption?.capacity, 'first');
  assert.equal(packet.context.acceptance_criteria, 'Parser handles empty inputs');
  assert.equal(packet.acceptance_state, 'unverified');
  assert.deepEqual(packet.context.activity?.map(row => row.kind), ['linked_file', 'comment', 'synced_path', 'test']);
  assert.deepEqual(packet.context.files, ['src/initial.ts', 'src/linked.ts', 'src/synced.ts']);
  assert.doesNotMatch(JSON.stringify(packet.context.activity), /initial.ts|Existing context/);
  const bytes = Math.max(Buffer.byteLength(JSON.stringify(packet)), Buffer.byteLength(encodeToon(packet)));
  assert.ok(estimatePmOutputTokens(bytes + 1) <= 1000);
  assert.equal((await getHistory()).length, count + 1);
  assert.equal((await f.client.get(id)).item.assignee, 'receiver');
  assert.equal((await capacity.run('first')).reported_exhausted, true);
  assert.equal((await capacity.run('second')).active_lanes, 1);
  await assert.rejects(f.shared.heartbeat(id, token), /swarm_stale_fence/);
  const incoming = f.run('swarm', 'next', '--agent', 'receiver');
  assert.deepEqual(incoming.context, packet);

  const read = ['swarm', 'brief', id, '--continuation'];
  const committedHistory = await getHistory();
  assert.deepEqual(f.run(...read, '--agent', 'receiver', '--token', packet.token), packet);
  const toon = f.cli(...read, '--agent', 'receiver', '--token', packet.token, '--output-format', 'toon');
  assert.equal(toon.status, 0, toon.stderr);
  assert.deepEqual(decodeToon(toon.stdout), packet);
  for (const [agent, fence] of [['shared-test', packet.token], ['receiver', token]]) {
    const refused = f.cli(...read, '--agent', agent, '--token', fence, '--json');
    assert.equal(refused.status, 2);
    assert.match(refused.stdout + refused.stderr, /swarm_stale_fence/);
  }
  const smallReplay = f.cli(...read, '--agent', 'receiver', '--token', packet.token, '--token-budget', '1', '--json');
  assert.equal(smallReplay.status, 2);
  assert.match(smallReplay.stdout + smallReplay.stderr, /Increase --token-budget/);
  assert.deepEqual(await getHistory(), committedHistory);
});

test('the stopped owner can read the live continuation without transferring the claim', async t => {
  const f = await sharedFixture(t);
  await enableCapacity(new Capacities(f.shared.engine), 'first');
  const id = await f.item(['src/initial.ts']);
  const { token } = await f.shared.start(id, {}, true, 'first');
  f.run('swarm', 'interrupt', id, '--token', token, '--capacity', 'first', '--reason', 'capacity_exhausted');
  const getHistory = () => readHistoryEntries(getHistoryPath(f.pmRoot, id), id);
  const history = await getHistory();
  const packet = f.run('swarm', 'brief', id, '--agent', 'shared-test', '--token', token, '--continuation') as unknown as ContinuationPacket;
  assert.equal(packet.from, 'shared-test');
  assert.equal(packet.to, 'shared-test');
  assert.equal(packet.token, token);
  assert.equal(packet.interruption?.reason, 'capacity_exhausted');
  assert.deepEqual(await getHistory(), history);
});

test('Git continuation includes the lane commits and both tracked and untracked edits', async t => {
  const f = await fixture(t);
  const id = await f.item(['tracked.ts']);
  f.write('tracked.ts', 'base\n');
  f.save(['tracked.ts', '.agents/pm']);
  const lane = await f.swarm.start(id);
  f.write('tracked.ts', 'committed\n', lane.worktree);
  const revision = f.save(['tracked.ts'], lane.worktree);
  f.write('tracked.ts', 'uncommitted\n', lane.worktree);
  f.write('new dir/untracked.ts', 'untracked\n', lane.worktree);
  const shared = new SharedTracker(f.swarm);
  const packet = await shared.continuation(id, 'receiver', undefined, 800);
  assert.equal(packet.git_worktree_available, true);
  assert.deepEqual(packet.context.commits, [revision]);
  assert.deepEqual(packet.context.uncommitted_paths, ['tracked.ts', join('new dir', 'untracked.ts')]);
  assert.equal((await f.client.get(id)).item.swarm_branch, lane.branch);
  assert.equal((await f.client.get(id)).item.assignee, 'receiver');
  const receiver = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'receiver'));
  assert.deepEqual(await receiver.readContinuation(id, packet.token), packet);
});

test('continuation read uses current evidence after an ordinary handoff and requires a native fence', async t => {
  const f = await sharedFixture(t);
  const id = await f.item(['src/initial.ts']);
  const receiver = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'receiver'));
  await assert.rejects(receiver.readContinuation(id, 'invalid'), /Supply the decimal --token/);
  await f.client.claim(id, { author: 'receiver' });
  await assert.rejects(receiver.readContinuation(id, '1'), /swarm_stale_fence/);
  await f.client.release(id, { author: 'receiver' });
  const claim = await f.shared.start(id);
  const handoff = await f.shared.handoff(id, 'receiver', 'Ordinary handoff', claim.token);
  const packet = await receiver.readContinuation(id, handoff.token, 600);
  assert.equal(packet.from, 'receiver');
  assert.equal(packet.token_budget, 600);
  assert.deepEqual(packet.context.files, ['src/initial.ts']);
  declareService(f);
  await assert.rejects(receiver.readContinuation(id, handoff.token), /local tracker with native history/);
});


test('review missing registered Git checkout leaves continuation and status readable', async t => {
  const f = await fixture(t);
  await enableCapacity(new Capacities(f.swarm), 'runner');
  const id = await f.item(['tracked.ts']);
  const lane = await f.swarm.start(id, {}, true, 'runner');
  f.write('tracked.ts', 'committed work\n', lane.worktree);
  const revision = f.save(['tracked.ts'], lane.worktree);
  const shared = new SharedTracker(f.swarm);
  assert.equal((await f.swarm.status()).lanes[0].git_worktree_available, true);
  const gitFile = join(lane.worktree!, '.git');
  const link = readFileSync(gitFile);
  try {
    writeFileSync(gitFile, 'invalid Git registration\n');
    await assert.rejects(shared.readContinuation(id, lane.token), /git --no-optional-locks failed/);
  } finally { writeFileSync(gitFile, link); }
  renameSync(lane.worktree!, join(f.root, 'offline-checkout'));
  assert.match(git(f.repo, ['worktree', 'list', '--porcelain']), new RegExp('branch refs/heads/' + lane.branch));
  const read = await shared.readContinuation(id, lane.token);
  assert.equal(read.git_worktree_available, false);
  assert.deepEqual(read.context.commits, [revision]);
  assert.equal(read.context.uncommitted_paths, undefined);
  const { lanes } = await f.swarm.status();
  assert.equal(lanes[0].git_worktree_available, false);
  assert.deepEqual(lanes[0].changed_files, ['tracked.ts']);
  const transferred = await shared.continuation(id, 'receiver', lane.token);
  assert.equal(transferred.git_worktree_available, false);
  assert.deepEqual(transferred.context.commits, [revision]);
});
