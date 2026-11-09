import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import filesystem from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { deriveMutationTransactionId, getHistoryPath, getItemPath } from '@unbrained/pm-cli/sdk';
import { CLOSE_INTENT, captureCloseMember, withCloseObserver } from '../src/close-journal.ts';
import type { CloseJournal } from '../src/close-journal.ts';
import { compensateClose, prepareClose } from '../src/close-recovery.ts';
import { withSwarmLease } from '../src/lease.ts';
import { appendCopiedClosePhase, closeBytes, recoveryFixture, signedNativeCompletion } from './close-recovery-helpers.ts';

/** Capture a real claim and immutable plan without persisting a close intent. */
async function unstartedClose(t: Parameters<typeof recoveryFixture>[0]) {
  const fixture = await recoveryFixture(t, 0); const { f, id, token } = fixture;
  const prepared = await prepareClose(f.shared.engine, id, 'Public native completion', token, await captureCloseMember(f.shared.engine, id));
  return { ...fixture, prepared };
}
/** A substituted intent must leave every planned member and audit entry unchanged. */
async function assertRefusedPlanPreserves(f: Awaited<ReturnType<typeof recoveryFixture>>['f'], journal: CloseJournal): Promise<void> {
  const ids = journal.members.map(member => member.id); const saved = closeBytes(f, ids);
  await assert.rejects(withSwarmLease(f.pmRoot, f.shared.engine.author, lease => compensateClose(f.shared.engine, lease, journal)), { code: 'swarm_compensation_partial' });
  assert.deepEqual(closeBytes(f, ids), saved, 'a substituted intent cannot authorize rollback');
}

for (const boundary of ['commit_native', 'committed']) for (const artifact of ['item', 'history']) test(`lost ${boundary} return with an unavailable ${artifact} preserves completion and replays without writes`, async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 2);
  const path = artifact === 'item' ? getItemPath(f.pmRoot, 'Task', id) : getHistoryPath(f.pmRoot, id);
  const read = filesystem.readFile; const open = filesystem.open;
  let armed = false; let failures = 0; let syncFailed = false; let saved: ReturnType<typeof closeBytes> | undefined;
  // Only storage reads fail; native close, dependent updates, journal writes and retry are real.
  const fault = t.mock.method(filesystem, 'readFile', new Proxy(read, { apply(target, receiver, args: unknown[]) {
    if (armed && args[0] === path) { armed = false; failures++; throw Object.assign(new Error('Synthetic confirmation read outage'), { code: 'EIO' }); }
    return Reflect.apply(target, receiver, args);
  } }));
  const syncFault = t.mock.method(filesystem, 'open', new Proxy(open, { apply(target, receiver, args: unknown[]) {
    if (boundary === 'commit_native' && armed && !syncFailed && args[0] === getItemPath(f.pmRoot, 'Task', id)) {
      syncFailed = true; throw Object.assign(new Error('Lost durability confirmation'), { code: 'EIO' });
    }
    return Reflect.apply(target, receiver, args);
  } })); syncBuiltinESMExports();
  try {
    await assert.rejects(withCloseObserver(observed => {
      if (observed !== boundary) return;
      saved = closeBytes(f, ids); armed = true;
      if (boundary === 'committed') throw new Error('Lost committed native return');
    }, () => f.shared.close(id, 'Public native completion', token)), { code: 'swarm_partial_commit' });
  } finally { fault.mock.restore(); syncFault.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(saved); assert.deepEqual(closeBytes(f, ids), saved, 'no compensation intent, restore or audit entry may follow a committed receipt');
  assert.equal((await f.client.get(id)).item.status, 'closed');
  for (const member of ids.slice(1)) assert.equal((await f.client.get(member)).item.status, 'open');
  assert.equal(JSON.parse(String((await f.client.get(id)).item[CLOSE_INTENT])).phase, 'committed');
  // A correct committed-journal check may avoid reading the current item altogether.
  if (artifact === 'history') assert.equal(failures, 1);
  assert.equal((await f.shared.close(id, 'Public native completion', token)).closed, true);
  for (const json of [false, true]) {
    const result = f.cli('swarm', 'close', id, '--note', 'Public native completion', '--token', token, ...(json ? ['--json'] : []));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, json ? /"closed":\s*true/ : /closed: true/);
  }
  assert.deepEqual(closeBytes(f, ids), saved, 'SDK, JSON and TOON retries must replay without writes');
});

