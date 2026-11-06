import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getHistoryPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { assertCompensated, closeBytes, closeProcess, recoveryFixture } from './close-recovery-helpers.ts';

for (const count of [1, 2, 3]) test(`native member progress survives a lost restore return with ${count} dependents`, async t => {
  const { f, id, token, ids, before } = await recoveryFixture(t, count);
  const crash = closeProcess(f, id, token, { fail: 'before_commit', kill: { boundary: 'restore_native' } });
  assert.equal(crash.signal, 'SIGKILL', crash.stdout + crash.stderr);
  const resumed = closeProcess(f, id, token);
  assert.equal(resumed.outcome?.code, 'swarm_close_compensated', resumed.stdout + resumed.stderr);
  assertCompensated(f, ids, before);
  for (const member of ids) {
    const entries = await readHistoryEntries(getHistoryPath(f.pmRoot, member), member);
    assert.equal(entries.filter(entry => entry.op === 'restore').length, 1, 'native progress must prevent a duplicate restore');
  }
  const stable = closeBytes(f, ids);
  assert.equal(closeProcess(f, id, token).outcome?.code, 'swarm_close_compensated');
  assert.deepEqual(closeBytes(f, ids), stable);
});
