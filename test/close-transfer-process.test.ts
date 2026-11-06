import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLOSE_INTENT } from '../src/close-journal.ts';
import { closeProcess } from './close-recovery-helpers.ts';
import { sharedFixture } from './shared-helpers.ts';

for (const transfer of ['handoff', 'reclaim']) test(`real processes close received ${transfer} work with a durable receipt and reject the prior owner`, async t => {
  const f = await sharedFixture(t); const id = await f.item(['src/public.ts']);
  const initial = f.run('swarm', 'start', id);
  let token: string;
  if (transfer === 'handoff') token = String(f.run('swarm', 'handoff', id, '--token', String(initial.token), '--to', 'receiver', '--note', 'Public handoff').token);
  else {
    const old = new Date(Date.now() - 120000).toISOString();
    // A legacy claim has no heartbeat. Native writes age only disposable claim evidence.
    await f.client.release(id); await f.client.claim(id, { author: 'legacy-worker' });
    await f.client.update(id, { field: [`swarm_claimed_at=${old}`] });
    const moved = f.run('swarm', 'reclaim', '--stale-after', '60', '--to', 'receiver').recovered as { id: string; token: string }[];
    token = moved.find(row => row.id === id)!.token;
  }
  const stale = closeProcess(f, id, String(initial.token)); assert.equal(stale.outcome?.code, 'swarm_stale_fence');
  const received = closeProcess(f, id, token, { author: 'receiver' }); assert.equal(received.status, 0, received.stdout + received.stderr);
  const item = (await f.client.get(id, { depth: 'full' })).item;
  assert.deepEqual({ status: item.status, owner: item.assignee, generation: item.swarm_token }, { status: 'closed', owner: undefined, generation: String(BigInt(token) + 1n) });
  assert.equal(item.swarm_handoff, undefined); assert.equal(item.swarm_claimed_at, undefined);
  const journal = JSON.parse(String(item[CLOSE_INTENT])) as { phase: string; token: string };
  assert.equal(journal.phase, 'committed'); assert.equal(journal.token, token);
  assert.deepEqual(closeProcess(f, id, token, { author: 'receiver' }).outcome?.result, received.outcome?.result);
});
