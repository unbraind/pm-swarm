import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkspaceTransactionInterruptedError } from '@unbrained/pm-cli/sdk';
import { closeCheckpoint, closeTrace } from '../src/close-journal.ts';
import { historySnapshot } from '../src/inspection.ts';
import { SettingsRefusal } from '../src/settings.ts';
import { sharedFixture } from './shared-helpers.ts';
import { durableSnapshot } from './privacy-snapshot.ts';

/** Persist a real interrupted SDK journal for hostile recovery-input tests. */
async function interrupt(fixture: Awaited<ReturnType<typeof sharedFixture>>, id: string, token: string): Promise<void> {
  const onTransition = (context: { transition: string }) => {
    switch (context.transition) { case 'step_recorded': throw new WorkspaceTransactionInterruptedError('Stop after native metadata'); }
  };
  await assert.rejects(fixture.shared.close(id, 'Public completion', token, { onTransition }), WorkspaceTransactionInterruptedError);
}

test('malformed journal checkpoints never become an ownership receipt', () => {
  for (const value of [null, [], {}, { version: 0, hash: 'a'.repeat(64) }, { version: 1.5, hash: 'a'.repeat(64) }, { version: 1 }, { version: 1, hash: 'bad' }]) assert.throws(() => closeCheckpoint(value), SettingsRefusal);
  assert.deepEqual(closeCheckpoint({ version: 1, hash: 'a'.repeat(64) }), { version: 1, hash: 'a'.repeat(64) });
});

test('every unverified SDK journal identity plan checkpoint or result refuses without item writes', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const receipt = await f.shared.start(id);
  await interrupt(f, id, receipt.token);
  const directory = join(f.pmRoot, 'transactions/sdk'); const path = join(directory, readdirSync(directory)[0]); const original = readFileSync(path, 'utf8');
  const cases: ((journal: Record<string, unknown>) => unknown)[] = [
    () => null, () => [], journal => ({ ...journal, schemaVersion: 9 }), journal => ({ ...journal, transactionId: 'different' }),
    journal => ({ ...journal, author: 'peer' }), journal => ({ ...journal, stepIds: null }), journal => ({ ...journal, stepIds: ['close', 'metadata'] }),
    journal => ({ ...journal, status: 'unknown' }), journal => ({ ...journal, startedStepIds: null }), journal => ({ ...journal, startedStepIds: ['foreign'] }),
    journal => ({ ...journal, compensationData: null }), journal => ({ ...journal, results: [] }), journal => ({ ...journal, compensationData: {} }),
    journal => ({ ...journal, compensationData: { metadata: { version: 1, hash: '0'.repeat(64) } } }),
    journal => ({ ...journal, compensationData: { metadata: { version: 1, hash: 'invalid' } } }),
    journal => ({ ...journal, results: { foreign: { version: 1, hash: '0'.repeat(64) } } }),
    journal => ({ ...journal, results: { metadata: { version: 1, hash: '0'.repeat(64) } } }),
    journal => ({ ...journal, status: 'committed' }),
  ];
  for (const [index, change] of cases.entries()) {
    writeFileSync(path, JSON.stringify(change(JSON.parse(original) as Record<string, unknown>)));
    const before = durableSnapshot(f.pmRoot);
    await assert.rejects(f.shared.close(id, 'Public completion', receipt.token), error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed', String(index));
    assert.equal(durableSnapshot(f.pmRoot), before, String(index));
  }
  writeFileSync(path, 'not-json'); const before = durableSnapshot(f.pmRoot);
  await assert.rejects(f.shared.close(id, 'Public completion', receipt.token), SettingsRefusal); assert.equal(durableSnapshot(f.pmRoot), before);
  writeFileSync(path, original);
  await f.shared.close(id, 'Public completion', receipt.token);
  const journal = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...journal, compensationData: {} }));
  await assert.rejects(f.shared.close(id, 'Public completion', receipt.token), SettingsRefusal);
});

test('a native same-author no-op or reverted edit is still outside the SDK transaction', async t => {
  const f = await sharedFixture(t);
  for (const count of [1, 6]) {
    const id = await f.item(); const receipt = await f.shared.start(id);
    await interrupt(f, id, receipt.token);
    for (let index = 0; index < count; index++) await f.client.update(id, { title: 'Public peer edit', message: 'Swarm close metadata' });
    const before = durableSnapshot(f.pmRoot);
    await assert.rejects(f.shared.close(id, 'Public completion', receipt.token), SettingsRefusal);
    assert.equal(durableSnapshot(f.pmRoot), before);
  }
});

test('journal-free first use and unavailable native history refuse without guessing ownership', async t => {
  const f = await sharedFixture(t); const id = await f.item();
  assert.deepEqual(await closeTrace(f.pmRoot, 'shared-test', { canonicalId: id, transactionId: 'safe-empty-journal', next: '1', resumed: false }, 'Public'), { phase: 0, snapshots: [] });
  await assert.rejects(historySnapshot(f.pmRoot, 'missing-native-item'), SettingsRefusal);
  await assert.rejects(historySnapshot(f.pmRoot, id, 9999), SettingsRefusal);
});

test('journal recovery follows SDK Plan completion semantics with and without completed steps', async t => {
  const f = await sharedFixture(t);
  for (const completedSteps of [false, true]) {
    const args = ['plan', 'create', '--title', 'Public Plan completion'];
    if (completedSteps) args.push('--step', 'Verify public work');
    const id = f.run(...args).id as string;
    if (completedSteps) f.run('plan', 'complete-step', id, '1');
    const claim = await f.shared.start(id);
    await f.shared.close(id, 'Public completion', claim.token);
    await f.shared.close(id, 'Public completion', claim.token);
    const item = (await f.client.get(id)).item;
    assert.equal(item.status, 'closed'); assert.equal(item.plan_mode, completedSteps ? 'completed' : 'draft');
  }
});
