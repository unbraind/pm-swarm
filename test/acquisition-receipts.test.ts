import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loseReturn } from './native-return-faults.ts';
import { historySnapshot } from '../src/inspection.ts';
import { StaleFenceError } from '../src/lease.ts';
import { durableSnapshot } from './privacy-snapshot.ts';
import { fixture } from './helpers.ts';
import { sharedFixture } from './shared-helpers.ts';
import { branchExists } from '../src/git.ts';
import { ResourceReservations, trackerResourceBackend } from '../index.ts';

for (const writer of ['claim', 'update'] as const) test(`Git acquisition retains its native onWrite receipt when ${writer} loses its return value`, async t => {
  const f = await fixture(t); const id = await f.item(); f.save(); const fault = loseReturn(f.client, writer); t.after(fault.restore);
  await assert.rejects(f.swarm.start(id), /swarm_partial_commit/);
  assert.equal(fault.injected(), true);
  assert.equal(branchExists(f.repo, `swarm/${id}`), false);
  const item = (await f.client.get(id)).item;
  assert.deepEqual([item.assignee, item.swarm_branch], [undefined, undefined]);
});

test('shared and resource acquisitions retain committed receipts when the SDK return is lost', async t => {
  const f = await sharedFixture(t);
  for (const resource of [false, true]) {
    const id = resource ? (await f.client.create({ type: 'Task', title: 'Public resource', tags: 'swarm-resource' })).item.id : await f.item();
    const fault = loseReturn(f.client, 'update');
    try {
      const resources = new ResourceReservations(trackerResourceBackend(f.shared.engine), 'shared-test');
      await assert.rejects(resource ? resources.reserve(id) : f.shared.start(id), /swarm_partial_commit/);
      assert.equal(fault.injected(), true); assert.equal((await f.client.get(id)).item.assignee, undefined);
      if (resource) assert.equal((await resources.status(id)).expires_at, null);
    } finally { fault.restore(); }
  }
});

test('SDK-journaled close compensates lost native returns without a partial-commit refusal', async t => {
  const f = await sharedFixture(t);
  for (const writer of ['update', 'close'] as const) {
    const id = await f.item(); const claim = await f.shared.start(id); const fault = loseReturn(f.client, writer);
    try { await assert.rejects(f.shared.close(id, 'Public completion', claim.token), /Lost native SDK return/); }
    finally { fault.restore(); }
    const restored = (await f.client.get(id)).item;
    assert.equal(fault.injected(), true); assert.equal(restored.assignee, 'shared-test'); assert.equal(restored.swarm_token, claim.token);
    await f.shared.close(id, 'Public completion', claim.token); assert.equal((await f.client.get(id)).item.status, 'closed');
  }
});

test('close recovery resumes a native compensation whose return was lost before journal recording', async t => {
  const f = await sharedFixture(t);
  for (const [boundary, returnNumber] of [['step_recorded', 1], ['committing', 1], ['committing', 2]] as const) {
    const id = await f.item(); const claim = await f.shared.start(id); const fault = loseReturn(f.client, 'restore', returnNumber); let failed = false;
    try {
      await assert.rejects(f.shared.close(id, 'Public completion', claim.token, { onTransition: context => {
        if (!failed && context.transition === boundary) { failed = true; throw new Error('Force ordinary compensation'); }
      } }));
      assert.equal(fault.injected(), true);
    } finally { fault.restore(); }
    await f.shared.close(id, 'Public completion', claim.token);
    const result = (await f.client.get(id)).item; assert.equal(result.status, 'closed'); assert.equal(result.swarm_token, '2');
  }
});

test('public acquisition receipts cannot authorize foreign or mismatched native versions', async t => {
  const f = await sharedFixture(t); const id = await f.item(); await f.client.claim(id, { author: 'peer' });
  const native = await historySnapshot(f.pmRoot, id); const expected = native.document.metadata;
  const before = durableSnapshot(f.pmRoot);
  for (const receipt of [expected, { ...expected, title: 'Forged receipt' }]) await assert.rejects(f.shared.engine.acquisitionSnapshot(id, native.version, receipt), StaleFenceError);
  assert.equal(durableSnapshot(f.pmRoot), before); assert.equal((await f.client.get(id)).item.assignee, 'peer');
});
