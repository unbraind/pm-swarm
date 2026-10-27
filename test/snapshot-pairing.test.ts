import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitItemMutation, SettingsRefusal } from '../src/settings.ts';
import { mutationSnapshot } from '../src/inspection.ts';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { sharedFixture } from './shared-helpers.ts';
import { historyPeer, assertPeerPreserved, nativeWriters, observeSdkReturn } from './history-aba-helpers.ts';

/** Every native writer must reject ABA between its document read and decision-baseline completion. */
test('snapshot history precedes the document for every native mutation kind', async t => {
  const f = await sharedFixture(t); const peer = historyPeer(f.client, f.pmRoot); t.after(peer.destroy);
  const writers = nativeWriters(f.client);
  for (const [kind, write] of writers) await t.test(kind, async () => {
    const id = await f.item(); if (kind !== 'claim') await f.client.claim(id);
    let bytes: string[] = []; let receipt = false;
    const [attempt] = await Promise.allSettled([(async () => {
      const snapshot = await mutationSnapshot(f.pmRoot, id, async () => {
        const item = (await f.client.get(id, { depth: 'full' })).item;
        bytes = await peer.cycle(id); return item;
      });
      await commitItemMutation({ id, item: snapshot.item, options: { kind } }, admitted => write(admitted.id, snapshot.version), { history: snapshot.historyHead });
      receipt = true;
    })()]);
    assert.equal(receipt, false); assertPeerPreserved(f.pmRoot, id, bytes, attempt);
  });
});

/** The actual shared handoff must not adopt a peer's newer, byte-identical restored claim. */
test('handoff refuses a peer ABA after its actual SDK document read', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const claim = await f.shared.start(id);
  const peer = historyPeer(f.client, f.pmRoot); t.after(peer.destroy); let bytes: string[] = []; let injected = false;
  const client = observeSdkReturn(f.client, 'get', async () => {
    if (!injected) { injected = true; bytes = await peer.cycle(id); }
  });
  const shared = new SharedTracker(new Swarm(f.repo, f.pmRoot, client, 'shared-test'));
  const [attempt] = await Promise.allSettled([shared.handoff(id, 'receiver', 'Public handoff', claim.token)]);
  assert.ok(bytes.length > 0); assertPeerPreserved(f.pmRoot, id, bytes, attempt);
});

/** Runtime JavaScript consumers cannot restore the removed late-baseline fallback through missing options. */
test('item writers refuse a missing captured history head before calling the backend', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const item = (await f.client.get(id)).item;
  let called = false;
  assert.throws(() => commitItemMutation({ id, item, options: {} }, async () => { called = true; }, {} as Parameters<typeof commitItemMutation>[2]), error => error instanceof SettingsRefusal && error.code === 'swarm_input_invalid' && error.field === 'history');
  assert.equal(called, false);
});
