import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { WorkspaceTransactionInterruptedError, getHistoryPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { closeWarnings, closeWarningsUnavailable, closeStepResult, closeSnapshot } from '../src/close-journal.ts';
import { historySnapshot } from '../src/inspection.ts';
import { SharedTracker } from '../src/shared-tracker.ts';
import { ITEM_MUTATION_BOUNDARIES, withItemMutationObserver, SettingsRefusal } from '../src/settings.ts';
import { rejectedCorpus, benignCorpus } from './privacy-corpus.ts';
import { sharedFixture } from './shared-helpers.ts';
import { durableSnapshot } from './privacy-snapshot.ts';
import { peerBytes, assertPeerPreserved } from './history-aba-helpers.ts';

import { nativeBytes, blockedDependent, closeClaim, closePeer } from './close-native-helpers.ts';

for (const dependency of ['blocked_by', 'dependencies'] as const) test(`swarm preserves native close and dependent lifecycle bytes for ${dependency}`, async t => {
  const f = await sharedFixture(t);
  const id = await f.item(); const dependent = await f.item(); const claim = await f.shared.start(id);
  await f.client.update(id, { blockedReason: 'Public blocker reason' });
  await f.client.update(dependent, { status: 'blocked', blockedReason: 'Awaiting public work', ...(dependency === 'blocked_by' ? { blockedBy: id } : { dep: [`id=${id},kind=blocked_by`] }) });
  const version = (await historySnapshot(f.pmRoot, id)).version;
  const dependentVersion = (await historySnapshot(f.pmRoot, dependent)).version;
  const native = await f.client.close(id, 'Public completion');
  const expected = [nativeBytes(f.pmRoot, id), nativeBytes(f.pmRoot, dependent)];
  assert.equal((await f.client.get(dependent)).item.status, 'open');
  await f.client.restore(id, String(version), { force: true });
  await f.client.restore(dependent, String(dependentVersion), { force: true });
  const result = await f.shared.close(id, 'Public completion', claim.token);
  assert.equal((await f.client.get(dependent)).item.status, 'open');
  assert.deepEqual([nativeBytes(f.pmRoot, id), nativeBytes(f.pmRoot, dependent)], expected);
  assert.deepEqual(result.warnings, native.warnings);
  assert.equal((await f.client.get(id)).item.blocked_reason, undefined);
});

test('native dependent refusal warnings survive SDK CLI JSON and TOON close receipts', async t => {
  const f = await sharedFixture(t);
  for (const format of ['sdk', 'json', 'toon'] as const) {
    const { id, claim } = await closeClaim(f); const dependent = await blockedDependent(f, id);
    // The title survives native unblock and must therefore be refused at the dependent's own sink.
    await f.client.update(dependent, { title: encodeURIComponent(['', 'home', 'private', 'dependent'].join('/')) });
    const before = peerBytes(f.pmRoot, dependent);
    if (format === 'sdk') {
      const result = await f.shared.close(id, 'Public completion', claim.token);
      assert.ok(result.warnings?.some(value => value.startsWith(`auto_unblock_failed:${dependent}:`) && value.includes('swarm_private_path')));
    } else {
      const result = f.cli('swarm', 'close', id, '--note', 'Public completion', '--token', claim.token, ...(format === 'json' ? ['--json'] : []));
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /auto_unblock_failed/); assert.match(result.stdout, /swarm_private_path/);
    }
    assert.deepEqual(peerBytes(f.pmRoot, dependent), before);
  }
});

test('blocker fields use native read-back across every interrupted close boundary and replay', async t => {
  const f = await sharedFixture(t);
  for (let boundary = 0; boundary < 7; boundary++) await t.test(String(boundary), async () => {
    const id = await f.item(); const claim = await f.shared.start(id);
    await f.client.update(id, { blockedReason: 'Public blocker reason', blockedBy: await f.item() });
    let index = 0;
    await assert.rejects(f.shared.close(id, 'Public completion', claim.token, { onTransition: () => {
      if (index++ === boundary) throw new WorkspaceTransactionInterruptedError('Interrupt native close');
    } }), WorkspaceTransactionInterruptedError);
    await new SharedTracker(f.shared.engine).close(id, 'Public completion', claim.token);
    const closed = await f.client.get(id); assert.equal(closed.item.blocked_reason, undefined); assert.equal(closed.item.blocked_by, undefined);
    const bytes = peerBytes(f.pmRoot, id);
    await new SharedTracker(f.shared.engine).close(id, 'Public completion', claim.token);
    assert.deepEqual(peerBytes(f.pmRoot, id), bytes);
  });
});

