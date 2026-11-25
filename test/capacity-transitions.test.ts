import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mutateItem, readSettings } from '@unbrained/pm-cli/sdk';
import { Capacities, CapacityRefusal, interruptLane, SharedTracker, Swarm } from '../index.ts';
import { CAPACITY_TAG, LANE_CAPACITY_FIELD } from '../src/capacity.ts';
import { interruptions } from '../src/interruption.ts';
import { readItemHistoryHead } from '../src/settings.ts';
import { runProcess } from './process-helpers.ts';
import { fixture } from './helpers.ts';
import { sharedFixture } from './shared-helpers.ts';

const bindings = ['live', 'exhausted', 'orphaned', 'unbound', 'null'] as const;
type Binding = typeof bindings[number];
const transitions = ['shared start', 'Git start', 'next', 'heartbeat', 'handoff', 'continuation with capacity',
  'continuation without capacity', 'interrupt', 'reclaim to pool', 'reclaim to agent', 'close', 'window reset',
  're-declare', 'policy change', 'native terminal edit'] as const;
type Transition = typeof transitions[number];

/** Execute the actual tracker operation with the fixture's current claimant. */
async function transitionLane(action: Transition, context: {
  owner: SharedTracker;
  receiver: SharedTracker;
  capacity: Capacities;
  id: string;
  token: string;
  capacityId: string;
  finishWindow: () => void;
  declareWindow: () => Promise<unknown>;
}) {
  const { owner, receiver, capacity, id, token, capacityId, finishWindow, declareWindow } = context;
  switch (action) {
    case 'shared start': return owner.start(id);
    case 'Git start': return owner.engine.start(id);
    case 'next': return owner.next();
    case 'heartbeat': return owner.heartbeat(id, token);
    case 'handoff': return owner.handoff(id, receiver.engine.author, 'Public checkpoint', token);
    case 'continuation with capacity': return owner.continuation(id, receiver.engine.author, token, 800, 'spare');
    case 'continuation without capacity': return owner.continuation(id, receiver.engine.author, token);
    case 'interrupt': return interruptLane(owner.engine, id, token, 'runner', 'capacity_exhausted');
    case 'reclaim to pool': return receiver.reclaim(0.001);
    case 'reclaim to agent': return receiver.reclaim(0.001, receiver.engine.author);
    case 'close': return owner.close(id, 'Fixture complete', token);
    case 'window reset': finishWindow(); return capacity.run('runner');
    case 're-declare': finishWindow(); return declareWindow();
    case 'policy change': return capacity.run('runner', { action: 'policy', else: 0 });
    case 'native terminal edit': return owner.engine.client.update(capacityId, { status: 'canceled' });
  }
}

/** Define the expected refusal without consulting the operation or its capacity read model. */
function expectedRefusal(action: Transition, binding: Binding) {
  if (action === 'interrupt' && binding !== 'live' && binding !== 'exhausted') return 'capacity_invalid';
  if (binding === 'exhausted' && ['shared start', 'Git start', 'next', 'handoff', 'reclaim to pool', 'reclaim to agent'].includes(action)) return 'capacity_exhausted';
  return undefined;
}

/** Declare an independent capacity for a targeted transition row. */
async function declareCapacity(capacity: Capacities, name: string, resetsAt: string, lanes = 1) {
  await capacity.run(name, { action: 'declare', limit: 100, unit: 'percent', window: '7d', resetsAt });
  await capacity.run(name, { action: 'policy', else: lanes });
}

