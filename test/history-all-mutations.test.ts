import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitItemMutation, ITEM_MUTATION_BOUNDARIES, withItemMutationObserver } from '../src/settings.ts';
import { historySnapshot } from '../src/inspection.ts';
import { sharedFixture } from './shared-helpers.ts';
import { historyPeer, assertPeerPreserved, nativeWriters } from './history-aba-helpers.ts';

/** Exercise every native item-writer kind behind the source inventory's 18 admitted sites. */
test('all native mutation kinds preserve peer ABA through the common admission helper', async t => {
  const f = await sharedFixture(t);
  const peer = historyPeer(f.client, f.pmRoot);
  t.after(() => peer.destroy());
  for (const [kind, write] of nativeWriters(f.client)) for (const boundary of ITEM_MUTATION_BOUNDARIES) await t.test(`${kind}/${boundary}`, async () => {
    const id = await f.item(); if (kind !== 'claim') await f.client.claim(id);
    const snapshot = await historySnapshot(f.pmRoot, id); const item = (await f.client.get(id, { depth: 'full' })).item;
    let injected = false; let bytes: string[] = [];
    const [attempt] = await Promise.allSettled([withItemMutationObserver(async step => {
      if (injected || step !== boundary) return; injected = true; bytes = await peer.cycle(id);
    }, () => commitItemMutation({ id, item, options: { kind } }, admitted => write(admitted.id, snapshot.version), { history: snapshot.historyHead }))]);
    assert.equal(injected, true); assertPeerPreserved(f.pmRoot, id, bytes, attempt);
  });
});