for (const stage of [0, 1, 2]) test(`forward close preserves byte-identical peer history at admission stage ${stage}`, async t => {
  const f = await sharedFixture(t);
  for (const boundary of ITEM_MUTATION_BOUNDARIES) await t.test(boundary, async () => {
    const { id, claim } = await closeClaim(f); const peer = closePeer(f, id, stage, boundary);
    const [attempt] = await Promise.allSettled([withItemMutationObserver(peer.observe, () => f.shared.close(id, 'Public completion', claim.token))]);
    assert.equal(peer.state.injected, true); assertPeerPreserved(f.pmRoot, id, peer.state.bytes, attempt);
  });
});


/** Warning receipts are SDK-owned JSON data; corrupt journals never become successful output. */
test('native close warning receipts preserve strings and refuse corrupt values', () => {
  assert.deepEqual(closeWarnings(undefined), []); assert.deepEqual(closeWarnings({}), []);
  assert.deepEqual(closeWarnings({ warnings: ['native-warning'] }), ['native-warning']);
  for (const warnings of [null, 'invalid', [42]]) assert.throws(() => closeWarnings({ warnings }));
  assert.equal(closeWarningsUnavailable(undefined), true); assert.equal(closeWarningsUnavailable({}), true);
  assert.equal(closeWarningsUnavailable({ warnings: [] }), false); assert.equal(closeWarningsUnavailable({ warnings: [], warnings_unavailable: true }), true);
});

/** Native close remains authoritative when a dependent's admitted history is superseded independently. */
test('dependent ABA is preserved and its native failure warning is returned unchanged', async t => {
  const f = await sharedFixture(t);
  for (const boundary of ITEM_MUTATION_BOUNDARIES) await t.test(boundary, async () => {
    const { id, claim } = await closeClaim(f); const dependent = await blockedDependent(f, id);
    const peer = closePeer(f, dependent, 2, boundary);
    const result = await withItemMutationObserver(peer.observe, () => f.shared.close(id, 'Public completion', claim.token));
    assert.equal(peer.state.injected, true); assert.deepEqual(peerBytes(f.pmRoot, dependent), peer.state.bytes);
    assert.ok(result.warnings?.some(value => value.startsWith(`auto_unblock_failed:${dependent}:`) && value.includes('swarm_superseded')));
    assert.equal((await f.client.get(id)).item.status, 'closed');
  });
});

/** A read-back of our own version must not adopt a later peer's native history as its baseline. */
test('historical read-back retains exactly its native history prefix', async t => {
  const f = await sharedFixture(t); const id = await f.item();
  const first = await historySnapshot(f.pmRoot, id);
  await f.client.claim(id); await f.client.release(id);
  const previous = await historySnapshot(f.pmRoot, id, first.version);
  assert.deepEqual(previous.historyHead, first.historyHead);
  assert.ok((await historySnapshot(f.pmRoot, id)).historyHead.length > previous.historyHead.length);
});

/** A lost real corpus read is a pre-write refusal, never a metadata update followed by compensation. */
test('native close admits the dependency corpus before its first item or journal write', async t => {
  const f = await sharedFixture(t); const { id, claim } = await closeClaim(f); const before = peerBytes(f.pmRoot, id); const tracker = durableSnapshot(f.pmRoot);
  const read = f.client.listAllComplete.bind(f.client); let observed = false;
  f.client.listAllComplete = new Proxy(read, { async apply(target, receiver, args: unknown[]) {
    const result: unknown = await Reflect.apply(target, receiver, args); observed = result !== undefined; throw new Error('Lost real corpus return');
  } });
  try { await assert.rejects(f.shared.close(id, 'Public completion', claim.token), /Lost real corpus return/); }
  finally { f.client.listAllComplete = read; }
  assert.equal(observed, true); assert.deepEqual(peerBytes(f.pmRoot, id), before);
  assert.equal(existsSync(join(f.pmRoot, 'transactions/sdk')), false);
  assert.equal(durableSnapshot(f.pmRoot), tracker);
});

