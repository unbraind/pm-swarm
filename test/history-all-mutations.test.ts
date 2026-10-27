import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitItemMutation, ITEM_MUTATION_BOUNDARIES, withItemMutationObserver } from '../src/settings.ts';
import { historySnapshot } from '../src/inspection.ts';
import { sharedFixture } from './shared-helpers.ts';
import { historyPeer, assertPeerPreserved } from './history-aba-helpers.ts';

/** Exercise every native item-writer kind behind the source inventory's 18 admitted sites. */
test('all native mutation kinds preserve peer ABA through the common admission helper', async t => {
  const f = await sharedFixture(t); const peer = historyPeer(f.client, f.pmRoot); t.after(peer.destroy);
  const writers = new Map<string, (id: string, version: number) => Promise<unknown>>([
    ['update', id => f.client.update(id, { description: 'Public update' })],
    ['files', id => f.client.files(id, { add: ['src/public.ts'] })],
    ['comments', id => f.client.comments(id, { add: 'Public receipt' })],
    ['claim', id => f.client.claim(id)],
    ['release', id => f.client.release(id)],
    ['restore', (id, version) => f.client.restore(id, String(version), { force: true })],
    ['close', id => f.client.close(id, 'Public completion')],
  ]);
  for (const [kind, write] of writers) for (const boundary of ITEM_MUTATION_BOUNDARIES) await t.test(`${kind}/${boundary}`, async () => {
    const id = await f.item(); if (kind !== 'claim') await f.client.claim(id);
    const snapshot = await historySnapshot(f.pmRoot, id); const item = (await f.client.get(id, { depth: 'full' })).item;
    let injected = false; let bytes: string[] = [];
    const [attempt] = await Promise.allSettled([withItemMutationObserver(async step => {
      if (injected || step !== boundary) return; injected = true; bytes = await peer.cycle(id);
    }, () => commitItemMutation({ id, item, options: { kind } }, admitted => write(admitted.id, snapshot.version), { pmRoot: f.pmRoot }))]);
    assert.equal(injected, true); assertPeerPreserved(f.pmRoot, id, bytes, attempt);
  });
});
