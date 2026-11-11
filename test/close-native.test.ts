import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sharedFixture } from './shared-helpers.ts';
import { blockedDependent, closeClaim, nativeBytes, nativeCloseOracle } from './close-native-helpers.ts';
import { peerBytes } from './history-aba-helpers.ts';
import { CLOSE_INTENT } from '../src/close-journal.ts';
import { documentFingerprint } from '../src/settings.ts';
for (const dependency of ['blocked_by', 'dependencies'] as const) test(`swarm preserves native close and dependent lifecycle bytes for ${dependency}`, async t => {
  const f = await sharedFixture(t);
  const id = await f.item(); const dependent = await f.item(); const claim = await f.shared.start(id);
  await f.client.update(id, { blockedReason: 'Public blocker reason' });
  await f.client.update(dependent, { status: 'blocked', blockedReason: 'Awaiting public work', ...(dependency === 'blocked_by' ? { blockedBy: id } : { dep: [`id=${id},kind=blocked_by`] }) });
  const { root: nativeRoot, client: oracle, result: native } = await nativeCloseOracle(f, id, 'Public completion');
  const expected = [nativeBytes(nativeRoot, id), nativeBytes(nativeRoot, dependent)];
  assert.equal((await oracle.get(dependent)).item.status, 'open');
  const result = await f.shared.close(id, 'Public completion', claim.token);
  assert.equal((await f.client.get(dependent)).item.status, 'open');
  assert.deepEqual([nativeBytes(f.pmRoot, id), nativeBytes(f.pmRoot, dependent)], expected);
  assert.deepEqual(result.warnings, native.warnings);
  assert.equal((await f.client.get(id)).item.blocked_reason, undefined);
});

test('native Plan closure policy and warnings survive durable swarm completion', async t => {
  const f = await sharedFixture(t);
  const created = await f.client.plan('create', undefined, { title: 'Native close policy', step: ['Public completed criterion'] });
  const id = created.plan.id; const view = await f.client.get(id, { depth: 'full' });
  assert.ok('item' in view);
  for (const step of view.item.plan_steps!) await f.client.plan('complete-step', id, { stepEvidence: 'Public verified result' }, step.id);
  const held = await f.shared.start(id); const oracle = await nativeCloseOracle(f, id, 'Plan complete');
  const receipt = await f.shared.close(id, 'Plan complete', held.token);
  const actual = await f.client.get(id, { depth: 'full' }); const expected = await oracle.client.get(id, { depth: 'full' });
  assert.ok('item' in actual && 'item' in expected);
  /** Keep native Plan fields intact while comparing independently generated clocks and explicit swarm metadata. */
  const policy = (item: Record<string, unknown>) => documentFingerprint(Object.fromEntries(Object.entries(item).filter(([key]) => !['updated_at', 'closed_at', 'completed_at', CLOSE_INTENT, 'swarm_token', 'swarm_claimed_at'].includes(key))));
  assert.equal(policy(actual.item), policy(expected.item)); assert.deepEqual(receipt.warnings ?? [], oracle.result.warnings);
  assert.equal(actual.item.swarm_token, String(BigInt(held.token) + 1n));
  assert.equal(JSON.parse(String(actual.item[CLOSE_INTENT])).phase, 'committed');
});

test('native dependent refusal warnings survive SDK CLI JSON and TOON close receipts', async t => {
  const f = await sharedFixture(t);
  for (const format of ['sdk', 'json', 'toon'] as const) {
    const { id, claim } = await closeClaim(f); const dependent = await blockedDependent(f, id);
    // The title survives native unblock and must therefore be refused at the dependent's own sink.
    await f.client.update(dependent, { title: encodeURIComponent(['', 'home', 'private', 'dependent'].join('/')) });
    const before = peerBytes(f.pmRoot, dependent);
    if (format === 'sdk') {
      const result = await f.shared.close(id, 'Public completion', claim.token);
      assert.ok(result.warnings?.some(value => value.startsWith(`auto_unblock_failed:${dependent}:`) && value.includes('swarm_private_path')));
    } else {
      const result = f.cli('swarm', 'close', id, '--note', 'Public completion', '--token', claim.token, ...(format === 'json' ? ['--json'] : []));
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /auto_unblock_failed/); assert.match(result.stdout, /swarm_private_path/);
    }
    assert.deepEqual(peerBytes(f.pmRoot, dependent), before);
  }
});
