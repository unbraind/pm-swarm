import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimatePmOutputTokens, getHistoryPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { encodeToon } from '@unbrained/pm-cli/sdk/testing';
import { Capacities, SharedTracker } from '../index.ts';
import type { ContinuationPacket } from '../index.ts';
import { sharedFixture } from './shared-helpers.ts';
import { fixture } from './helpers.ts';
import { join } from 'node:path';

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
  const packet = f.run(...options, '--token-budget', '800') as unknown as ContinuationPacket;
  assert.equal(packet.token, '2');
  assert.equal(packet.capacity, 'second');
  assert.equal(packet.interruption?.capacity, 'first');
  assert.equal(packet.context.acceptance_criteria, 'Parser handles empty inputs');
  assert.equal(packet.acceptance_state, 'unverified');
  assert.deepEqual(packet.context.activity?.map(row => row.kind), ['linked_file', 'comment', 'synced_path', 'test']);
  assert.doesNotMatch(JSON.stringify(packet), /initial.ts|Existing context/);
  const bytes = Math.max(Buffer.byteLength(JSON.stringify(packet)), Buffer.byteLength(encodeToon(packet)));
  assert.ok(estimatePmOutputTokens(bytes + 1) <= 800);
  assert.equal((await getHistory()).length, count + 1);
  assert.equal((await f.client.get(id)).item.assignee, 'receiver');
  assert.equal((await capacity.run('first')).reported_exhausted, true);
  assert.equal((await capacity.run('second')).active_lanes, 1);
  await assert.rejects(f.shared.heartbeat(id, token), /swarm_stale_fence/);
  const incoming = f.run('swarm', 'next', '--agent', 'receiver');
  assert.deepEqual(incoming.context, packet);
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
});