/** Foreign missing history is not a reason to rewrite it or refuse an unrelated native closure. */
test('native close preserves an unreadable foreign history row', async t => {
  const f = await sharedFixture(t); const { id, claim } = await closeClaim(f); const foreign = await f.item();
  const history = getHistoryPath(f.pmRoot, foreign); const saved = history + '.saved'; const original = peerBytes(f.pmRoot, foreign);
  renameSync(history, saved); mkdirSync(history);
  try { await f.shared.close(id, 'Public completion', claim.token); }
  finally { rmdirSync(history); renameSync(saved, history); }
  assert.deepEqual(peerBytes(f.pmRoot, foreign), original); assert.equal((await f.client.get(id)).item.status, 'closed');
});

/** The actual SDK preimage checkpoint, rather than a predicted native document, binds close read-back. */
test('native close refuses mismatched SDK close preimage receipts', async t => {
  const f = await sharedFixture(t); const { id, claim } = await closeClaim(f); await f.shared.close(id, 'Public completion', claim.token);
  const transaction = (await f.client.get(id)).item.swarm_close_transaction;
  const path = join(f.pmRoot, 'transactions/sdk', String(transaction) + '.json'); const bytes = readFileSync(path, 'utf8');
  const journal = JSON.parse(bytes) as { compensationData: { close?: { version: number; hash: string } } };
  const checkpoint = journal.compensationData.close!;
  for (const changed of [{ ...checkpoint, version: checkpoint.version + 1 }, { ...checkpoint, hash: '0'.repeat(64) }, undefined]) {
    journal.compensationData.close = changed; writeFileSync(path, JSON.stringify(journal)); const before = durableSnapshot(f.pmRoot);
    try { await assert.rejects(f.shared.close(id, 'Public completion', claim.token), error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed'); assert.equal(durableSnapshot(f.pmRoot), before); }
    finally { writeFileSync(path, bytes); }
  }
});

/** A real peer append between two SDK history reads must retain the precise superseded refusal. */
test('native close preserves a peer between history admission and journal read-back', async t => {
  const f = await sharedFixture(t); const { id, claim } = await closeClaim(f); const history = getHistoryPath(f.pmRoot, id);
  const original = fs.readFile; let armed = false; let injected = false; let bytes: string[] = [];
  const hook = t.mock.method(fs, 'readFile', new Proxy(original, { async apply(target, receiver, args: unknown[]) {
    const value: unknown = await Reflect.apply(target, receiver, args);
    if (armed && !injected && String(args[0]) === history) {
      injected = true; const peer = f.cli('--no-extensions', 'update', id, '--title', 'Public read-back peer', '--json'); assert.equal(peer.status, 0, peer.stderr); bytes = peerBytes(f.pmRoot, id);
    }
    return value;
  } })); syncBuiltinESMExports();
  let attempt: PromiseSettledResult<unknown>;
  try { [attempt] = await Promise.allSettled([f.shared.close(id, 'Public completion', claim.token, { onTransition: context => { if (context.transition === 'step_recorded' && context.stepId === 'metadata') armed = true; } })]); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(injected, true); assertPeerPreserved(f.pmRoot, id, bytes, attempt);
});

/** A stable-history journal refusal remains its original typed error and compensates only owned metadata. */
test('native close refuses an altered SDK result during its admitted transaction', async t => {
  const f = await sharedFixture(t); const { id, claim } = await closeClaim(f); const original = peerBytes(f.pmRoot, id)[0]; let changed = false;
  await assert.rejects(f.shared.close(id, 'Public completion', claim.token, { onTransition: context => {
    if (changed || context.transition !== 'step_recorded' || context.stepId !== 'metadata') return;
    changed = true; const path = join(f.pmRoot, 'transactions/sdk', context.transactionId + '.json');
    const journal = JSON.parse(readFileSync(path, 'utf8')) as { results: { metadata: { hash: string } } }; journal.results.metadata.hash = '0'.repeat(64); writeFileSync(path, JSON.stringify(journal));
  } }), error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed');
  assert.equal(changed, true); assert.equal(peerBytes(f.pmRoot, id)[0], original);
  assert.deepEqual(await f.shared.close(id, 'Public completion', claim.token), { id, closed: true });
});

/** Resume a crash before either compensation, retaining native blocker cleanup after both restored steps. */
test('blocker fields recover from a crash at the compound compensating transition', async t => {
  const f = await sharedFixture(t); const { id, claim } = await closeClaim(f);
  await f.client.update(id, { blockedReason: 'Public blocker context' }); const baseline = (await readHistoryEntries(getHistoryPath(f.pmRoot, id), id)).length; let trapped = false;
  await assert.rejects(f.shared.close(id, 'Public completion', claim.token, { onTransition: context => {
    switch (context.transition) {
      case 'committing': throw new Error('Begin native compensation');
      case 'compensating': trapped = true; throw new WorkspaceTransactionInterruptedError('Stop before native compensations');
    }
  } }));
  assert.equal(trapped, true);
  assert.equal(f.run('swarm', 'close', id, '--note', 'Public completion', '--token', claim.token).closed, true);
  assert.equal((await f.client.get(id)).item.blocked_reason, undefined);
  const entries = await readHistoryEntries(getHistoryPath(f.pmRoot, id), id);
  assert.deepEqual(entries.slice(baseline).map(entry => entry.op), ['update', 'close', 'restore', 'restore', 'update', 'close']);
});

/** A lost native failure warning must be reported as unknown after a crash, never silently omitted. */
test('interrupted native close reports its unavailable dependency warning receipt', async t => {
  const f = await sharedFixture(t); const { id, claim } = await closeClaim(f); const dependent = await blockedDependent(f, id);
  await f.client.update(dependent, { title: encodeURIComponent(['', 'home', 'private', 'unblock'].join('/')) });
  await assert.rejects(f.shared.close(id, 'Public completion', claim.token, { onTransition: context => {
    if (context.transition === 'step_applied' && context.stepId === 'close') throw new WorkspaceTransactionInterruptedError('Stop before native warning checkpoint');
  } }), WorkspaceTransactionInterruptedError);
  const before = peerBytes(f.pmRoot, id); const foreign = peerBytes(f.pmRoot, dependent);
  const resumed = await new SharedTracker(f.shared.engine).close(id, 'Public completion', claim.token);
  assert.equal(resumed.closed, true); assert.equal(resumed.warnings_unavailable, true); assert.match(String(resumed.required), /dependent items/);
  assert.deepEqual(peerBytes(f.pmRoot, id), before); assert.deepEqual(peerBytes(f.pmRoot, dependent), foreign);
  assert.deepEqual(await f.shared.close(id, 'Public completion', claim.token), resumed);
});

/** Native warning receipts use the same private/benign content admission as every other journal sink. */
test('native warning sink refuses every private encoding and preserves benign warnings', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const snapshot = await closeSnapshot(f.pmRoot, id); const before = durableSnapshot(f.pmRoot);
  for (const [name, warning] of rejectedCorpus) assert.throws(() => closeStepResult(snapshot, [warning]), error => error instanceof SettingsRefusal && error.code === 'swarm_private_path', name);
  for (const [, warning] of benignCorpus) assert.deepEqual(closeStepResult(snapshot, [warning]), { version: snapshot.version, hash: snapshot.hash, warnings: [warning] });
  assert.equal(durableSnapshot(f.pmRoot), before);
  console.log(JSON.stringify({ native_warning_private_refusals: rejectedCorpus.length, benign_warning_admissions: benignCorpus.length, tracker_changes: 0 }));
});
