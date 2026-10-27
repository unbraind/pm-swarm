import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkspaceTransactionTransitionContext } from '@unbrained/pm-cli/sdk';
import { WorkspaceTransactionInterruptedError, readHistoryEntries, getHistoryPath } from '@unbrained/pm-cli/sdk';
import { SettingsRefusal } from '../src/settings.ts';
import { CompensationPartialRefusal } from '../src/close-compensation.ts';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { sharedFixture } from './shared-helpers.ts';
import { blockedDependent, closeClaim } from './close-native-helpers.ts';
import { peerBytes, historyPeerProcess, observeSdkReturn } from './history-aba-helpers.ts';

/** Native side effects, including each dependency representation, belong to the same compensation domain. */
async function compound(f: Awaited<ReturnType<typeof sharedFixture>>, dependents = true) {
  const { id, claim } = await closeClaim(f); const ids = [id];
  if (dependents) {
    ids.push(await blockedDependent(f, id)); const second = await f.item(); ids.push(second);
    await f.client.update(second, { status: 'blocked', blockedReason: 'Awaiting public work', dep: [`id=${id},kind=blocked_by`] });
  } const documents = ids.map(id => peerBytes(f.pmRoot, id)[0]);
  const versions = await Promise.all(ids.map(async id => (await readHistoryEntries(getHistoryPath(f.pmRoot, id), id)).length));
  return { id, claim, ids, documents, versions };
}

/** A completed recovery retains exactly one native update, compensation and successful retry. */
async function assertCompensatedOnce(f: Awaited<ReturnType<typeof sharedFixture>>, state: Awaited<ReturnType<typeof compound>>, id: string) {
  const entries = await readHistoryEntries(getHistoryPath(f.pmRoot, id), id);
  assert.deepEqual(entries.slice(state.versions[state.ids.indexOf(id)]).map(entry => entry.op), id === state.id ? ['update', 'close', 'restore', 'restore', 'update', 'close'] : ['update', 'restore', 'update']);
}

/** Trigger an ordinary post-write coordinator failure, distinct from deliberate crash injection. */
function failCommit(context: WorkspaceTransactionTransitionContext): void {
  if (context.transition === 'committing') throw new Error('Ordinary committing failure');
}

/** Observe core's coherent close result while the conservative compensation refusal preserves it. */
async function assertNativeLifecycle(f: Awaited<ReturnType<typeof sharedFixture>>, state: Awaited<ReturnType<typeof compound>>) {
  assert.equal((await f.client.get(state.id)).item.status, 'closed');
  for (const id of state.ids.slice(1)) assert.equal((await f.client.get(id)).item.status, 'open');
}
/** A typed initiating fault must never hide the native dependent compensation outcome. */
function failTypedCommit(context: WorkspaceTransactionTransitionContext): void {
  if (context.transition === 'committing') throw new SettingsRefusal('swarm_document_changed', 'Injected typed failure after native close.', 'document');
}

/** Refuse before any restore rather than exposing an incomplete multi-item rollback. */
test('ordinary committing failure refuses multi-item compensation before any restore', async t => {
  const f = await sharedFixture(t); const state = await compound(f);
  await assert.rejects(f.shared.close(state.id, 'Public completion', state.claim.token, { onTransition: failCommit }), error => error instanceof CompensationPartialRefusal && error.restored.length === 0 && state.ids.every(id => error.pending.includes(id)));
  const after = state.ids.map(id => peerBytes(f.pmRoot, id));
  await assertNativeLifecycle(f, state);
  await assert.rejects(new SharedTracker(f.shared.engine).close(state.id, 'Public completion', state.claim.token), CompensationPartialRefusal);
  assert.deepEqual(state.ids.map(id => peerBytes(f.pmRoot, id)), after);
  for (const [index, id] of state.ids.entries()) {
    assert.notEqual(after[index][0], state.documents[index]);
    const entries = await readHistoryEntries(getHistoryPath(f.pmRoot, id), id);
    assert.deepEqual(entries.slice(state.versions[index]).map(entry => entry.op), index === 0 ? ['update', 'close'] : ['update']);
  }
});

/** Once native dependents changed, the partial outcome takes precedence over the initiating typed failure. */
test('dependent compensation refusal takes precedence over an original typed SDK error', async t => {
  const f = await sharedFixture(t); const state = await compound(f);
  await assert.rejects(f.shared.close(state.id, 'Public completion', state.claim.token, { onTransition: failTypedCommit }), error => error instanceof CompensationPartialRefusal && state.ids.every(id => error.pending.includes(id)));
  await assertNativeLifecycle(f, state);
});