test('every stale compensation phase preserves a newer committed native receipt', async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1);
  await f.shared.close(id, 'Public native completion', token);
  const committed = JSON.parse(String((await f.client.get(id)).item[CLOSE_INTENT])) as CloseJournal;
  const saved = closeBytes(f, ids);
  for (const phase of ['applying', 'compensating', 'committed'] as const) {
    await assert.rejects(withSwarmLease(f.pmRoot, f.shared.engine.author, lease => compensateClose(f.shared.engine, lease, { ...committed, phase })), { code: 'swarm_partial_commit' });
    assert.deepEqual(closeBytes(f, ids), saved);
  }
});

test('missing or replaced native intent never authorizes compensation of an in-memory plan', async t => {
  const { f, prepared } = await unstartedClose(t);
  for (const replaced of [false, true]) {
    if (replaced) await appendCopiedClosePhase(f, { ...prepared.journal, compensation_id: deriveMutationTransactionId('Independent replacement') });
    await assertRefusedPlanPreserves(f, prepared.journal);
  }
});

test('rediscovery preserves every immutable plan field instead of adopting peer recovery authority', async t => {
  for (const field of ['compensation_id', 'id', 'author', 'note', 'token', 'members', 'public_key'] as const) await t.test(field, async child => {
    const { f, id, token, prepared } = await unstartedClose(child);
    const changed = structuredClone(prepared.journal);
    switch (field) {
      case 'compensation_id': changed.compensation_id = deriveMutationTransactionId('Independent peer plan'); break;
      case 'id': changed.id = 'shared-test-peer'; changed.members[0].id = changed.id; break;
      case 'author': changed.author = 'peer-worker'; break;
      case 'note': changed.note = 'Independent peer completion'; break;
      case 'token': changed.token = String(BigInt(token) + 1n); break;
      case 'members': changed.members[0].digest = '0'.repeat(64); break;
      case 'public_key': changed.public_key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('hex'); break;
    }
    if (field === 'id') await f.client.update(id, { force: true, field: [`${CLOSE_INTENT}=${JSON.stringify(changed)}`] });
    else await appendCopiedClosePhase(f, changed);
    await assertRefusedPlanPreserves(f, prepared.journal);
  });
});

test('a completion appended between discovery and inspection is fenced before the first compensation write', async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1);
  const completed = await signedNativeCompletion(f, id, token, ids);
  const stale = JSON.parse(String((await f.client.get(id)).item[CLOSE_INTENT])) as CloseJournal;
  const sdk = createRequire(import.meta.url).resolve('@unbrained/pm-cli/sdk');
  let appended = false; let saved: ReturnType<typeof closeBytes> | undefined;
  await assert.rejects(withSwarmLease(f.pmRoot, f.shared.engine.author, lease => withCloseObserver(boundary => {
    if (boundary === 'recovery_intent' && !appended) {
      appended = true;
      const peer = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import {PmClient,runWithAgentSessionContext,deriveMutationTransactionId} from ${JSON.stringify(sdk)};
        const journal=JSON.parse(process.argv[1]);
        const episode=deriveMutationTransactionId(JSON.stringify({compensation_id:journal.compensation_id,phase:'journal',payload:journal}));
        const client=new PmClient({cwd:process.cwd(),pmRoot:process.env.PM_PATH,author:journal.author});
        await runWithAgentSessionContext({episode:{id:episode}},()=>client.update(journal.id,{force:true,field:['swarm_close_intent='+JSON.stringify(journal),'swarm_token='+String(BigInt(journal.token)+1n)],unset:['swarm_handoff','swarm_claimed_at']}));
      `, JSON.stringify(completed)], { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 10000 });
      assert.equal(peer.status, 0, peer.stdout + peer.stderr + String(peer.error ?? ''));
      saved = closeBytes(f, ids);
    }
  }, () => compensateClose(f.shared.engine, lease, stale))), { code: 'swarm_partial_commit' });
  assert.equal(appended, true); assert.deepEqual(closeBytes(f, ids), saved);
  assert.equal((await f.shared.close(id, completed.note, token)).closed, true);
  assert.deepEqual(closeBytes(f, ids), saved);
});
