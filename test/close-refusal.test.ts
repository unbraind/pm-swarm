import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { deriveMutationTransactionId, getHistoryPath, readHistoryEntries, PmClient } from '@unbrained/pm-cli/sdk';
import { CloseRecoveryUnsupported } from '../src/close.ts';
import { SettingsRefusal, ITEM_MUTATION_BOUNDARIES, withItemMutationObserver } from '../src/settings.ts';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { sharedFixture } from './shared-helpers.ts';
import { blockedDependent, closeClaim } from './close-native-helpers.ts';
import { durableSnapshot } from './privacy-snapshot.ts';
import { historyPeer, peerBytes } from './history-aba-helpers.ts';

/** Lose only a real native return; retain every mutation, hook and SDK lock. */
function lostClose(client: PmClient, typed: boolean): PmClient {
  const close = client.close.bind(client);
  return new Proxy(client, { get(target, key) {
    if (key === 'close') return async (...args: Parameters<typeof close>) => {
      await close(...args);
      if (typed) throw new SettingsRefusal('swarm_document_changed', 'Lost typed native return.');
      throw new Error('Lost native return.');
    };
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

for (const typed of [false, true]) test(`lost ${typed ? 'typed' : 'ordinary'} native close return refuses all repair and preserves dependents`, async t => {
  const f = await sharedFixture(t); const { id, claim } = await closeClaim(f); const dependent = await blockedDependent(f, id);
  const shared = new SharedTracker(new Swarm(f.repo, f.pmRoot, lostClose(f.client, typed), 'shared-test'));
  await assert.rejects(shared.close(id, 'Public completion', claim.token), CloseRecoveryUnsupported);
  assert.equal((await f.client.get(id)).item.status, 'closed'); assert.equal((await f.client.get(dependent)).item.status, 'open');
  const stable = durableSnapshot(f.pmRoot);
  for (const method of ['sdk', 'json', 'toon'] as const) {
    if (method === 'sdk') await assert.rejects(f.shared.close(id, 'Different retry note', claim.token), error => error instanceof CloseRecoveryUnsupported && error.item_id === id && error.journal_entry.startsWith(`history/${id}.jsonl#entry=`));
    else { const result = f.cli('swarm', 'close', id, '--note', 'Public retry', '--token', claim.token, ...(method === 'json' ? ['--json'] : [])); assert.equal(result.status, 2); assert.match(result.stdout + result.stderr, /swarm_close_recovery_unsupported/); assert.ok((result.stdout + result.stderr).includes(id)); assert.ok((result.stdout + result.stderr).includes(`history/${id}.jsonl`)); }
    assert.equal(durableSnapshot(f.pmRoot), stable);
  }
});

test('legacy valid and malformed close markers refuse without reading or modifying their targets', async t => {
  const f = await sharedFixture(t); const { id, claim } = await closeClaim(f);
  for (const marker of [deriveMutationTransactionId('public legacy close'), '../foreign-entry']) {
    await f.client.update(id, { field: [`swarm_close_transaction=${marker}`] }); const before = durableSnapshot(f.pmRoot);
    await assert.rejects(f.shared.close(id, 'Public completion', claim.token), error => error instanceof CloseRecoveryUnsupported && error.item_id === id && error.journal_entry === (marker.startsWith('..') ? 'item.swarm_close_transaction' : `transactions/sdk/${marker}.json`));
    assert.equal(durableSnapshot(f.pmRoot), before);
  }
  assert.throws(() => new CloseRecoveryUnsupported('public-item', ['', 'home', 'private', 'journal'].join('/')), error => error instanceof SettingsRefusal && error.code === 'swarm_private_path');
});

test('native close validates every local refusal before any tracker or lease change', async t => {
  const f = await sharedFixture(t); const id = await f.item(); await f.client.claim(id);
  for (const [note, token] of [['', undefined], ['Public', 'bad']] as const) {
    const before = durableSnapshot(f.pmRoot); await assert.rejects(f.shared.close(id, note, token)); assert.equal(durableSnapshot(f.pmRoot), before);
  }
  await f.client.update(id, { field: ['swarm_token=bad'] }); const broken = durableSnapshot(f.pmRoot);
  await assert.rejects(f.shared.close(id, 'Public', 'bad'), /malformed swarm_token/); assert.equal(durableSnapshot(f.pmRoot), broken);
  await f.client.update(id, { unset: ['swarm_token'], assignee: 'peer' }); const peer = durableSnapshot(f.pmRoot);
  await assert.rejects(f.shared.close(id, 'Public'), /stale.*fencing token/); assert.equal(durableSnapshot(f.pmRoot), peer);
  const disabled = new PmClient({ cwd: f.repo, pmRoot: f.pmRoot, author: 'shared-test', noExtensions: true });
  const inactive = durableSnapshot(f.pmRoot);
  await assert.rejects(new SharedTracker(new Swarm(f.repo, f.pmRoot, disabled, 'shared-test')).close(id, 'Public'), error => error instanceof SettingsRefusal && error.code === 'swarm_sdk_mismatch');
  assert.equal(durableSnapshot(f.pmRoot), inactive);
});

for (const boundary of ITEM_MUTATION_BOUNDARIES) test(`native close preserves a peer ABA at ${boundary} without a journal or restoration`, async t => {
  const f = await sharedFixture(t); const { id, claim } = await closeClaim(f); const peer = historyPeer(f.client, f.pmRoot); t.after(peer.destroy);
  let bytes: string[] = []; let injected = false;
  await assert.rejects(withItemMutationObserver(async point => {
    if (injected || point !== boundary) return; injected = true; bytes = await peer.cycle(id);
  }, () => f.shared.close(id, 'Public completion', claim.token)), error => error instanceof SettingsRefusal && error.code === 'swarm_superseded');
  assert.equal(injected, true); assert.deepEqual(peerBytes(f.pmRoot, id), bytes);
});

test('native close skips unreadable foreign rows and returns the native dependent refusal warning', async t => {
  const f = await sharedFixture(t); const { id, claim } = await closeClaim(f); const dependent = await blockedDependent(f, id);
  const history = getHistoryPath(f.pmRoot, dependent); writeFileSync(history, '{invalid foreign history}\n'); const original = readFileSync(history, 'utf8');
  const result = await f.shared.close(id, 'Public completion', claim.token);
  assert.ok(result.warnings?.some(value => value.startsWith(`auto_unblock_failed:${dependent}:`)));
  assert.equal(readFileSync(history, 'utf8'), original); assert.equal((await f.client.get(id)).item.status, 'closed');
  assert.equal(result.id, id);
});

test('natively imported terminal items without a close event require explicit inspection', async t => {
  const f = await sharedFixture(t);
  const id = (await f.client.create({ type: 'Task', title: 'Imported completed work', status: 'closed', closeReason: 'Public import evidence' })).item.id;
  assert.equal((await readHistoryEntries(getHistoryPath(f.pmRoot, id), id)).some(record => record.op === 'close'), false);
  assert.equal((await f.client.get(id)).item.status, 'closed');
  const before = durableSnapshot(f.pmRoot);
  await assert.rejects(f.shared.close(id, 'Public completion'), CloseRecoveryUnsupported);
  assert.equal(durableSnapshot(f.pmRoot), before);
});
