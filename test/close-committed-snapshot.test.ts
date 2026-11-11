import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import { getHistoryPath, getItemPath, getSettingsPath } from '@unbrained/pm-cli/sdk';
import { CLOSE_INTENT } from '../src/close-journal.ts';
import type { CloseJournal } from '../src/close-journal.ts';
import { replayCommittedClose } from '../src/close-recovery.ts';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { blockedDependent } from './close-native-helpers.ts';
import { closeBytes, recoveryFixture } from './close-recovery-helpers.ts';

/** Preserve all native item and workspace audit bytes across a committed replay. */
function snapshot(f: Awaited<ReturnType<typeof recoveryFixture>>['f'], ids: string[]) {
  return { ...closeBytes(f, ids), settings: readFileSync(getSettingsPath(f.pmRoot), 'utf8'), workspace: readFileSync(getHistoryPath(f.pmRoot, '_workspace'), 'utf8') };
}

/** Complete a real blocker, then hand its unblocked dependent to a different principal. */
async function completedPair(t: Parameters<typeof recoveryFixture>[0]) {
  const fixture = await recoveryFixture(t, 1); const { f, id, token, ids } = fixture;
  const note = 'Public durable completion'; const receipt = await f.shared.close(id, note, token);
  assert.equal((await f.client.get(ids[1])).item.status, 'open');
  const owner = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'dependent-worker'));
  const claim = await owner.start(ids[1]);
  return { ...fixture, note, receipt, owner, dependentToken: claim.token };
}

/** Reuse the identical original close request across both CLI renderers and refusal controls. */
function replayCli(fixture: Awaited<ReturnType<typeof completedPair>>, json: boolean) {
  return fixture.f.cli('swarm', 'close', fixture.id, '--note', fixture.note, '--token', fixture.token, ...(json ? ['--json'] : []));
}

/** SDK and both real CLI renderers replay the same saved result without any item or workspace write. */
async function assertReplay(fixture: Awaited<ReturnType<typeof completedPair>>, ids = fixture.ids): Promise<void> {
  const { f, id, token, note, receipt } = fixture; const before = snapshot(f, ids);
  assert.deepEqual(await f.shared.close(id, note, token), receipt);
  for (const json of [false, true]) {
    const result = replayCli(fixture, json);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const value = json ? JSON.parse(result.stdout) : decodeToon(result.stdout);
    assert.deepEqual(value, receipt);
  }
  assert.deepEqual(snapshot(f, ids), before);
}

test('committed replay survives the unblocked dependent being claimed and progressing without writes', async t => {
  const fixture = await completedPair(t);
  await fixture.f.client.update(fixture.ids[1], { author: 'dependent-worker', description: 'Independent dependent progress' });
  await assertReplay(fixture);
});

test('committed replay survives the unblocked dependent being closed by its owner without writes', async t => {
  const fixture = await completedPair(t);
  await fixture.owner.close(fixture.ids[1], 'Dependent work completed', fixture.dependentToken);
  await assertReplay(fixture);
});

test('committed replay accepts dependent progress then refuses a reopened primary with its typed code', async t => {
  const fixture = await completedPair(t); const { f, id, token, note, ids } = fixture;
  await assertReplay(fixture);
  await f.client.reopen(id, 'New primary work'); const before = snapshot(f, ids);
  await assert.rejects(f.shared.close(id, note, token), { code: 'swarm_compensation_partial' });
  for (const json of [false, true]) {
    const result = replayCli(fixture, json);
    assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /swarm_compensation_partial/);
  }
  assert.deepEqual(snapshot(f, ids), before);
});

test('committed replay authenticates its result digest before returning even a plausible saved receipt', async t => {
  const fixture = await completedPair(t); const { f, id, ids } = fixture;
  await assertReplay(fixture);
  const journal = JSON.parse(String((await f.client.get(id)).item[CLOSE_INTENT])) as CloseJournal;
  const before = snapshot(f, ids);
  for (const forged of [{ ...journal, warnings: ['Unrecorded warning'] }, { ...journal, result_signature: '0'.repeat(128) }]) {
    await assert.rejects(replayCommittedClose(f.shared.engine, forged), { code: 'swarm_compensation_partial' });
  }
  assert.deepEqual(snapshot(f, ids), before);
});

test('committed replay uses the pre-head for an admitted dependent unchanged by native close', async t => {
  const fixture = await recoveryFixture(t, 1); const { f, id, token, ids } = fixture;
  const other = await f.item(); const candidate = await blockedDependent(f, id); ids.push(candidate);
  await f.client.update(candidate, { dep: [`id=${other},kind=blocked_by`] });
  const note = 'Public durable completion'; const receipt = await f.shared.close(id, note, token);
  const journal = JSON.parse(String((await f.client.get(id)).item[CLOSE_INTENT])) as CloseJournal;
  assert.ok(journal.members.some(member => member.id === candidate));
  assert.equal(journal.post.some(member => member.id === candidate), false);
  await f.client.update(candidate, { description: 'Later independent progress' });
  const owner = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'dependent-worker'));
  await assertReplay({ ...fixture, note, receipt, owner, dependentToken: 'unused' });
});

test('committed replay never opens a live dependent document or repeats its completed durability barrier', async t => {
  const fixture = await completedPair(t); const { f, ids } = fixture;
  const dependent = getItemPath(f.pmRoot, 'Task', ids[1]);
  const read = filesystem.readFile; const open = filesystem.open;
  const fault = () => { throw Object.assign(new Error('Live dependent document unavailable'), { code: 'EACCES' }); };
  const readHook = t.mock.method(filesystem, 'readFile', new Proxy(read, { apply(target, receiver, args: unknown[]) { if (args[0] === dependent) return fault(); return Reflect.apply(target, receiver, args); } }));
  const openHook = t.mock.method(filesystem, 'open', new Proxy(open, { apply(target, receiver, args: unknown[]) { if (args[0] === dependent) return fault(); return Reflect.apply(target, receiver, args); } })); syncBuiltinESMExports();
  const before = snapshot(f, ids);
  try { assert.deepEqual(await f.shared.close(fixture.id, fixture.note, fixture.token), fixture.receipt); }
  finally { readHook.mock.restore(); openHook.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(snapshot(f, ids), before);
});


test('committed replay needs dependent history but not a live dependent item after owner deletion', async t => {
  const fixture = await completedPair(t); const { f, ids } = fixture;
  await f.client.delete(ids[1], { author: 'dependent-worker', force: true });
  const path = getItemPath(f.pmRoot, 'Task', ids[1]);
  assert.equal(existsSync(path), false);
  const history = readFileSync(getHistoryPath(f.pmRoot, ids[1]), 'utf8');
  await assertReplay(fixture, [fixture.id]);
  assert.equal(existsSync(path), false);
  assert.equal(readFileSync(getHistoryPath(f.pmRoot, ids[1]), 'utf8'), history);
});
