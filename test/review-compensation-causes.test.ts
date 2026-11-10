import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retainFailureCause } from '../src/failure-cause.ts';
import { withCloseObserver } from '../src/close-journal.ts';
import { recoveryFixture } from './close-recovery-helpers.ts';

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
