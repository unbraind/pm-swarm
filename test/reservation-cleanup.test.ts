import assert from 'node:assert/strict';
import { failRename } from './rename-faults.ts';
import { test } from 'node:test';
import { ResourceReservations, trackerResourceBackend } from '../index.ts';
import { peerBytes } from './history-aba-helpers.ts';
import { sharedFixture } from './shared-helpers.ts';

for (const heartbeat of [1, 2]) test(`new resource reservation releases after post-write heartbeat ${heartbeat} failure`, async t => {
  const f = await sharedFixture(t);
  const id = (await f.client.create({ type: 'Task', title: 'Public resource', tags: 'swarm-resource' })).item.id;
  const resources = new ResourceReservations(trackerResourceBackend(f.shared.engine), 'shared-test');
  let count = 0; let injected = false;
  const restore = failRename(t, (_source, destination) => {
    if (destination.includes('agent-') && ++count === heartbeat) { injected = true; return true; }
    return false;
  }, 'Injected reservation heartbeat failure');
  try { await assert.rejects(resources.reserve(id), /Injected reservation heartbeat failure/); }
  finally { restore(); }
  assert.equal(injected, true);
  const record = await resources.status(id); assert.equal(record.owner, null); assert.equal(record.expires_at, null); assert.equal(record.token, '1');
  assert.equal((await resources.reserve(id)).token, '2');
});

test('failed receipts for pre-existing reservations never release a renewal publication or successful release', async t => {
  const f = await sharedFixture(t); const reservations = new ResourceReservations(trackerResourceBackend(f.shared.engine), 'shared-test');
  for (const action of ['renew', 'publish', 'release'] as const) {
    const id = (await f.client.create({ type: 'Task', title: 'Existing public resource', tags: 'swarm-resource' })).item.id;
    const claim = await reservations.reserve(id);
    const restore = failRename(t, (_source, target) => target.includes('agent-'), 'Injected existing reservation receipt fault');
    try { await assert.rejects(action === 'publish' ? reservations.publish(id, claim.token, 'Public publication') : reservations[action](id, claim.token), /Injected existing reservation/); }
    finally { restore(); }
    const current = await reservations.status(id);
    assert.equal(current.owner, action === 'release' ? null : 'shared-test');
    assert.equal(current.token, action === 'release' ? '2' : '1');
  }
});

test('reservation cleanup preserves later same-author token or expiry transitions after a lost SDK return', async t => {
  const f = await sharedFixture(t); const reservations = new ResourceReservations(trackerResourceBackend(f.shared.engine), 'shared-test');
  for (const field of ['swarm_token', 'swarm_resource_expires_at']) {
    const id = (await f.client.create({ type: 'Task', title: 'Peer resource lineage', tags: 'swarm-resource' })).item.id;
    const value = field === 'swarm_token' ? '9' : '2099-01-01T00:00:00.000Z'; const original = f.client.update.bind(f.client); let edited = false; let preserved: string[] = [];
    f.client.update = new Proxy(original, { async apply(target, receiver, args: unknown[]) {
      const result: unknown = await Reflect.apply(target, receiver, args);
      if (!edited) { edited = true; f.run('update', id, '--field', `${field}=${value}`); preserved = peerBytes(f.pmRoot, id); throw new Error('Lost reservation return after peer update'); }
      return result;
    } });
    try { await assert.rejects(reservations.reserve(id), error => typeof error === 'object' && error !== null && 'code' in error && error.code === 'swarm_superseded'); }
    finally { Reflect.set(f.client, 'update', original); }
    assert.equal(edited, true); assert.deepEqual(peerBytes(f.pmRoot, id), preserved); const item = (await f.client.get(id)).item;
    assert.equal(item.assignee, 'shared-test'); assert.equal(item[field], value);
  }
});
