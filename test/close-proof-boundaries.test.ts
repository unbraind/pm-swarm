import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { appendHistoryEntry, createHistoryEntry, emptyImportedDocument, getHistoryPath, getItemAt, getItemPath, PmClient, readSettings, runWithAgentSessionContext, serializeItemDocument } from '@unbrained/pm-cli/sdk';
import { CLOSE_INTENT, captureCloseMember, closeEpisode, discoverCloseJournal, inspectCloseMember, memberDigest, withCloseObserver } from '../src/close-journal.ts';
import type { CloseJournal } from '../src/close-journal.ts';
import { compensateClose, prepareClose, replayCompensatedClose } from '../src/close-recovery.ts';
import { loadCloseProposals } from '../src/close-proofs.ts';
import { withSwarmLease } from '../src/lease.ts';
import { Swarm } from '../src/swarm.ts';
import { assertCompensated, closeBytes, closeProcess, pendingClose as pending, recoveryFixture } from './close-recovery-helpers.ts';
import { sharedFixture } from './shared-helpers.ts';
import { blockedDependent } from './close-native-helpers.ts';

test('altered member identities and native prefixes cannot authorize recovery', async t => {
  const { f, id, journal, ids } = await pending(t); const stable = closeBytes(f, ids);
  await assert.rejects(inspectCloseMember(f.shared.engine, journal, { ...journal.members[0], id: id.split('-').at(-1)! }), { code: 'swarm_compensation_partial' });
  await assert.rejects(inspectCloseMember(f.shared.engine, journal, { ...journal.members[0], head: { ...journal.members[0].head, hash: '0'.repeat(64) } }), { code: 'swarm_compensation_partial' });
  assert.deepEqual(closeBytes(f, ids), stable);
});

for (const kind of ['foreign primary field', 'invented progress', 'uncleared handoff', 'missing post-close heads']) test(`native history refuses ${kind} even beside a valid intent`, async t => {
  const { f, id, token, ids, journal } = await pending(t);
  if (kind === 'foreign primary field') await f.client.update(id, { force: true, title: 'Independent primary edit' });
  else {
    const forged: CloseJournal = { ...journal, proofs: await loadCloseProposals(f.shared.engine, journal), phase: kind === 'uncleared handoff' ? 'committed' : 'compensating', restored: kind === 'invented progress' ? [ids[1]] : [], warnings: [] };
    await runWithAgentSessionContext({ episode: { id: closeEpisode(forged, 'journal', forged) } }, () => f.client.update(id, { force: true, field: [`${CLOSE_INTENT}=${JSON.stringify(forged)}`] }));
  }
  const peer = closeBytes(f, ids);
  assert.equal(closeProcess(f, id, token).outcome?.code, 'swarm_compensation_partial');
  assert.deepEqual(closeBytes(f, ids), peer);
});

test('unrelated native writers remain independent while an owned close compensates', async t => {
  const fixture = await recoveryFixture(t, 1); const { f, id, token, ids, before } = fixture;
  const unrelated = await f.item();
  assert.equal(closeProcess(f, id, token, { kill: { boundary: 'before_commit' } }).signal, 'SIGKILL');
  await f.client.update(unrelated, { title: 'Independent unrelated progress' });
  const peer = closeBytes(f, [unrelated]);
  assert.equal(closeProcess(f, id, token).outcome?.code, 'swarm_close_compensated');
  assertCompensated(f, ids, before); assert.deepEqual(closeBytes(f, [unrelated]), peer);
});

test('unlogged item bytes fail both admission and native receipt verification', async t => {
  const { f, id, journal } = await pending(t);
  const history = journal.members[0].version + 2;
  const view = await getItemAt(id, String(history), { pmRoot: f.pmRoot });
  const settings = await readSettings(f.pmRoot); view.document.metadata.title = 'External byte edit without native history';
  const path = getItemPath(f.pmRoot, 'Task', id);
  writeFileSync(path, serializeItemDocument(view.document, { format: settings.item_format, schema: settings.schema }));
  const peer = readFileSync(path, 'utf8');
  await assert.rejects(captureCloseMember(f.shared.engine, id), { code: 'swarm_document_changed' });
  await assert.rejects(inspectCloseMember(f.shared.engine, journal, journal.members[0]), { code: 'swarm_compensation_partial' });
  assert.equal(readFileSync(path, 'utf8'), peer);
});

