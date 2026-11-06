import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSettingsPath, readFileIfExists } from '@unbrained/pm-cli/sdk';
import { assertCompensated, closeBytes, closeProcess, recoveryFixture } from './close-recovery-helpers.ts';

for (const count of [1, 2, 3]) test(`SIGKILL every forward and reverse close boundary with ${count} dependents`, { timeout: 1800000 }, async t => {
  const baseline = await recoveryFixture(t, count);
  const success = closeProcess(baseline.f, baseline.id, baseline.token);
  assert.equal(success.status, 0, success.stdout + success.stderr);
  assert.deepEqual(success.boundaries, ['intent_native', 'intent', 'before_close', ...Array.from({ length: count + 1 }, () => ['before_proposal', 'proposal', 'native']).flat(), 'closed', 'close_synced', 'before_commit', 'commit_native', 'proofs_retired', 'committed']);
  const rollback = await recoveryFixture(t, count);
  const compensated = closeProcess(rollback.f, rollback.id, rollback.token, { fail: 'before_commit' });
  assert.equal(compensated.outcome?.code, 'swarm_close_compensated', compensated.stdout + compensated.stderr);
  assertCompensated(rollback.f, rollback.ids, rollback.before);
  assert.equal(compensated.boundaries.filter(boundary => boundary === 'restored').length, count + 1);
  for (const mode of ['forward', 'reverse']) {
    const events = mode === 'forward' ? success.boundaries : compensated.boundaries;
    const begin = mode === 'forward' ? 0 : events.indexOf('compensation_native');
    for (let boundary = begin; boundary < events.length; boundary++) await t.test(`${mode}/${boundary}/${events[boundary]}`, async child => {
      const fixture = await recoveryFixture(child, count); const { f, id, token, ids, before } = fixture;
      const killed = closeProcess(f, id, token, { kill: boundary, ...(mode === 'reverse' ? { fail: 'before_commit' } : {}) });
      assert.equal(killed.signal, 'SIGKILL', killed.stdout + killed.stderr);
      const recovered = closeProcess(f, id, token);
      if (mode === 'forward' && ['commit_native', 'proofs_retired', 'committed'].includes(events[boundary])) {
        assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
        assert.equal((await f.client.get(id)).item.status, 'closed');
        for (const dependent of ids.slice(1)) assert.equal((await f.client.get(dependent)).item.status, 'open');
        const settings = JSON.parse((await readFileIfExists(getSettingsPath(f.pmRoot)))!) as { swarm?: { close_proofs?: Record<string, unknown> } };
        assert.equal(Object.keys(settings.swarm?.close_proofs ?? {}).length, 0, 'resumed committed work retires its native proof cache');
      } else {
        assert.equal(recovered.outcome?.code, 'swarm_close_compensated', recovered.stdout + recovered.stderr);
        assertCompensated(f, ids, before);
      }
      const stable = closeBytes(f, ids); const repeated = closeProcess(f, id, token);
      assert.equal(repeated.status, recovered.status); assert.deepEqual(closeBytes(f, ids), stable, 'a repeated recovery must append no duplicate writes');
    });
  }
});
