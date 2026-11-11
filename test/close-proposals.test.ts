import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createExtensionCommandSdk, getHistoryPath, getItemAt, getSettingsPath, readHistoryEntries, runWithAgentSessionContext } from '@unbrained/pm-cli/sdk';
import { closeEpisode, captureCloseMember, withCloseObserver } from '../src/close-journal.ts';
import { loadCloseProposals, validCloseProposal } from '../src/close-proofs.ts';
import { commitItemMutation } from '../src/settings.ts';
import { assertRefusedClosePreserves, closeBytes, pendingClose, recoveryFixture } from './close-recovery-helpers.ts';

test('signed native proposals bind the exact member, revision, operation and resulting document', async t => {
  const { f, ids, journal } = await pendingClose(t);
  const proofs = await loadCloseProposals(f.shared.engine, journal); assert.equal(proofs.length, 2);
  for (const proof of proofs) {
    assert.equal(validCloseProposal(journal, proof), true);
    for (const field of ['id', 'operation', 'before_hash', 'after_hash', 'compensation_id'] as const) assert.equal(validCloseProposal(journal, { ...proof, proposal: { ...proof.proposal, [field]: 'foreign' } }), false);
    assert.equal(validCloseProposal(journal, { ...proof, signature: '0'.repeat(128) }), false);
    assert.equal(validCloseProposal({ ...journal, public_key: 'invalid' }, proof), false);
  }
  const stable = closeBytes(f, ids);
  const forged = structuredClone(journal); forged.proofs = [{ ...proofs[0], signature: '0'.repeat(128) }];
  await assert.rejects(loadCloseProposals(f.shared.engine, { ...forged, phase: 'compensating' }), { code: 'swarm_compensation_partial' });
  Reflect.set(forged, 'proofs', {});
  await assert.rejects(loadCloseProposals(f.shared.engine, { ...forged, phase: 'compensating' }), { code: 'swarm_compensation_partial' });
  assert.deepEqual(closeBytes(f, ids), stable);
});

test('a peer-corrupted proposal ledger stops later native writes without replacing the foreign settings', async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1); let observed = false; let foreign = '';
  await assert.rejects(withCloseObserver((boundary, member) => {
    if (observed || boundary !== 'proposal' || member !== id) return; observed = true;
    const peer = spawnSync(process.execPath, ['--input-type=module', '--eval', `
import {PmClient,createExtensionCommandSdk,getSettingsPath,readFileIfExists} from '@unbrained/pm-cli/sdk';
const input=JSON.parse(process.argv[1]);const client=new PmClient({cwd:input.repo,pmRoot:input.pmRoot,author:'peer-test'});
const intent=JSON.parse((await client.get(input.id,{depth:'full'})).item.swarm_close_intent);
const source=JSON.parse(await readFileIfExists(getSettingsPath(input.pmRoot)));
await createExtensionCommandSdk(input.pmRoot,client,'peer-test').mutateWorkspaceSettings({operationId:'foreign-proof-record',replaceSubtrees:['swarm'],mutate:current=>({...current,swarm:{...source.swarm,close_proofs:{...source.swarm.close_proofs,[intent.compensation_id]:[{}]}}})});
`, JSON.stringify({ repo: f.repo, pmRoot: f.pmRoot, id })], { cwd: import.meta.dirname, env: f.env, encoding: 'utf8', timeout: 60000 });
    assert.equal(peer.status, 0, peer.stdout + peer.stderr); foreign = readFileSync(getSettingsPath(f.pmRoot), 'utf8');
  }, () => f.shared.close(id, 'Public native completion', token)), { code: 'swarm_compensation_partial' });
  assert.equal(observed, true); assert.equal(readFileSync(getSettingsPath(f.pmRoot), 'utf8'), foreign);
  assert.equal((await f.client.get(ids[1])).item.status, 'blocked');
});

for (const shape of ['section', 'ledger', 'entry', 'entry-shape']) test(`malformed native proposal ${shape} preserves item state and refuses before recovery writes`, async t => {
  const { f, ids, journal } = await pendingClose(t);
  const sdk = createExtensionCommandSdk(f.pmRoot, f.client, 'peer-test');
  await sdk.mutateWorkspaceSettings({ operationId: `foreign-${shape}`, mutate: current => ({ ...current, swarm: shape === 'section' ? [] : { close_proofs: shape === 'ledger' ? [] : { [journal.compensation_id]: shape === 'entry-shape' ? {} : [{ proposal: {}, signature: '0'.repeat(128) }] } } }) });
  const before = closeBytes(f, ids);
  await assert.rejects(loadCloseProposals(f.shared.engine, journal), { code: ['section', 'ledger'].includes(shape) ? 'swarm_settings_invalid' : 'swarm_compensation_partial' });
  assert.deepEqual(closeBytes(f, ids), before);
});

test('a copied caller episode cannot certify an unrelated native primary close before its own proposal', async t => {
  const { f, id, token, ids, journal } = await pendingClose(t, 1, 'before_close');
  await runWithAgentSessionContext({ episode: { id: closeEpisode(journal, 'close', id) } }, () => f.client.close(id, journal.note));
  assertRefusedClosePreserves(f, id, token, ids);
});

test('the proposed-document callback leaves native deletion semantics and history intact', async t => {
  const { f, id } = await recoveryFixture(t, 0); const snapshot = await captureCloseMember(f.shared.engine, id);
  await commitItemMutation({ id, item: snapshot.item, options: { force: true } }, admitted => f.client.delete(admitted.id, admitted.options), { history: snapshot.historyHead, onPrepared: async () => { assert.fail('Deleted documents have no forward close proposal'); } });
  const entries = await readHistoryEntries(getHistoryPath(f.pmRoot, id), id); assert.equal(entries.at(-1)!.op, 'delete');
  assert.equal((await getItemAt(id, String(snapshot.version), { pmRoot: f.pmRoot })).document.metadata.id, id);
});

test('fresh close admits existing settings before persisting intent and allows benign foreign settings', async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1); const sdk = createExtensionCommandSdk(f.pmRoot, f.client, 'peer-test');
  await sdk.mutateWorkspaceSettings({ operationId: 'private-foreign-setting', mutate: current => ({ ...current, foreign_section: { location: ['', 'home', 'private', 'settings'].join('/') } }) });
  const before = closeBytes(f, ids); const settings = readFileSync(getSettingsPath(f.pmRoot), 'utf8');
  await assert.rejects(f.shared.close(id, 'Public native completion', token), { code: 'swarm_private_path' });
  assert.deepEqual(closeBytes(f, ids), before); assert.equal(readFileSync(getSettingsPath(f.pmRoot), 'utf8'), settings);
  await sdk.mutateWorkspaceSettings({ operationId: 'benign-foreign-setting', mutate: current => ({ ...current, foreign_section: { location: 'docs/public.md' } }) });
  assert.equal((await f.shared.close(id, 'Public native completion', token)).closed, true);
});
