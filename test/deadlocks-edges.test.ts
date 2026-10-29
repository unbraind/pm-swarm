import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { ResourceDeadlocks, Swarm, RESOURCE_TAG, RESOURCE_REQUEST_FIELD, withDeadlockObserver, parseResourceRequest } from '../index.ts';
import { sharedFixture } from './shared-helpers.ts';
import { declareService } from './privacy-mutations.ts';

/** Seed previously supported native resource fields through the actual SDK. */
async function nativeResource(f: Awaited<ReturnType<typeof sharedFixture>>, index: number, owner = `worker-${index}`, targets: string[] = []) {
  const id = `shared-test-slot-${index}`;
  return (await f.client.create({ id, type: 'Task', title: 'Native slot', tags: RESOURCE_TAG, parent: 'none', assignee: owner, field: ['swarm_token=1', `swarm_resource_expires_at=${new Date(Date.now() + 3600000).toISOString()}`, `${RESOURCE_REQUEST_FIELD}=${JSON.stringify(parseResourceRequest({ version: 1, token: '1', resources: targets }))}`] })).item.id;
}

/** Bind independent holders and their real SDK witness engine once for race scenarios. */
async function edgeFixture(t: Parameters<typeof sharedFixture>[0]) {
  const f = await sharedFixture(t);
  const a = await nativeResource(f, 0); const b = await nativeResource(f, 1);
  return { f, a, b, w: new ResourceDeadlocks(new Swarm(f.repo, f.pmRoot, f.client, 'worker-0')) };
}

test('bounded detection refuses oversized topology instead of producing an incomplete negative', async t => {
  const f = await sharedFixture(t); const w = new ResourceDeadlocks(f.shared.engine);
  // Forty owners with sixteen distinct next-resource requests each produce 640 real wait edges.
  for (let i = 0; i < 40; i++) await nativeResource(f, i, `worker-${i}`, Array.from({ length: 16 }, (_, j) => `shared-test-slot-${(i + j + 1) % 40}`));
  await assert.rejects(w.detect(), { code: 'deadlock_limit' });
  for (let i = 40; i < 129; i++) await nativeResource(f, i);
  await assert.rejects(w.detect(), /at most 128 resources/);
});

test('foreign request damage is isolated and same-owner requests are already satisfied', async t => {
  const f = await sharedFixture(t); const a = await nativeResource(f, 0); const b = await nativeResource(f, 1, 'worker-0', [a]);
  const w = new ResourceDeadlocks(new Swarm(f.repo, f.pmRoot, f.client, 'worker-0'));
  assert.deepEqual((await w.detect()).edges, []);
  await f.client.update(a, { field: [`${RESOURCE_REQUEST_FIELD}=${' '.repeat(4097)}`] });
  assert.equal((await w.inspect(a)).request, null);
  assert.ok((await w.detect()).skipped.some(row => row.id === a && row.reason === 'invalid_or_foreign_request'));
  await f.client.update(b, { field: ['swarm_token=damaged'] });
  assert.ok((await w.detect()).skipped.some(row => row.id === b && row.reason === 'inactive_or_expired'));
  declareService(f);
  await assert.rejects(w.inspect(a), { code: 'deadlock_backend' });
  await assert.rejects(w.detect(), { code: 'deadlock_backend' });
});

test('request and observation revalidate every dependent revision and detect superseding success', async t => {
  const { f, a, b, w } = await edgeFixture(t);
  const peer = new AsyncResource('deadlock-edge-peer'); t.after(() => peer.emitDestroy());
  const input = { version: 1, token: '1', resources: [b] };
  for (const apply of [false, true]) {
    const revision = (await w.inspect(a)).revision;
    await assert.rejects(withDeadlockObserver(async boundary => {
      if (boundary === 'validated') await peer.runInAsyncScope(() => f.client.update(b, { title: `Peer ${apply}` }));
    }, () => w.request(a, input, revision, apply)), { code: 'swarm_superseded' });
  }
  const revision = (await w.inspect(a)).revision;
  await assert.rejects(withDeadlockObserver(async boundary => {
    if (boundary === 'committed') await peer.runInAsyncScope(() => f.client.update(a, { field: [`${RESOURCE_REQUEST_FIELD}=${JSON.stringify({ ...input, resources: [] })}`] }));
  }, () => w.request(a, input, revision, true)), { code: 'deadlock_stale' });
  assert.deepEqual((await w.inspect(a)).request, { ...input, resources: [] }, 'The peer withdrawal is preserved');
  await assert.rejects(withDeadlockObserver(async boundary => {
    if (boundary === 'observed') await f.client.update(b, { title: 'Changed during observation' });
  }, () => w.detect()), { code: 'deadlock_stale' });
  const current = await w.inspect(a);
  await assert.rejects(w.request(a, { ...input, resources: ['slot-1'] }, current.revision), { code: 'deadlock_invalid' });
  await assert.rejects(w.request(a, input, current.revision, 'yes' as unknown as boolean), { code: 'deadlock_invalid' });
  await f.client.update(a, { field: [`swarm_resource_expires_at=${new Date(Date.now() + 1000).toISOString()}`] });
  const expiring = await w.inspect(a);
  await assert.rejects(withDeadlockObserver(async boundary => { if (boundary === 'validated') await delay(1100); }, () => w.request(a, input, expiring.revision)), { code: 'deadlock_stale' });
  await assert.rejects(withDeadlockObserver(boundary => { if (boundary === 'observed') declareService(f); }, () => w.detect()), { code: 'deadlock_stale' });
});


test('ordinary writers changing fences after history checks refuse before preview or publication', async t => {
  const { f, a, b, w } = await edgeFixture(t);
  const peer = new AsyncResource('last-read-peer'); t.after(() => peer.emitDestroy());
  for (const change of [{ field: ['swarm_token=2'] }, { assignee: 'peer-worker' }]) {
    await f.client.update(a, { field: ['swarm_token=1'], assignee: 'worker-0' });
    const revision = (await w.inspect(a)).revision;
    let injected = false;
    await assert.rejects(withDeadlockObserver(async boundary => {
      if (boundary !== 'checked' || injected) return;
      injected = true;
      await peer.runInAsyncScope(() => f.client.update(a, change));
    }, () => w.request(a, { version: 1, token: '1', resources: [b] }, revision)), { code: 'deadlock_stale' });
    assert.equal(injected, true);
  }
});
