import assert from 'node:assert/strict';
import { failRename } from './rename-faults.ts';
import { test } from 'node:test';
import { ResourceReservations, trackerResourceBackend } from '../index.ts';
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