test('capacity transitions keep every field coherent', async t => {
  for (const action of transitions) for (const binding of bindings) {
    await t.test(action + ' / ' + binding, async cell => {
      const f = action === 'Git start' ? await fixture(cell) : await sharedFixture(cell);
      const engine = 'swarm' in f ? f.swarm : f.shared.engine;
      const initialOwner = new SharedTracker(engine);
      const receiver = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'receiver'));
      const fresh = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'fresh-worker'));
      let now = Date.now();
      const reset = now + 3_600_000;
      const clock = cell.mock.method(Date, 'now', () => now);
      cell.after(() => clock.mock.restore());
      const capacity = new Capacities(engine);
      /** Keep a full one-lane pool meaningful for the fresh-worker check below. */
      const declare = (name: string, at: number) => capacity.run(name, {
        action: 'declare', limit: 100, unit: 'percent', window: '7d', resetsAt: new Date(at).toISOString(),
      });
      for (const name of ['runner', 'spare']) {
        await declare(name, reset);
        await capacity.run(name, { action: 'policy', else: 1 });
      }
      const corpus = await engine.corpus();
      const capacityId = corpus.items.find(item => item.tags.includes(CAPACITY_TAG) && item.id.endsWith('-runner'))!.id;
      const id = await f.item(['src/target.ts']);
      const claim = await initialOwner.start(id);
      const claimToken = action === 'next'
        ? (await initialOwner.handoff(id, 'receiver', 'Public checkpoint', claim.token)).token : claim.token;
      const owner = action === 'next' ? receiver : initialOwner;
      const orphan = action === 'shared start' ? 'retired-provider' : 'missing-provider';
      if (binding === 'orphaned' && orphan === 'retired-provider') {
        await declare(orphan, reset);
        const retired = (await engine.corpus()).items.find(item => item.id.endsWith('-' + orphan))!;
        await f.client.update(retired.id, { status: 'canceled' });
      }
      const initial = ({ live: 'runner', exhausted: 'runner', orphaned: orphan, unbound: undefined, null: null })[binding];
      if (initial !== undefined) {
        await mutateItem({
          pmRoot: f.pmRoot, settings: await readSettings(f.pmRoot), id, op: 'update', author: owner.engine.author,
          extensionFieldNames: [LANE_CAPACITY_FIELD],
          mutate(document) {
            const metadata: Record<string, unknown> = document.metadata;
            metadata[LANE_CAPACITY_FIELD] = initial;
            return { changedFields: [LANE_CAPACITY_FIELD] };
          },
        });
        assert.equal((await f.client.get(id, { depth: 'full' })).item[LANE_CAPACITY_FIELD], initial);
      }
      if (binding === 'exhausted') await interruptLane(owner.engine, id, claimToken, 'runner', 'capacity_exhausted');
      now += 60_000;
      const refusal = expectedRefusal(action, binding);
      const perform = () => transitionLane(action, {
        owner, receiver, capacity, id, token: claimToken, capacityId,
        finishWindow: () => { now = reset; },
        declareWindow: () => declare('runner', reset + 3_600_000),
      });
      if (action.startsWith('reclaim')) {
        const result = await perform() as Awaited<ReturnType<SharedTracker['reclaim']>>;
        if (refusal === undefined) assert.ok(result.recovered.some(row => row.id === id));
        else assert.equal(result.refused.find(row => row.id === id)?.code, refusal);
      } else if (refusal === undefined) await perform();
      else await assert.rejects(perform, { code: refusal });

      const { item } = await f.client.get(id, { depth: 'full' });
      assert.match(String(item.swarm_token), /^\d+$/);
      if (item.swarm_handoff !== undefined) assert.equal(JSON.parse(String(item.swarm_handoff)).token, item.swarm_token);
      const stops = interruptions(item);
      for (const stop of stops) {
        if (stop.token === null) continue;
        assert.equal(stop.token, item.swarm_token);
        assert.equal(stop.agent, item.assignee);
      }
      const dropped = action === 'close' || (refusal === undefined && action === 'reclaim to pool') ||
        (action === 'continuation without capacity' && binding === 'exhausted');
      const expected = action === 'continuation with capacity' ? 'spare' :
        !dropped && (binding === 'live' || binding === 'exhausted') && action !== 'native terminal edit' ? 'runner' : undefined;
      // Native edits and observational transitions cannot rewrite unrelated item histories.
      const rewritesLane = refusal === undefined && !['interrupt', 'window reset', 're-declare', 'policy change', 'native terminal edit'].includes(action);
      if (rewritesLane) assert.equal(item[LANE_CAPACITY_FIELD], expected);
      if (action === 'close') assert.deepEqual(await owner.close(id, 'Fixture complete', claimToken), { id, closed: true });
      if (typeof item.assignee === 'string' && item.status !== 'closed') {
        const holder = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, item.assignee));
        const continuation = await holder.readContinuation(id, String(item.swarm_token));
        assert.equal(continuation.capacity, expected ?? null);
      }

      const freshId = await f.item(['src/fresh.ts']);
      for (const name of ['runner', 'spare']) {
        if (name === 'runner' && action === 'native terminal edit') {
          await assert.rejects(capacity.run(name), { code: 'capacity_undeclared' });
          await assert.rejects(fresh.start(freshId, {}, true, name), { code: 'capacity_undeclared' });
          continue;
        }
        const view = await capacity.run(name);
        const stopped = stops.some(stop => stop.token === item.swarm_token && Date.parse(stop.resets_at) > now);
        assert.equal(view.active_lanes, Number(expected === name && !stopped));
        if (view.available_lanes > 0) {
          const claim = await fresh.start(freshId, {}, true, name);
          assert.equal(claim.capacity, name);
        } else {
          const code = view.exhausted ? 'capacity_exhausted' : view.admitted_lane_count === 0 ? 'capacity_policy_denied' : 'capacity_lanes_occupied';
          await assert.rejects(fresh.start(freshId, {}, true, name), { code });
        }
      }
    });
  }

  for (const command of ['next', 'schedule'] as const) {
    await t.test(command + ' / interrupted handoff with other ready work', async cell => {
      const f = await sharedFixture(cell);
      const capacity = new Capacities(f.shared.engine);
      const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
      await declareCapacity(capacity, 'runner', resetsAt);
      await declareCapacity(capacity, 'spare', resetsAt);
      const receiver = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'receiver'));
      const id = await f.item(['src/stopped.ts'], 1);
      const claim = await f.shared.start(id, {}, true, 'runner');
      const handoff = await f.shared.handoff(id, 'receiver', 'Public checkpoint', claim.token);
      await interruptLane(receiver.engine, id, handoff.token, 'runner', 'capacity_exhausted');
      const head = await readItemHistoryHead(f.pmRoot, id);
      const choose = (dryRun: boolean) => command === 'next'
        ? receiver.next(undefined, dryRun, undefined, 'spare')
        : receiver.schedule({ skills: [], capacity: 'spare', dryRun });
      await f.item(['src/stopped.ts']);
      for (const dryRun of [true, false]) await assert.rejects(choose(dryRun), { code: 'capacity_exhausted' });
      const ready = await f.item(['src/ready.ts']);
      const available = await readItemHistoryHead(f.pmRoot, ready);
      assert.equal((await choose(true)).selected, ready);
      assert.deepEqual(await readItemHistoryHead(f.pmRoot, ready), available);
      const assigned = await choose(false);
      assert.equal(assigned.selected, ready);
      assert.equal(assigned.capacity, 'spare');
      const stopped = (await f.client.get(id, { depth: 'full' })).item;
      assert.deepEqual([stopped.assignee, stopped.swarm_token, stopped.swarm_capacity], ['receiver', handoff.token, 'runner']);
      assert.deepEqual(await readItemHistoryHead(f.pmRoot, id), head);
      assert.equal((await capacity.run('runner')).active_lanes, 0);
      assert.equal((await capacity.run('spare')).active_lanes, 1);
    });
  }

  await t.test('next / native edit during unchanged-binding admission', async cell => {
    const f = await sharedFixture(cell);
    const receiver = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'receiver'));
    const capacity = new Capacities(f.shared.engine);
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    for (const name of ['runner', 'spare']) {
      await capacity.run(name, { action: 'declare', limit: 100, unit: 'percent', window: '7d', resetsAt });
      await capacity.run(name, { action: 'policy', else: 1 });
    }
    const id = await f.item(['src/race.ts']);
    const claim = await f.shared.start(id, {}, true, 'runner');
    const handoff = await f.shared.handoff(id, 'receiver', 'Public checkpoint', claim.token);
    const before = await readItemHistoryHead(f.pmRoot, id);
    const engine = receiver.engine;
    const author = Object.getOwnPropertyDescriptor(engine, 'author')!;
    let intervened = false;
    Object.defineProperty(engine, 'author', {
      configurable: true,
      get() {
        // The fallback is formatted after the fence read, before admitting the captured binding.
        if (!intervened && new Error().stack?.includes('at admitCapacity ')) {
          intervened = true;
          f.run('update', id, '--author', 'receiver', '--field', 'swarm_capacity=spare');
        }
        return author.value as string;
      },
    });
    try {
      await assert.rejects(receiver.next(undefined, false, undefined, 'runner,spare'), { code: 'swarm_superseded' });
    } finally {
      Object.defineProperty(engine, 'author', author);
      assert.equal(intervened, true);
    }
    const edited = await readItemHistoryHead(f.pmRoot, id);
    assert.equal(edited.length, before.length + 1);
    const resumed = await receiver.next();
    assert.equal(resumed.capacity, 'spare');
    assert.equal(resumed.token, handoff.token);
    assert.deepEqual(await readItemHistoryHead(f.pmRoot, id), edited);
  });

  await t.test('continuation / retry without a caller-supplied token', async cell => {
    const f = await sharedFixture(cell);
    const capacity = new Capacities(f.shared.engine);
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    for (const name of ['denied', 'spare']) {
      await capacity.run(name, { action: 'declare', limit: 100, unit: 'percent', window: '7d', resetsAt });
    }
    await capacity.run('spare', { action: 'policy', else: 2 });
    for (const legacy of [false, true]) {
      const id = await f.item();
      const claim = legacy ? await f.client.claim(id) : await f.shared.start(id);
      const token = 'token' in claim ? claim.token : undefined;
      const before = await readItemHistoryHead(f.pmRoot, id);
      let retry = '';
      await assert.rejects(f.shared.continuation(id, 'receiver', undefined, 800, 'denied,spare'), (error: CapacityRefusal) => {
        assert.equal(error.code, 'capacity_policy_denied');
        retry = String(error.details?.next_command);
        return true;
      });
      assert.deepEqual(await readItemHistoryHead(f.pmRoot, id), before);
      const launcher = 'pm() { "$SWARM_TEST_NODE" "$SWARM_TEST_HOST" "$@"; }\n';
      const replay = await runProcess('/bin/sh', ['-ec', launcher + retry + ' --json'], f.repo,
        { ...f.env, SWARM_TEST_NODE: process.execPath, SWARM_TEST_HOST: f.host });
      assert.equal(replay.code, 0, replay.stderr || replay.stdout);
      const packet = JSON.parse(replay.stdout);
      const { item } = await f.client.get(id, { depth: 'full' });
      assert.equal(packet.capacity, 'spare');
      assert.equal(item.assignee, 'receiver');
      assert.equal(item.swarm_token, (BigInt(token ?? '0') + 1n).toString());
      assert.equal(JSON.parse(String(item.swarm_handoff)).token, packet.token);
      assert.equal(retry.includes('--token '), !legacy);
    }
  });
});
