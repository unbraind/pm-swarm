import assert from 'node:assert/strict';
import { test } from 'node:test';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { getHistoryPath, getItemPath, runWithAgentSessionContext } from '@unbrained/pm-cli/sdk';
import { CLOSE_INTENT, captureCloseMember, closeEpisode, discoverCloseJournal, withCloseObserver } from '../src/close-journal.ts';
import { compensateClose, prepareClose, replayCommittedClose, replayCompensatedClose } from '../src/close-recovery.ts';
import { withSwarmLease } from '../src/lease.ts';
import { retainFailureCause } from '../src/failure-cause.ts';
import { appendCopiedClosePhase, closeBytes, pendingClose, recoveryFixture } from './close-recovery-helpers.ts';
import type { CloseJournal } from '../src/close-journal.ts';
import { recordCloseProposal } from '../src/close-proofs.ts';
import { commitItemMutation } from '../src/settings.ts';

/** Walk non-enumerable native wrappers without requiring a particular number of admission layers. */
function hasCause(outcome: unknown, expected: unknown): boolean {
  const seen = new Set<unknown>();
  while (outcome instanceof Error && !seen.has(outcome)) {
    if (outcome === expected) return true;
    seen.add(outcome); outcome = outcome.cause;
  }
  return outcome === expected;
}

test('failure provenance is private and never overwrites a recovery cause or non-Error outcome', () => {
  const native = new Error('Synthetic private storage detail');
  for (const outcome of [undefined, null, 'refusal', { code: 'foreign' }]) assert.equal(retainFailureCause(outcome, native), outcome);
  const existing = new Error('Recovery refusal', { cause: native });
  assert.equal(retainFailureCause(existing, new Error('Earlier failure')).cause, native);
  const receipt = retainFailureCause(new Error('Portable receipt'), native);
  assert.equal(receipt.cause, native); assert.equal(Object.getOwnPropertyDescriptor(receipt, 'cause')?.enumerable, false);
  assert.doesNotMatch(JSON.stringify(receipt), /private storage/);
});

for (const boundary of ['before_close', 'before_proposal', 'closed', 'committed']) test(`real ${boundary} failure retains its original cause without changing the compensation outcome`, async t => {
  const { f, id, token } = await recoveryFixture(t, 1);
  const failure = Object.assign(new Error('Synthetic private storage detail'), { code: 'EIO' });
  await assert.rejects(withCloseObserver(step => { if (step === boundary) throw failure; }, () => f.shared.close(id, 'Public failure proof', token)), (error: unknown) => {
    assert.ok(error instanceof Error); assert.ok(hasCause(error, failure), 'native provenance was discarded');
    assert.match(error.message, boundary === 'committed' ? /swarm_partial_commit/ : /swarm_close_compensated/);
    assert.doesNotMatch(error.message + JSON.stringify(error), /private storage/);
    return true;
  });
});


for (const flow of ['restore', 'committed replay', 'compensated replay'] as const) for (const code of ['EIO', 'EACCES']) test(`${flow} retains the first member inspection ${code} privately and preserves every pending byte`, async t => {
  const fixture = flow === 'committed replay' ? await recoveryFixture(t, 1) : await pendingClose(t, 1);
  const { f, id, token, ids } = fixture;
  let journal: CloseJournal;
  if (flow === 'committed replay') {
    await f.shared.close(id, 'Public inspection proof', token);
    journal = JSON.parse(String((await f.client.get(id)).item[CLOSE_INTENT])) as CloseJournal;
  } else if (flow === 'compensated replay') {
    await assert.rejects(f.shared.close(id, 'Public native completion', token), { code: 'swarm_close_compensated' });
    journal = (await discoverCloseJournal(f.shared.engine, id, undefined))!;
  } else journal = (fixture as Awaited<ReturnType<typeof pendingClose>>).journal;
  const saved = closeBytes(f, ids);
  const failures = ids.map((_, index) => Object.assign(new Error(`Synthetic private inspection detail ${index}`), { code }));
  const paths = ids.map(member => [getItemPath(f.pmRoot, 'Task', member), getHistoryPath(f.pmRoot, member)]);
  const read = filesystem.readFile; const seen = new Set<number>();
  const hook = t.mock.method(filesystem, 'readFile', new Proxy(read, { apply(target, receiver, args: unknown[]) {
    const member = paths.findIndex(paths => paths.includes(String(args[0])));
    const stack = new Error().stack ?? '';
    if (member >= 0 && String(args[0]) === getHistoryPath(f.pmRoot, ids[member]) && stack.includes('inspectMember') && !/clientMutationSnapshot|readItemIdentity|readItemHistoryHead/.test(stack)) { seen.add(member); throw failures[member]; }
    return Reflect.apply(target, receiver, args);
  } })); syncBuiltinESMExports();
  try {
    const operation = flow === 'restore' ? withSwarmLease(f.pmRoot, f.shared.engine.author, lease => compensateClose(f.shared.engine, lease, journal)) : flow === 'committed replay' ? replayCommittedClose(f.shared.engine, journal) : replayCompensatedClose(f.shared.engine, journal);
    await assert.rejects(operation, (error: unknown) => {
      assert.ok(error instanceof Error); assert.ok(hasCause(error, failures[0]), 'first member inspection cause was lost');
      assert.equal(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable, false);
      assert.doesNotMatch(error.message + JSON.stringify(error), /private inspection/);
      assert.deepEqual((error as Error & { pending: string[] }).pending, ids);
      return true;
    });
    assert.deepEqual([...seen], [0, 1]);
  } finally { hook.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(closeBytes(f, ids), saved);
});


test('a pending domain without inspection errors leaves room for a later original cause', async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1);
  const engine = f.shared.engine;
  const prepared = await prepareClose(engine, id, 'Public inspection proof', token, await captureCloseMember(engine, id));
  const journal = prepared.journal;
  await appendCopiedClosePhase(f, journal);
  const snapshot = await captureCloseMember(engine, ids[1]);
  await runWithAgentSessionContext({ episode: { id: closeEpisode(journal, 'close', id) } }, () => commitItemMutation({ id: ids[1], item: snapshot.item, options: { title: 'Certified related prefix' } }, admitted => f.client.update(admitted.id, admitted.options), { history: snapshot.historyHead, onPrepared: (before, after, operation, history) => recordCloseProposal(engine, journal, prepared.signer, before, after, operation, history) }));
  const saved = closeBytes(f, ids);
  const later = new Error('Synthetic later failure');
  await assert.rejects(replayCompensatedClose(engine, journal), (error: unknown) => {
    assert.ok(error instanceof Error); assert.match(error.message, /swarm_compensation_partial/);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.equal(retainFailureCause(error, later).cause, later);
    return true;
  });
  assert.deepEqual(closeBytes(f, ids), saved);
});