for (const boundary of ['compensating', 'step_compensating', 'step_compensated', 'compensated']) test(`primary-only compensation resumes at ${boundary}`, async t => {
  const f = await sharedFixture(t); const state = await compound(f, false); let interrupted = false;
  await assert.rejects(f.shared.close(state.id, 'Public completion', state.claim.token, { onTransition(context) {
    failCommit(context);
    if (!interrupted && context.transition === boundary) { interrupted = true; throw new WorkspaceTransactionInterruptedError('Interrupt full compensation'); }
  } }));
  assert.equal(interrupted, true);
  await new SharedTracker(f.shared.engine).close(state.id, 'Public completion', state.claim.token);
  const before = state.ids.map(id => peerBytes(f.pmRoot, id));
  await new SharedTracker(f.shared.engine).close(state.id, 'Public completion', state.claim.token);
  assert.deepEqual(state.ids.map(id => peerBytes(f.pmRoot, id)), before);
  for (const id of state.ids) await assertCompensatedOnce(f, state, id);
});

/** Lost native restore returns cannot duplicate a dependent restore or erase another writer's work. */
for (const lost of [0, 1]) test(`primary-only compensation lost return ${lost} resumes once`, async t => {
  const f = await sharedFixture(t); const state = await compound(f, false); let index = 0; let injected = false;
  const client = observeSdkReturn(f.client, 'restore', () => {
    if (!injected && index++ === lost) { injected = true; throw new WorkspaceTransactionInterruptedError('Lost dependent restore return'); }
  });
  const shared = new SharedTracker(new Swarm(f.repo, f.pmRoot, client, 'shared-test'));
  await assert.rejects(shared.close(state.id, 'Public completion', state.claim.token, { onTransition(context) {
    failCommit(context);
  } }));
  assert.equal(injected, true);
  await new SharedTracker(f.shared.engine).close(state.id, 'Public completion', state.claim.token);
  for (const id of state.ids) await assertCompensatedOnce(f, state, id);
});

/** Secondary ownership is a locked history comparison, not equality of its restored content. */
test('a peer dependent ABA refuses compensation before reopening its blocker', async t => {
  const f = await sharedFixture(t); const state = await compound(f);
  let bytes: string[] = []; let injected = false;
  await assert.rejects(f.shared.close(state.id, 'Public completion', state.claim.token, { onTransition(context) {
    failCommit(context);
    if (context.transition === 'step_compensating' && context.stepId === 'close' && !injected) { injected = true; const peer = historyPeerProcess(f.repo, f.pmRoot, 'shared-test', state.ids[2]); assert.equal(peer.status, 0, peer.stdout + peer.stderr); bytes = peerBytes(f.pmRoot, state.ids[2]); }
  } }));
  assert.ok(bytes.length > 0); assert.deepEqual(peerBytes(f.pmRoot, state.ids[2]), bytes);
  assert.equal((await f.client.get(state.id)).item.status, 'closed');
});

/** A single peer restore to the preimage is still a foreign history advance, never our lost compensation. */
test('a matching dependent preimage never substitutes for a compensation receipt', async t => {
  const f = await sharedFixture(t); const state = await compound(f); const dependent = state.ids[2];
  let peer: string[] | undefined;
  const [attempt] = await Promise.allSettled([f.shared.close(state.id, 'Public completion', state.claim.token, { onTransition(context) {
    failCommit(context);
    if (peer !== undefined || context.stepId !== 'close' || context.transition !== 'step_compensating') return;
    f.run('restore', dependent, String(state.versions[2]), '--force'); peer = peerBytes(f.pmRoot, dependent);
  } })]);
  assert.ok(peer); assert.deepEqual(peerBytes(f.pmRoot, dependent), peer);
  assert.equal((await f.client.get(state.id)).item.status, 'closed');
  assert.equal(attempt.status, 'rejected');
  if (attempt.status === 'rejected') assert.equal(attempt.reason.code, 'swarm_compensation_partial');
});

/** Missing native result receipts never authorize secondary rollback from matching document values. */
test('unrecorded native effects refuse uncertain compensation without reopening the blocker', async t => {
  const f = await sharedFixture(t); const state = await compound(f);
  await assert.rejects(f.shared.close(state.id, 'Public completion', state.claim.token, { onTransition(context) {
    if (context.transition === 'step_applied' && context.stepId === 'close') throw new WorkspaceTransactionInterruptedError('Lose native effect receipts');
  } }), WorkspaceTransactionInterruptedError);
  const before = state.ids.map(id => peerBytes(f.pmRoot, id));
  await assert.rejects(new SharedTracker(f.shared.engine).close(state.id, 'Public completion', state.claim.token, { onTransition(context) {
    failCommit(context);
  } }), error => error instanceof Error && 'code' in error && error.code === 'swarm_compensation_partial');
  assert.deepEqual(state.ids.map(id => peerBytes(f.pmRoot, id)), before);
});
