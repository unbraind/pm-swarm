import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { getHistoryPath, getItemPath, readSettings } from '@unbrained/pm-cli/sdk';
import { memberDigest, syncCloseMember } from '../src/close-journal.ts';
import { inspectItem } from '../src/inspection.ts';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { closeProcess } from './close-recovery-helpers.ts';
import { fixture } from './helpers.ts';
import { sharedFixture } from './shared-helpers.ts';

const TYPES = [
  { name: 'ReviewPacket', folder: 'review-packets', aliases: ['packet-alias'], execution_role: 'agent' },
  { name: 'ApprovalCheckpoint', folder: 'approval-checkpoints', execution_role: 'gate' },
];
type Tracker = Pick<Awaited<ReturnType<typeof sharedFixture>>, 'repo' | 'pmRoot' | 'client'>;

/** Install a real extension; types are supplied only by registerItemTypes, never tracker settings. */
async function registerTypes(f: Tracker): Promise<string> {
  const directory = join(f.pmRoot, 'extensions/pm-lifecycle-types'); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ name: 'pm-lifecycle-types', version: '2026.11.11', entry: 'entry.js', capabilities: ['schema'] }));
  writeFileSync(join(directory, 'entry.js'), `export default { activate(api) { api.registerItemTypes(${JSON.stringify(TYPES)}); } };\n`);
  assert.equal((await readSettings(f.pmRoot)).item_types?.definitions?.some(type => TYPES.some(row => row.name === type.name)), false);
  return directory;
}

/** Read the fixture's deliberately registered storage paths and complete native audit streams. */
function bytes(f: Tracker, rows: { id: string; type: number }[]) {
  const folders = Object.fromEntries(TYPES.map(type => [type.name, type.folder]));
  return rows.map(row => [readFileSync(getItemPath(f.pmRoot, TYPES[row.type].name, row.id, 'toon', folders), 'utf8'), readFileSync(getHistoryPath(f.pmRoot, row.id), 'utf8')]);
}

test('claim then close an extension-registered type matches native pm close and replays through SDK JSON and TOON', async t => {
  const f = await sharedFixture(t); await registerTypes(f);
  const id = (await f.client.create({ type: 'packet-alias', title: 'Registered lifecycle work' })).item.id;
  const inspected = await inspectItem(f.pmRoot, f.repo, id); assert.ok(inspected); assert.equal(inspected.item.id, id);
  const claim = await f.shared.start(id); const note = 'Verified extension work';
  const oracle = join(f.repo, 'native-oracle'); cpSync(f.pmRoot, oracle, { recursive: true });
  const native = f.run('close', id, note, '--path', oracle);
  const closed = await f.shared.close(id, note, claim.token);
  const warnings = native.warnings as string[] | undefined;
  assert.equal(native.status, 'closed'); assert.equal(native.close_reason, note);
  assert.deepEqual(closed, { id: native.id, closed: native.status === 'closed', ...(warnings?.length ? { warnings } : {}) });
  assert.equal((await f.client.get(id)).item.status, 'closed');
  const stable = bytes(f, [{ id, type: 0 }]);
  assert.deepEqual(await f.shared.close(id, note, claim.token), closed);
  for (const json of [false, true]) {
    const replay = f.cli('swarm', 'close', id, '--note', note, '--token', claim.token, ...(json ? ['--json'] : []));
    assert.equal(replay.status, 0, replay.stdout + replay.stderr);
  }
  assert.deepEqual(bytes(f, [{ id, type: 0 }]), stable);
});

