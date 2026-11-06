import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { deriveMutationTransactionId, getHistoryPath, getItemAt, acquireLockLease, readHistoryEntries, readSettings, activateExtensions, loadExtensions, setActiveExtensionServices, runWithAgentSessionContext } from '@unbrained/pm-cli/sdk';
import { captureCloseMember, closeEpisode, withCloseObserver } from '../src/close-journal.ts';
import type { CloseJournal } from '../src/close-journal.ts';
import { recordCloseProposal, signCloseResult, validCloseResult } from '../src/close-proofs.ts';
import { readItemHistoryHead } from '../src/settings.ts';
import { sharedFixture } from './shared-helpers.ts';
import { blockedDependent } from './close-native-helpers.ts';
import { appendCopiedClosePhase, closeBytes, pendingClose, signedNativeCompletion } from './close-recovery-helpers.ts';

/** A peer supplies its own key and public metadata; every persisted record still uses the actual SDK. */
async function peerIntent(t: TestContext, terminal = false, related = false) {
  const f = await sharedFixture(t); const id = await f.item();
  if (terminal) await f.client.update(id, { status: 'closed', force: true, closeReason: 'Independent manual completion' });
  const ids = [id]; if (related) ids.push(await blockedDependent(f, id));
  const members = await Promise.all(ids.map(async member => (await captureCloseMember(f.shared.engine, member)).member));
  const keys = generateKeyPairSync('ed25519');
  const journal: CloseJournal = { protocol: 'swarm-close/v3', compensation_id: deriveMutationTransactionId(randomUUID()), id, author: f.shared.engine.author, token: null, note: 'Peer signed completion', members, phase: 'applying', post: [], restored: [], proofs: [], public_key: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('hex') };
  await appendCopiedClosePhase(f, journal);
  return { f, id, ids, journal, signer: keys.privateKey };
}

test('a self-signed fresh journal has no native close authority', async t => {
  for (const terminal of [false, true]) await t.test(terminal ? 'manually terminal metadata' : 'open metadata', async child => {
    const { f, id, ids, journal, signer } = await peerIntent(child, terminal);
    let completed: CloseJournal = { ...journal, phase: 'committed', warnings: [], post: [{ id, head: await readItemHistoryHead(f.pmRoot, id) }] };
    completed = { ...completed, result_signature: signCloseResult(completed, signer) }; assert.equal(validCloseResult(completed), true);
    await appendCopiedClosePhase(f, completed, { unset: ['swarm_handoff', 'swarm_claimed_at'] });
    assert.equal((await readHistoryEntries(getHistoryPath(f.pmRoot, id), id)).slice(journal.members[0].head.length).some(entry => entry.op === 'close'), false);
    const before = closeBytes(f, ids);
    await assert.rejects(f.shared.close(id, journal.note), { code: 'swarm_compensation_partial' });
    assert.deepEqual(closeBytes(f, ids), before);
  });
});

test('a peer key cannot authorize dependent compensation before a native primary close', async t => {
  const { f, id, ids, journal, signer } = await peerIntent(t, false, true); const member = journal.members[1];
  const before = (await getItemAt(member.id, String(member.version), { pmRoot: f.pmRoot })).document;
  await runWithAgentSessionContext({ episode: { id: closeEpisode(journal, 'close', id) } }, () => f.client.update(member.id, { title: 'Independent peer progress', force: true }));
  const after = (await getItemAt(member.id, String(member.version + 1), { pmRoot: f.pmRoot })).document;
  await recordCloseProposal(f.shared.engine, journal, signer, before, after, 'update', member.head);
  const saved = closeBytes(f, ids);
  await assert.rejects(f.shared.close(id, journal.note), { code: 'swarm_compensation_partial' });
  assert.deepEqual(closeBytes(f, ids), saved);
});

test('a signed null-token completion cannot introduce a fencing token', async t => {
  const legacy = await sharedFixture(t); const legacyId = await legacy.item(); await legacy.client.claim(legacyId);
  assert.equal((await legacy.shared.close(legacyId, 'Legacy close')).closed, true);
  assert.equal((await legacy.shared.close(legacyId, 'Legacy close')).closed, true);
  const f = await sharedFixture(t); const id = await f.item(); await f.client.claim(id);
  const completed = await signedNativeCompletion(f, id, undefined, [id]); assert.equal(completed.token, null);
  await appendCopiedClosePhase(f, completed, { field: ['swarm_token=99'], unset: ['swarm_handoff', 'swarm_claimed_at'] });
  const before = closeBytes(f, [id]);
  await assert.rejects(f.shared.close(id, completed.note), { code: 'swarm_compensation_partial' });
  assert.deepEqual(closeBytes(f, [id]), before);
});

/** A real installed lock service returns native leases and injects one cleanup failure. */
interface ReleaseControl { armed: boolean; failed: boolean; targets: string[]; attempts: string[]; acquire?: (payload: { pm_root: string; id: string; ttl_seconds: number; owner: string }) => Promise<unknown> }

test('one rejected release does not retain other native dependent locks', async t => {
  const { f, id, ids, token } = await pendingClose(t, 2);
  const key = Symbol.for('pm-swarm.test.release-control/v1');
  const control: ReleaseControl = { armed: false, failed: false, targets: ids.slice(1), attempts: [] };
  Reflect.set(globalThis, key, control); t.after(() => Reflect.deleteProperty(globalThis, key));
  const extension = join(f.pmRoot, 'extensions/release-provider'); mkdirSync(extension);
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ name: 'release-provider', version: '1.0.0', entry: 'entry.js', capabilities: ['services'] }));
  writeFileSync(join(extension, 'entry.js'), `export default {activate(api){api.registerService('lock_acquire',({payload})=>{const state=globalThis[Symbol.for('pm-swarm.test.release-control/v1')];return state?.armed&&state.targets.includes(payload.id)?state.acquire(payload):{handled:false};});}};`);
  const activated = await activateExtensions(await loadExtensions({ cwd: f.repo, pmRoot: f.pmRoot, settings: await readSettings(f.pmRoot) }));
  assert.deepEqual(activated.failed, []); t.after(() => setActiveExtensionServices(null));
  control.acquire = async payload => {
    setActiveExtensionServices(null);
    const native = await acquireLockLease(payload.pm_root, payload.id, payload.ttl_seconds, payload.owner, false, false, 0);
    setActiveExtensionServices(activated.services);
    return { handled: true, result: { release: async () => {
      await native.release(); control.attempts.push(payload.id);
      if (!control.failed) { control.failed = true; throw new Error('Synthetic native lease cleanup failure'); }
    } } };
  };
  setActiveExtensionServices(activated.services);
  await assert.rejects(withCloseObserver((boundary, member) => { if (boundary === 'before_restore' && member === id) { control.armed = true; setActiveExtensionServices(activated.services); } }, () => f.shared.close(id, 'Public native completion', token)), { code: 'swarm_compensation_partial' });
  assert.equal(control.failed, true);
  assert.deepEqual(control.attempts, [...control.targets].sort().reverse());
  await assert.rejects(f.shared.close(id, 'Public native completion', token), { code: 'swarm_close_compensated' });
  for (const member of control.targets) {
    const peer = spawnSync(process.execPath, [f.host, 'update', member, '--description', 'Peer after cleanup', '--json'], { cwd: f.repo, env: { ...f.env, PM_LOCK_WAIT_MS: '0' }, encoding: 'utf8', timeout: 30000 });
    assert.equal(peer.status, 0, peer.stdout + peer.stderr);
  }
});
