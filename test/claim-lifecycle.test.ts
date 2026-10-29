import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { failRename } from './rename-faults.ts';
import { join } from 'node:path';
import { test } from 'node:test';
import { sharedFixture } from './shared-helpers.ts';
import { withSwarmLease } from '../src/lease.ts';

for (const command of ['start', 'next', 'schedule'] as const) test(`shared ${command} releases only a newly acquired claim after each heartbeat failure`, async t => {
  const f = await sharedFixture(t);
  for (const priorClaim of [false, true]) for (const heartbeat of [1, 2]) {
    const id = await f.item(); if (priorClaim) await f.client.claim(id);
    let count = 0; let injected = false;
    const restore = failRename(t, (_source, target) => {
      if (!target.includes('agent-')) return false;
      injected = ++count === heartbeat; return injected;
    }, 'Injected shared heartbeat failure');
    try {
      // Selection skips already assigned items, so exercise their explicit start path.
      await assert.rejects(command === 'start' || priorClaim ? f.shared.start(id) : command === 'next' ? f.shared.next() : f.shared.schedule({ skills: [] }), /Injected shared heartbeat failure/);
    } finally { restore(); }
    assert.equal(injected, true); assert.equal((await f.client.get(id)).item.assignee, priorClaim ? 'shared-test' : undefined);
    await f.client.update(id, { status: 'canceled' });
  }
});

test('lease failure actions run before all nested releases and preserve cleanup failures', async t => {
  const f = await sharedFixture(t); const order: string[] = [];
  await assert.rejects(withSwarmLease(f.pmRoot, 'shared-test', async lease => {
    lease.onRelease(async () => { order.push('release-1'); assert.equal(existsSync(join(f.pmRoot, 'runtime/swarm/operation-pin.json')), true); });
    lease.onRelease(async () => { order.push('release-2'); throw new Error('Injected nested release failure'); });
    lease.onFailure(async () => { order.push('rollback-1'); });
    lease.onFailure(async () => { order.push('rollback-2'); throw new Error('Injected rollback failure'); });
    throw new Error('Injected operation failure');
  }), error => error instanceof AggregateError && /nested locks/.test(error.message));
  assert.deepEqual(order, ['rollback-2', 'rollback-1', 'release-2', 'release-1']);
  assert.equal(existsSync(join(f.pmRoot, 'runtime/swarm/operation-pin.json')), false);
});

test('lease failure preserves both the original refusal and its rollback failure', async t => {
  const f = await sharedFixture(t);
  await assert.rejects(withSwarmLease(f.pmRoot, 'shared-test', async lease => {
    lease.onFailure(async () => { throw new Error('Rollback fault'); }); throw new Error('Original fault');
  }), error => error instanceof AggregateError && error.errors.map(String).join(' ').includes('Original fault') && error.errors.map(String).join(' ').includes('Rollback fault'));
});

test('cleanup writes retain generation fencing after a renewal I/O failure', async t => {
  const f = await sharedFixture(t); const id = await f.item(); let cleaned = false;
  await assert.rejects(withSwarmLease(f.pmRoot, 'shared-test', async lease => {
    lease.onFailure(async () => { await lease.write(() => f.client.comments(id, { add: 'Owned cleanup completed' }), { announce: false }); cleaned = true; });
    await lease.write(() => f.client.comments(id, { add: 'Acquired resource' }));
    const restore = failRename(t, (_source, target) => target.endsWith('operation.json'), 'Injected renewal I/O failure');
    try { await delay(20); lease.assert(); }
    finally { restore(); }
  }, { renewMs: 2 }), /Injected renewal/);
  assert.equal(cleaned, true);
});