test('an interrupted extension-typed close restores the primary and dependent and stays replayable', async t => {
  const f = await sharedFixture(t); await registerTypes(f);
  const id = (await f.client.create({ type: TYPES[0].name, title: 'Extension primary' })).item.id;
  const claim = await f.shared.start(id);
  const dependent = (await f.client.create({ type: TYPES[1].name, title: 'Extension dependent', status: 'blocked', blockedBy: id })).item.id;
  const rows = [{ id, type: 0 }, { id: dependent, type: 1 }]; const before = bytes(f, rows);
  const killed = closeProcess(f, id, claim.token, { kill: { boundary: 'closed' } });
  assert.deepEqual({ signal: killed.signal, status: (await f.client.get(id)).item.status }, { signal: 'SIGKILL', status: 'closed' }, killed.stdout + killed.stderr);
  const retry = closeProcess(f, id, claim.token);
  assert.equal(retry.outcome?.code, 'swarm_close_compensated', retry.stdout + retry.stderr);
  const after = bytes(f, rows);
  for (const [index, row] of after.entries()) { assert.equal(row[0], before[index][0]); assert.ok(row[1].startsWith(before[index][1])); }
  assert.notEqual((await f.client.get(id)).item.status, 'closed');
  assert.equal(closeProcess(f, id, claim.token).outcome?.code, 'swarm_close_compensated');
  assert.deepEqual(bytes(f, rows), after);
});

test('a live extension type is accepted but unregistered storage still refuses with the typed code', async t => {
  const f = await sharedFixture(t); const directory = await registerTypes(f);
  const id = (await f.client.create({ type: TYPES[0].name, title: 'Registered then unavailable' })).item.id;
  const stable = bytes(f, [{ id, type: 0 }]);
  assert.match(await memberDigest(f.shared.engine, id), /^[a-f0-9]{64}$/); await syncCloseMember(f.shared.engine, id);
  const inactive = join(f.repo, 'inactive-types'); renameSync(directory, inactive);
  try {
    await assert.rejects(memberDigest(f.shared.engine, id), { code: 'swarm_compensation_partial' });
    await assert.rejects(syncCloseMember(f.shared.engine, id), { code: 'swarm_compensation_partial' });
    assert.deepEqual(bytes(f, [{ id, type: 0 }]), stable);
  } finally { renameSync(inactive, directory); }
});

test('shared candidate selection honors live extension execution roles', async t => {
  const f = await sharedFixture(t); await registerTypes(f);
  const ready = (await f.client.create({ type: TYPES[0].name, title: 'Agent work', priority: 2 })).item.id;
  const gate = (await f.client.create({ type: TYPES[1].name, title: 'Gate outcome', priority: 0 })).item.id;
  const { candidates } = await f.shared.engine.readyCandidates(undefined, false);
  assert.ok(candidates.some(candidate => candidate.id === ready)); assert.equal(candidates.some(candidate => candidate.id === gate), false);
  assert.equal((await f.shared.next(undefined, true)).selected, ready);
});

test('extension-typed Git lanes close and reap through the guarded native writer', async t => {
  const f = await fixture(t); await registerTypes(f);
  const id = (await f.client.create({ type: TYPES[0].name, title: 'Extension lane' })).item.id; f.save();
  await f.swarm.start(id);
  const item = (await f.client.get(id)).item; const token = item.swarm_token === undefined ? undefined : String(item.swarm_token);
  assert.equal((await new SharedTracker(f.swarm).close(id, 'Verified native lane', token)).closed, true);
  assert.ok((await f.swarm.reap()).removed.includes(id));
});


test('handoff of an extension-typed item closes under the receiver and preserves stale-owner refusal', async t => {
  const f = await sharedFixture(t); await registerTypes(f);
  const id = (await f.client.create({ type: TYPES[0].name, title: 'Extension transfer' })).item.id;
  const held = await f.shared.start(id); const sent = await f.shared.handoff(id, 'type-receiver', 'Continue extension work', held.token);
  const receiver = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'type-receiver'));
  await assert.rejects(f.shared.close(id, 'Stale owner', held.token), { code: 'swarm_stale_fence' });
  assert.equal((await receiver.close(id, 'Verified transferred work', sent.token)).closed, true);
});
