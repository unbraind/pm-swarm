import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { dirname } from 'node:path';
import { getHistoryPath, getItemPath } from '@unbrained/pm-cli/sdk';
import { captureCloseMember, CLOSE_INTENT, withCloseObserver } from '../src/close-journal.ts';
import { commitItemMutation, SettingsRefusal, syncNativeArtifacts } from '../src/settings.ts';
import { closeBytes, recoveryFixture } from './close-recovery-helpers.ts';
import { prepareClose } from '../src/close-recovery.ts';
import { nativeBytes, nativeCloseOracle } from './close-native-helpers.ts';

/** Observe real file-handle flushes while delegating every filesystem operation unchanged. */
function observeArtifactBarriers(t: TestContext, observers: { opened?: (mode: unknown) => void; synced?: (path: unknown) => void }): () => void {
  const open = filesystem.open;
  const probe = t.mock.method(filesystem, 'open', new Proxy(open, { async apply(target, receiver, args: unknown[]) {
    observers.opened?.(args[1]);
    const handle = await Reflect.apply(target, receiver, args) as Awaited<ReturnType<typeof filesystem.open>>; const synchronize = handle.sync.bind(handle);
    t.mock.method(handle, 'sync', async () => { observers.synced?.(args[0]); await synchronize(); }); return handle;
  } })); syncBuiltinESMExports();
  return () => { probe.mock.restore(); syncBuiltinESMExports(); };
}

test('a certified committed close retires for reopened work under a new fenced claim', async t => {
  const { f, id, token } = await recoveryFixture(t, 1);
  await f.shared.close(id, 'First completion', token);
  const first = JSON.parse(String((await f.client.get(id)).item[CLOSE_INTENT])) as { compensation_id: string };
  await f.client.reopen(id, 'Additional public work'); const next = await f.shared.start(id);
  assert.ok(BigInt(next.token) > BigInt(token));
  await assert.rejects(f.shared.close(id, 'First completion', token), { code: 'swarm_stale_fence' });
  assert.equal((await f.shared.close(id, 'Second completion', next.token)).closed, true);
  const after = (await f.client.get(id)).item;
  assert.notEqual((JSON.parse(String(after[CLOSE_INTENT])) as { compensation_id: string }).compensation_id, first.compensation_id);
  assert.equal(after.swarm_token, String(BigInt(next.token) + 1n));
  const stable = closeBytes(f, [id]);
  assert.equal((await f.shared.close(id, 'Second completion', next.token)).closed, true); assert.deepEqual(closeBytes(f, [id]), stable);
});

test('prepared native writes return complete private-safe refusals for ordinary and portable errors', async t => {
  const { f, id } = await recoveryFixture(t, 0); const privateText = ['', 'home', 'private', 'preparation'].join('/');
  const portable = { code: 'swarm_superseded', remedy: 'Preserve native history.', field: 'history' };
  const cases: { value: unknown; typed?: boolean; noField?: boolean }[] = [
    { value: new Error(privateText) }, { value: Object.assign(new Error(privateText), { code: 'EIO' }) },
    ...[undefined, null, 17, privateText, {}, { code: 'EIO', remedy: 'Storage unavailable' }, { code: 'swarm_superseded', remedy: 17 }, { ...portable, remedy: '' }, { ...portable, field: 17 }, new Proxy({}, { get() { throw new Error(privateText); } })].map(value => ({ value })),
    { value: new SettingsRefusal('swarm_superseded', privateText, 'history') },
    { value: new SettingsRefusal('swarm_superseded', portable.remedy, portable.field), typed: true }, { value: portable, typed: true }, { value: new SettingsRefusal('swarm_superseded', portable.remedy), typed: true, noField: true },
  ];
  for (const { value, typed, noField } of cases) {
    const before = closeBytes(f, [id]); const snapshot = await captureCloseMember(f.shared.engine, id);
    await assert.rejects(commitItemMutation({ id, item: snapshot.item, options: { description: 'Must remain uncommitted' } }, admitted => f.client.update(admitted.id, admitted.options), { history: snapshot.historyHead, onPrepared: async () => { throw value; } }), error => {
      assert.ok(error instanceof SettingsRefusal);
      assert.equal(error.code, typed ? portable.code : 'swarm_prewrite_failed');
      assert.equal(error.field, typed ? noField ? undefined : portable.field : 'document'); assert.ok(error.remedy.length > 0);
      assert.equal(error.message.includes(privateText), false); assert.equal(error.message.includes('undefined'), false);
      return true;
    });
    assert.deepEqual(closeBytes(f, [id]), before);
  }
});

