import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { getHistoryPath } from '@unbrained/pm-cli/sdk';
import { CompensationPartialRefusal, requirePrimaryOnlyCompensation } from '../src/close-compensation.ts';
import { closeSnapshot, closeStepResult } from '../src/close-journal.ts';
import { sharedFixture } from './shared-helpers.ts';

/** Old journals are examined through real native heads, never document equality. */
test('missing close results allow only an unchanged certified dependency domain', async t => {
  const f = await sharedFixture(t); const primary = await f.item(); const id = await f.item();
  const snapshot = await closeSnapshot(f.pmRoot, id);
  const point = { version: snapshot.version, hash: snapshot.hash, historyHead: snapshot.historyHead };
  const data = closeStepResult(snapshot, undefined, false, [{ id, before: point, after: point }]);
  await requirePrimaryOnlyCompensation(f.pmRoot, primary, 'public-transaction', undefined, data);
  await f.client.update(id, { title: 'Independent peer progress' });
  await assert.rejects(requirePrimaryOnlyCompensation(f.pmRoot, primary, 'public-transaction', undefined, data), error => error instanceof CompensationPartialRefusal && error.pending.includes(id));
  writeFileSync(getHistoryPath(f.pmRoot, id), '{invalid history}\n');
  await assert.rejects(requirePrimaryOnlyCompensation(f.pmRoot, primary, 'public-transaction', undefined, data), error => error instanceof CompensationPartialRefusal && error.scope_unknown && error.pending.includes(id));
});

test('known empty native effects and observed receipts retain primary-only rollback', async () => {
  await requirePrimaryOnlyCompensation('operator-location', 'primary', 'public-transaction', { effects: [] }, undefined);
  await requirePrimaryOnlyCompensation('operator-location', 'primary', 'public-transaction', undefined, undefined, []);
  await assert.rejects(requirePrimaryOnlyCompensation('operator-location', 'primary', 'public-transaction', undefined, undefined), error => error instanceof CompensationPartialRefusal && error.scope_unknown && error.pending.length === 1);
});

test('compensation receipt is immutable deduplicated private-safe and carried by native required text', () => {
  const error = new CompensationPartialRefusal('public-transaction', 'primary', ['primary', 'dependent']);
  assert.deepEqual(error.pending, ['primary', 'dependent']); assert.deepEqual(error.restored, []);
  assert.equal(Object.isFrozen(error.pending), true); assert.equal(Object.isFrozen(error.restored), true);
  const receipt = JSON.parse(error.remedy.split('Compensation receipt: ')[1]);
  assert.deepEqual(receipt, { restored: error.restored, pending: error.pending, transaction_id: error.transaction_id, scope_unknown: error.scope_unknown });
  assert.throws(() => new CompensationPartialRefusal('public-transaction', ['','home','private','member'].join('/'), []), error => error instanceof Error && 'code' in error && error.code === 'swarm_private_path');
});