test('a copied restore identity cannot reopen a committed close or certify a different post-close head', async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1);
  await f.shared.close(id, 'Public native completion', token);
  const journal = JSON.parse(String((await f.client.get(id, { depth: 'full' })).item[CLOSE_INTENT])) as CloseJournal;
  const member = journal.members[0];
  await runWithAgentSessionContext({ episode: { id: closeEpisode(journal, 'restore', member) } }, () => f.client.restore(id, String(member.version), { force: true, message: 'Swarm close compensation' }));
  const peer = closeBytes(f, ids);
  assert.equal(closeProcess(f, id, token).outcome?.code, 'swarm_compensation_partial'); assert.deepEqual(closeBytes(f, ids), peer);
});

test('post-close heads remain immutable across completed compensation and delayed callers', async t => {
  const { f, id, token, ids } = await pending(t);
  assert.equal(closeProcess(f, id, token).outcome?.code, 'swarm_close_compensated');
  const journal = (await discoverCloseJournal(f.shared.engine, id, undefined))!;
  const forged = structuredClone(journal); forged.post[0].head.hash = 'f'.repeat(64);
  await assert.rejects(inspectCloseMember(f.shared.engine, forged, forged.members[0]), { code: 'swarm_compensation_partial' });
  const stable = closeBytes(f, ids);
  await assert.rejects(withSwarmLease(f.pmRoot, 'shared-test', lease => compensateClose(f.shared.engine, lease, journal)), { code: 'swarm_close_compensated' });
  assert.deepEqual(closeBytes(f, ids), stable);
});

for (const obstruction of ['missing', 'directory']) test(`recovery preserves its audit stream through a ${obstruction} history outage`, async t => {
  const { f, id, token, ids, before } = await pending(t);
  const path = getHistoryPath(f.pmRoot, id); const retained = `${path}.retained`; let moved = false;
  try {
    await assert.rejects(withCloseObserver(boundary => {
      if (boundary !== 'before_restore' || moved) return; moved = true; renameSync(path, retained);
      if (obstruction === 'directory') mkdirSync(path);
      throw Object.assign(new Error('Storage unavailable'), { code: 'EIO' });
    }, () => f.shared.close(id, 'Public native completion', token)), { code: 'swarm_compensation_partial' });
    assert.equal(moved, true); assert.ok(readFileSync(retained, 'utf8').startsWith(before.histories[0]));
  } finally { if (moved) { if (obstruction === 'directory') rmdirSync(path); renameSync(retained, path); } }
  assert.equal(closeProcess(f, id, token).outcome?.code, 'swarm_close_compensated'); assertCompensated(f, ids, before);
});

test('a lost final compensation return is reported conservatively and retries without duplicate history', async t => {
  const { f, id, token, ids, before } = await pending(t);
  await assert.rejects(withCloseObserver((boundary, member) => { if (boundary === 'restored' && member === id) throw new Error('Lost final compensation return'); }, () => f.shared.close(id, 'Public native completion', token)), { code: 'swarm_compensation_partial' });
  assertCompensated(f, ids, before); const stable = closeBytes(f, ids);
  assert.equal(closeProcess(f, id, token).outcome?.code, 'swarm_close_compensated'); assert.deepEqual(closeBytes(f, ids), stable);
});

test('legacy native claims close and compensate without inventing a supplied swarm token', async t => {
  const f = await sharedFixture(t); const id = await f.item(); await f.client.claim(id);
  await assert.rejects(withCloseObserver(boundary => { if (boundary === 'before_commit') throw new Error('Legacy claim interruption'); }, () => f.shared.close(id, 'Legacy completion')), { code: 'swarm_close_compensated' });
  const next = await f.shared.start(id); assert.equal(next.token, '1');
  await f.shared.close(id, 'New generation', next.token);
});

test('saved native warnings replay under normalized note text without rewriting item history', async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1);
  const first = await f.shared.close(id, '  Public native completion  ', token);
  assert.ok(first.warnings?.length); const stable = closeBytes(f, ids);
  assert.deepEqual(await f.shared.close(id, 'Public native completion', token), first); assert.deepEqual(closeBytes(f, ids), stable);
});

test('an ordinary failure after the final native success record reports a committed result and replays it', async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1);
  await assert.rejects(withCloseObserver(boundary => { if (boundary === 'committed') throw new Error('Lost final native success return'); }, () => f.shared.close(id, 'Public native completion', token)), { code: 'swarm_partial_commit' });
  const stable = closeBytes(f, ids);
  assert.equal((await f.shared.close(id, 'Public native completion', token)).closed, true); assert.deepEqual(closeBytes(f, ids), stable);
});

