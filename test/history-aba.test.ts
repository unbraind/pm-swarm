import { readFileSync, renameSync, existsSync, writeFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { getHistoryPath, getItemPath } from '@unbrained/pm-cli/sdk';
import { recoveryItem } from '../src/recovery.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ITEM_MUTATION_BOUNDARIES, withItemMutationObserver, commitItemMutation, readItemHistoryHead } from '../src/settings.ts';
import { loseReturn } from './native-return-faults.ts';
import { sharedFixture } from './shared-helpers.ts';
import { fixture } from './helpers.ts';
import { ResourceReservations, trackerResourceBackend, SharedTracker } from '../index.ts';
import { historyPeer, peerBytes, assertSuperseded, gitResources, prepareTerminalHistoryLane, claimedHistoryFixture, assertPeerPreserved } from './history-aba-helpers.ts';

test('all shared acquisitions preserve byte-identical peer reclaims at every native admission boundary', async t => {
  const f = await sharedFixture(t); const peer = historyPeer(f.client, f.pmRoot); t.after(peer.destroy);
  for (const kind of ['start', 'next', 'schedule', 'reserve'] as const) for (const boundary of ITEM_MUTATION_BOUNDARIES) await t.test(`${kind}:${boundary}`, async () => {
    const id = kind === 'reserve' ? (await f.client.create({ type: 'Task', title: 'History resource', tags: 'swarm-resource' })).item.id : await f.item([`src/history-${kind}-${boundary}.ts`]); let injected = false; let bytes: string[] = []; let attempt: PromiseSettledResult<unknown>;
    const fault = loseReturn(f.client, 'update');
    try {
      [attempt] = await Promise.allSettled([withItemMutationObserver(async step => {
        if (!fault.injected() || injected || step !== boundary) return;
        injected = true; bytes = await peer.cycle(id);
      }, () => kind === 'start' ? f.shared.start(id) : kind === 'next' ? f.shared.next() : kind === 'schedule' ? f.shared.schedule({ skills: [] }) : new ResourceReservations(trackerResourceBackend(f.shared.engine), 'shared-test').reserve(id))]);
    } finally { fault.restore(); }
    assert.equal(injected, true); assert.deepEqual(peerBytes(f.pmRoot, id), bytes);
    assert.equal((await f.client.get(id)).item.assignee, 'shared-test'); assertSuperseded(attempt);
  });
  console.log(JSON.stringify({ history_aba_seed: '0xaba47129', shared_cases: 4 * ITEM_MUTATION_BOUNDARIES.length, peer_claims_cleared: 0 }));
});

for (const mode of ['Git', 'shared'] as const) test(`${mode} terminal recovery preserves byte-identical peer history at every admission boundary`, async t => {
  const f = mode === 'Git' ? await fixture(t) : await sharedFixture(t); const peer = historyPeer(f.client, f.pmRoot); const engine = 'swarm' in f ? f.swarm : f.shared; t.after(peer.destroy);
  for (const boundary of ITEM_MUTATION_BOUNDARIES) await t.test(boundary, async () => {
    const id = await f.item([`src/terminal-${boundary}.ts`]);
    await prepareTerminalHistoryLane(f, id);
    let injected = false; let bytes: string[] = []; let resources: string[] = [];
    const [attempt] = await Promise.allSettled([withItemMutationObserver(async step => {
      if (injected || step !== boundary) return; injected = true; bytes = await peer.cycle(id); if ('swarm' in f) resources = gitResources(f.repo);
    }, () => engine.reap())]);
    assert.equal(injected, true); assertPeerPreserved(f.pmRoot, id, bytes, attempt, 'swarm' in f ? { repo: f.repo, resources } : undefined);
    await f.client.release(id); if ('swarm' in f) await f.swarm.reap();
  });
});

for (const mode of ['Git', 'shared'] as const) test(`${mode} stale-claim recovery reports identical peer history as superseded at every boundary`, async t => {
  const f = mode === 'Git' ? await fixture(t) : await sharedFixture(t); const peer = historyPeer(f.client, f.pmRoot); t.after(peer.destroy);
  const recovery = 'swarm' in f ? new SharedTracker(f.swarm) : f.shared;
  for (const boundary of ITEM_MUTATION_BOUNDARIES) await t.test(boundary, async () => {
    const id = await f.item([`src/stale-${boundary}.ts`]);
    await f.client.update(id, { assignee: 'previous-worker', field: ['swarm_token=1', 'swarm_claimed_at=2000-01-01T00:00:00.000Z'] });
    let injected = false; let bytes: string[] = [];
    const result = await withItemMutationObserver(async step => {
      if (injected || step !== boundary) return; injected = true; bytes = await peer.cycle(id);
    }, () => recovery.reclaim(1, 'receiver'));
    assert.equal(injected, true); assert.deepEqual(peerBytes(f.pmRoot, id), bytes);
    assert.deepEqual(result.recovered, []); assert.equal(result.refused.find(row => row.id === id)?.code, 'swarm_superseded'); await f.client.release(id, { force: true });
  });
});

test('locked history CAS checks record identity even when its expected length matches', async t => {
  const { f, id, item } = await claimedHistoryFixture(t); const head = await readItemHistoryHead(f.pmRoot, id); const before = peerBytes(f.pmRoot, id);
  const [attempt] = await Promise.allSettled([commitItemMutation({ id, item, options: { author: 'shared-test' } }, admitted => f.client.release(admitted.id, admitted.options), { history: { ...head, hash: '0'.repeat(64) } })]);
  assert.deepEqual(peerBytes(f.pmRoot, id), before); assertSuperseded(attempt);
});

for (const damage of ['missing history', 'divergent document', 'unreadable document'] as const) test(`recovery preserves foreign ${damage} and reports a reason`, async t => {
  const { f, id, item } = await claimedHistoryFixture(t); const path = getItemPath(f.pmRoot, 'Task', id); const history = getHistoryPath(f.pmRoot, id);
  const original = readFileSync(path, 'utf8'); const bytes = readFileSync(history, 'utf8'); const refused: { id: string; reason: string }[] = [];
  if (damage === 'missing history') renameSync(history, `${history}.fixture`);
  else writeFileSync(path, damage === 'divergent document' ? original.replace(String(item.title), 'Unrecorded foreign title') : 'Invalid foreign document');
  const foreign = readFileSync(path, 'utf8');
  try {
    assert.equal(await recoveryItem(f.client, item, refused, f.pmRoot), undefined);
    assert.equal(refused.length, 1); assert.match(refused[0].reason, /preserve/i); assert.equal(readFileSync(path, 'utf8'), foreign);
    if (damage === 'missing history') assert.equal(existsSync(history), false); else assert.equal(readFileSync(history, 'utf8'), bytes);
  } finally { if (damage === 'missing history') renameSync(`${history}.fixture`, history); }
});

test('an unreadable native history head refuses with a typed preservation remedy', async t => {
  const { f, id } = await claimedHistoryFixture(t); const history = getHistoryPath(f.pmRoot, id); const before = peerBytes(f.pmRoot, id);
  renameSync(history, `${history}.fixture`); mkdirSync(history);
  try { await assert.rejects(readItemHistoryHead(f.pmRoot, id), error => error instanceof Error && 'code' in error && error.code === 'swarm_superseded'); }
  finally { rmdirSync(history); renameSync(`${history}.fixture`, history); }
  assert.deepEqual(peerBytes(f.pmRoot, id), before);
});