test('unrelated artifact sync failures cannot prevent an otherwise admitted native close', async t => {
  const { f, id, token } = await recoveryFixture(t, 1); const unrelated = await f.item(); const path = getItemPath(f.pmRoot, 'Task', unrelated); const before = closeBytes(f, [unrelated]);
  const open = filesystem.open;
  const fault = t.mock.method(filesystem, 'open', new Proxy(open, { apply(target, receiver, args: unknown[]) {
    if (args[0] === path && new Error().stack?.includes('syncNativeArtifacts')) throw Object.assign(new Error('Unrelated artifact unavailable for sync'), { code: 'EACCES' });
    return Reflect.apply(target, receiver, args);
  } })); syncBuiltinESMExports();
  try { assert.equal((await f.shared.close(id, 'Public native completion', token)).closed, true); }
  finally { fault.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(closeBytes(f, [unrelated]), before);
});

test('Windows artifact barriers flush existing files through writable handles without POSIX directory opens', async t => {
  const { f, id } = await recoveryFixture(t, 0); const path = getItemPath(f.pmRoot, 'Task', id); const before = readFileSync(path, 'utf8');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!; const modes: unknown[] = []; let syncs = 0;
  const restore = observeArtifactBarriers(t, { opened: mode => { modes.push(mode); }, synced: () => { syncs++; } });
  try { Object.defineProperty(process, 'platform', { value: 'win32' }); await syncNativeArtifacts([path]); }
  finally { Object.defineProperty(process, 'platform', platform); restore(); }
  assert.deepEqual(modes, ['r+']); assert.equal(syncs, 1); assert.equal(readFileSync(path, 'utf8'), before);
});


test('compensation of reopened work replays its own receipt while retaining the older committed intent', async t => {
  const { f, id, token } = await recoveryFixture(t, 1);
  await f.shared.close(id, 'First completion', token); await f.client.reopen(id, 'Additional work');
  const next = await f.shared.start(id); const before = closeBytes(f, [id]);
  await assert.rejects(withCloseObserver(boundary => { if (boundary === 'before_commit') throw new Error('Interrupted second completion'); }, () => f.shared.close(id, 'Second completion', next.token)), { code: 'swarm_close_compensated' });
  assert.deepEqual(closeBytes(f, [id]).items, before.items); const stable = closeBytes(f, [id]);
  await assert.rejects(f.shared.close(id, 'Second completion', next.token), { code: 'swarm_close_compensated' }); assert.deepEqual(closeBytes(f, [id]), stable);
  const third = await f.shared.start(id); assert.ok(BigInt(third.token) > BigInt(next.token));
  assert.equal((await f.shared.close(id, 'Third completion', third.token)).closed, true);
});


test('the native dependency index bounds admission and preserves scalar, typed and reverse-edge close policy', async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1);
  const typed = await f.item(); const reversed = await f.item(); const unrelated = await f.item();
  await f.client.update(typed, { status: 'blocked', dep: [`id=${id},kind=blocked_by`], blockedReason: 'Public typed dependency' });
  await f.client.update(reversed, { status: 'blocked', blockedReason: 'Public reverse dependency' });
  await f.client.update(id, { dep: [`id=${reversed},kind=blocks`] });
  const members = [...ids, typed, reversed]; const stable = closeBytes(f, [unrelated]);
  const plan = await prepareClose(f.shared.engine, id, 'Public indexed completion', token, await captureCloseMember(f.shared.engine, id));
  assert.deepEqual(plan.journal.members.map(member => member.id).sort(), [...members].sort());
  const oracle = await nativeCloseOracle(f, id, 'Public indexed completion');
  const receipt = await f.shared.close(id, 'Public indexed completion', token);
  assert.deepEqual(receipt.warnings ?? [], oracle.result.warnings);
  assert.deepEqual(members.map(member => nativeBytes(f.pmRoot, member)), members.map(member => nativeBytes(oracle.root, member)));
  assert.deepEqual(closeBytes(f, [unrelated]), stable);
});


test('a newer claim cannot retire an unowned committed marker without its native success receipt', async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1);
  const prepared = await prepareClose(f.shared.engine, id, 'Unowned old completion', token, await captureCloseMember(f.shared.engine, id));
  const forged = { ...prepared.journal, phase: 'committed', warnings: [] };
  const next = String(BigInt(token) + 1n);
  await f.client.update(id, { force: true, field: [`${CLOSE_INTENT}=${JSON.stringify(forged)}`, `swarm_token=${next}`] });
  const before = closeBytes(f, ids);
  await assert.rejects(f.shared.close(id, 'New completion', next), { code: 'swarm_close_recovery_unsupported' }); assert.deepEqual(closeBytes(f, ids), before);
});


test('every actual native close target flushes its preimage files before its signed proposal', async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1); let preparing: string | undefined;
  const barriers = new Map(ids.map(member => [member, new Set<string>()]));
  const restore = observeArtifactBarriers(t, { synced: path => {
    if (preparing !== undefined && typeof path === 'string' && new Error().stack?.includes('syncNativeArtifacts')) barriers.get(preparing)!.add(path);
  } });
  try {
    assert.equal((await withCloseObserver((boundary, member) => {
      if (boundary === 'before_proposal') preparing = member; else if (boundary === 'proposal') preparing = undefined;
    }, () => f.shared.close(id, 'Public native completion', token))).closed, true);
  } finally { restore(); }
  for (const member of ids) {
    const item = getItemPath(f.pmRoot, 'Task', member); const history = getHistoryPath(f.pmRoot, member);
    for (const path of [item, history, dirname(item), dirname(history)]) assert.ok(barriers.get(member)!.has(path), 'The exact native preimage and parent entries must be synced before proposal persistence');
  }
});