test('an unshareable native warning compensates immediately without persisting rejected receipt content', async t => {
  const f = await sharedFixture(t);
  writeFileSync(join(f.pmRoot, 'extensions/pm-swarm/entry.js'), `import extension from ${JSON.stringify(new URL('../index.ts', import.meta.url).href)}; export default {activate(api){extension.activate(api);api.hooks.beforeMutation(context=>context.operation==='update'&&context.before?.metadata.status==='blocked'&&context.after?.metadata.status==='open'?{allow:false,code:'dependent_policy',message:['','home','private','warning'].join('/'),remediation:'Inspect the dependent policy.'}:{allow:true});}};`);
  const id = await f.item(); const held = await f.shared.start(id); const dependent = await blockedDependent(f, id); const before = closeBytes(f, [id, dependent]);
  await assert.rejects(f.shared.close(id, 'Public native completion', held.token), { code: 'swarm_close_compensated' });
  assertCompensated(f, [id, dependent], before);
  assert.equal(readFileSync(getHistoryPath(f.pmRoot, id), 'utf8').includes(['', 'home', 'private', 'warning'].join('/')), false);
});

for (const phase of ['committed', 'compensated']) test(`a ${phase} receipt reports unavailable fsync safely and retries without writes`, async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1);
  if (phase === 'committed') await f.shared.close(id, 'Public native completion', token);
  else await assert.rejects(withCloseObserver(boundary => { if (boundary === 'before_commit') throw new Error('Compensate this fixture'); }, () => f.shared.close(id, 'Public native completion', token)), { code: 'swarm_close_compensated' });
  const stable = closeBytes(f, ids); const open = filesystem.open; let injected = false;
  // Fault only the authored durability operation; all SDK reads, mutations and receipts remain real.
  const fault = t.mock.method(filesystem, 'open', new Proxy(open, { apply(target, receiver, args: unknown[]) {
    if (new Error().stack?.includes('syncCloseMember')) { injected = true; throw Object.assign(new Error('Injected EIO'), { code: 'EIO' }); }
    return Reflect.apply(target, receiver, args);
  } })); syncBuiltinESMExports();
  try { await assert.rejects(f.shared.close(id, 'Public native completion', token), { code: phase === 'committed' ? 'swarm_partial_commit' : 'swarm_compensation_partial' }); }
  finally { fault.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(injected, true); assert.deepEqual(closeBytes(f, ids), stable);
  if (phase === 'committed') assert.equal((await f.shared.close(id, 'Public native completion', token)).closed, true);
  else await assert.rejects(f.shared.close(id, 'Public native completion', token), { code: 'swarm_close_compensated' });
  assert.deepEqual(closeBytes(f, ids), stable);
});

test('a restore receipt is required before a pending intent can be called compensated', async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1);
  const plan = await prepareClose(f.shared.engine, id, 'Pending only', token, await captureCloseMember(f.shared.engine, id));
  const stable = closeBytes(f, ids);
  await assert.rejects(replayCompensatedClose(f.shared.engine, plan.journal), { code: 'swarm_compensation_partial' }); assert.deepEqual(closeBytes(f, ids), stable);
  await f.client.delete(ids[1], { force: true });
  await assert.rejects(memberDigest(f.shared.engine, ids[1]), { code: 'swarm_compensation_partial' });
});

test('legacy checkpoints without an ordinal mapping remain readable and require explicit close inspection', async t => {
  const { f, id, journal } = await pending(t);
  const source = await getItemAt(id, String(journal.members[0].version), { pmRoot: f.pmRoot }); source.document.metadata[CLOSE_INTENT] = JSON.stringify(journal);
  const root = join(f.repo, 'legacy-checkpoint'); const client = new PmClient({ cwd: f.repo, pmRoot: root, author: 'shared-test', noExtensions: true });
  await client.init('shared-test', { defaults: true, agentGuidance: 'skip' }); const settings = await readSettings(root);
  writeFileSync(getItemPath(root, 'Task', id), serializeItemDocument(source.document, { format: settings.item_format, schema: settings.schema }));
  await appendHistoryEntry(getHistoryPath(root, id), createHistoryEntry({ nowIso: new Date().toISOString(), author: 'legacy-test', op: 'history_compact_baseline', before: emptyImportedDocument(), after: source.document }));
  assert.equal((await client.get(id)).item.title, source.document.metadata.title);
  await assert.rejects(discoverCloseJournal(new Swarm(f.repo, root, client, 'shared-test'), id, undefined), { code: 'swarm_close_recovery_unsupported' });
});
