import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { commitWorkspaceTransaction, deriveMutationTransactionId, WorkspaceTransactionInterruptedError, getHistoryPath } from '@unbrained/pm-cli/sdk';
import { documentFingerprint, SettingsRefusal } from '../src/settings.ts';
import { historySnapshot } from '../src/inspection.ts';
import { sharedFixture } from './shared-helpers.ts';
import { declareService } from './privacy-mutations.ts';
import { durableSnapshot } from './privacy-snapshot.ts';

/** Seed the actual old SDK protocol, stopping after it starts close but before any native close. */
async function legacyPendingClose(f: Awaited<ReturnType<typeof sharedFixture>>, id: string, token: string, note: string) {
  const transactionId = deriveMutationTransactionId(JSON.stringify({ protocol: 'swarm-close/v2', id, author: 'shared-test', token, note }));
  const checkpoint = async () => {
    const snapshot = await historySnapshot(f.pmRoot, id);
    return { version: snapshot.version, hash: createHash('sha256').update(documentFingerprint({ ...snapshot.document.metadata, body: snapshot.document.body })).digest('hex') };
  };
  await assert.rejects(commitWorkspaceTransaction({ pmRoot: f.pmRoot, transactionId, author: 'shared-test', steps: [{
    id: 'metadata', prepareCompensation: checkpoint, inspect: async () => ({ state: 'pending' }),
    async apply() { await f.client.update(id, { field: [`swarm_token=${BigInt(token) + 1n}`, `swarm_close_transaction=${transactionId}`], unset: ['assignee', 'swarm_handoff'] }); return checkpoint(); },
    async compensate() { throw new Error('Legacy fixture never restores'); },
  }, { id: 'close', prepareCompensation: checkpoint, inspect: async () => ({ state: 'pending' }),
    async apply() { throw new WorkspaceTransactionInterruptedError('Stop before legacy native close'); },
    async compensate() { throw new Error('Legacy fixture never restores'); },
  }] }), WorkspaceTransactionInterruptedError);
  return transactionId;
}

test('an unrelated same-author native close is never adopted from a pending legacy SDK journal', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const claim = await f.shared.start(id); const note = 'Public completion';
  const transaction = await legacyPendingClose(f, id, claim.token, note);
  await f.client.close(id, 'Independent native completion');
  const before = durableSnapshot(f.pmRoot);
  await assert.rejects(f.shared.close(id, note, claim.token), error => error instanceof SettingsRefusal && error.code === 'swarm_close_recovery_unsupported' && error.remedy.includes(id) && error.remedy.includes(transaction));
  assert.equal(durableSnapshot(f.pmRoot), before, 'recovery must not rewrite peer state or its journal');
});

test('short IDs use native canonical resolution before history when local inspection is unavailable', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const claim = await f.shared.start(id); declareService(f);
  const before = readFileSync(getHistoryPath(f.pmRoot, id), 'utf8'); const short = id.split('-').at(-1)!;
  assert.deepEqual(await f.shared.close(short, 'Public native completion', claim.token), { id, closed: true });
  const after = readFileSync(getHistoryPath(f.pmRoot, id), 'utf8'); assert.ok(after.startsWith(before));
  assert.equal(after.trim().split('\n').length, before.trim().split('\n').length + 1);
  const stable = durableSnapshot(f.pmRoot);
  await assert.rejects(f.shared.close(short, 'Retry under a different note', claim.token), error => error instanceof SettingsRefusal && error.code === 'swarm_close_recovery_unsupported');
  assert.equal(durableSnapshot(f.pmRoot), stable);
});

test('a peer reopening a previously closed item cannot turn recovery into another fresh close', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const claim = await f.shared.start(id);
  const initial = await historySnapshot(f.pmRoot, id);
  await f.client.close(id, 'Independent native completion');
  await f.client.restore(id, String(initial.version), { force: true });
  assert.equal((await f.client.get(id)).item.status, 'open'); const before = durableSnapshot(f.pmRoot);
  await assert.rejects(f.shared.close(id, 'Public completion', claim.token), error => error instanceof SettingsRefusal && error.code === 'swarm_close_recovery_unsupported');
  assert.equal(durableSnapshot(f.pmRoot), before);
});
