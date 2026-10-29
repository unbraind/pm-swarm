import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import fs, { existsSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { withSwarmLease, heartbeatPath, readRuntime } from '../src/lease.ts';
import { SettingsRefusal } from '../src/settings.ts';
import { sharedFixture } from './shared-helpers.ts';
import { unchanged, snapshot } from './privacy-snapshot.ts';

/** A refused input is deliberately raised after real lease acquisition and optional renewals. */
async function refused(): Promise<never> { await delay(15); throw new SettingsRefusal('swarm_input_invalid', 'Use valid fixture input.'); }

/** A failed acquisition restores every tracker byte and leaves the next real operation usable. */
async function recovered(pmRoot: string, before: string, injected: boolean): Promise<void> {
  assert.equal(injected, true); assert.equal(snapshot(pmRoot), before);
  assert.equal(await withSwarmLease(pmRoot, 'shared-test', async () => 'Recovered'), 'Recovered');
}

test('refused lease validation neither announces liveness nor changes cold or existing runtime', async t => {
  const f = await sharedFixture(t); const id = await f.item();
  await unchanged(f.pmRoot, () => withSwarmLease(f.pmRoot, 'shared-test', refused, { renewMs: 2 }), 'lease/cold-refusal');
  let first = '';
  await withSwarmLease(f.pmRoot, 'shared-test', async lease => {
    await lease.write(() => f.client.comments(id, { add: 'Admitted write' }));
    first = readFileSync(heartbeatPath(f.pmRoot, 'shared-test'), 'utf8');
    await delay(20);
  }, { renewMs: 2 });
  assert.notEqual(readFileSync(heartbeatPath(f.pmRoot, 'shared-test'), 'utf8'), first);
  await unchanged(f.pmRoot, () => withSwarmLease(f.pmRoot, 'shared-test', refused, { renewMs: 2 }), 'lease/existing-refusal');
});

/** Inject one real filesystem transition at the first request write, retaining all actual SDK behavior. */
function observeRequest(t: TestContext, root: string, transition: (args: unknown[]) => void) {
  let injected = false; let restored = false; const original = fs.openSync;
  const observation = t.mock.method(fs, 'openSync', new Proxy(original, { apply(target, receiver, args: unknown[]) {
    if (!injected && String(args[0]).startsWith(join(root, 'request-'))) { injected = true; transition(args); }
    return Reflect.apply(target, receiver, args);
  } }));
  syncBuiltinESMExports();
  const restore = () => { if (restored) return; restored = true; observation.mock.restore(); syncBuiltinESMExports(); };
  t.after(restore);
  return { injected: () => injected, restore };
}

test('request publication survives a peer removing the empty runtime at its first write boundary', async t => {
  const f = await sharedFixture(t); const root = join(f.pmRoot, 'runtime/swarm');
  const observation = observeRequest(t, root, () => rmdirSync(root));
  await unchanged(f.pmRoot, () => withSwarmLease(f.pmRoot, 'shared-test', refused), 'lease/parent-removal', error => error instanceof SettingsRefusal);
  assert.equal(observation.injected(), true);
});

test('refusal cleanup preserves a peer runtime record and removes only its own lease generations', async t => {
  const f = await sharedFixture(t); const root = join(f.pmRoot, 'runtime/swarm');
  const peer = join(root, 'peer.json');
  await assert.rejects(withSwarmLease(f.pmRoot, 'shared-test', async () => { writeFileSync(peer, '{"owner":"peer"}'); return refused(); }), SettingsRefusal);
  assert.equal(readFileSync(peer, 'utf8'), '{"owner":"peer"}');
  assert.deepEqual(readdirSync(root), ['peer.json']);
  assert.equal(readRuntime(join(root, 'operation-pin.json')), undefined);
});

test('a real request I/O refusal leaves no receipt or lease residue and a rerun converges', async t => {
  const f = await sharedFixture(t); const root = join(f.pmRoot, 'runtime/swarm');
  const before = snapshot(f.pmRoot); const observation = observeRequest(t, root, args => { args[0] = root; });
  try { await assert.rejects(withSwarmLease(f.pmRoot, 'shared-test', async () => 'unreachable'), /EISDIR/); }
  finally { observation.restore(); }
  assert.equal(observation.injected(), true); assert.equal(snapshot(f.pmRoot), before);
  assert.equal(await withSwarmLease(f.pmRoot, 'shared-test', async () => 'admitted'), 'admitted');
  assert.equal(readdirSync(root).length, 1, 'one principal heartbeat, no duplicate requests or pins');
});

for (const scenario of ['peer removed empty root', 'cleanup I/O failure'] as const) {
  test(`owned runtime cleanup handles ${scenario} without deleting foreign state`, async t => {
    const f = await sharedFixture(t); const root = join(f.pmRoot, 'runtime/swarm'); let injected = false;
    const blocker = join(f.repo, 'retained-file'); writeFileSync(blocker, 'Retain this data');
    const before = snapshot(f.pmRoot); const original = fs.rmdirSync;
    const observation = t.mock.method(fs, 'rmdirSync', new Proxy(original, { apply(target, receiver, args: unknown[]) {
      if (!injected && String(args[0]) === root) {
        injected = true;
        if (scenario === 'peer removed empty root') Reflect.apply(target, receiver, args);
        else args[0] = blocker;
      }
      return Reflect.apply(target, receiver, args);
    } }));
    syncBuiltinESMExports();
    try { await assert.rejects(withSwarmLease(f.pmRoot, 'shared-test', refused), scenario === 'cleanup I/O failure' ? /ENOTDIR/ : SettingsRefusal); }
    finally { observation.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(injected, true); assert.equal(readFileSync(blocker, 'utf8'), 'Retain this data');
    if (scenario === 'peer removed empty root') assert.equal(snapshot(f.pmRoot), before);
    else {
      assert.equal(existsSync(join(root, 'operation.json')), false);
      assert.equal(await withSwarmLease(f.pmRoot, 'shared-test', async () => 'recovered'), 'recovered');
    }
  });
}

test('a failure removing the request after pin acquisition still removes every owned lease generation', async t => {
  const f = await sharedFixture(t); const root = join(f.pmRoot, 'runtime/swarm');
  const before = snapshot(f.pmRoot); let injected = false; const original = fs.unlinkSync;
  const observation = t.mock.method(fs, 'unlinkSync', new Proxy(original, { apply(target, receiver, args: unknown[]) {
    if (!injected && String(args[0]).startsWith(join(root, 'request-')) && existsSync(join(root, 'operation-pin.json'))) { injected = true; throw new Error('Injected post-pin request cleanup failure'); }
    return Reflect.apply(target, receiver, args);
  } }));
  syncBuiltinESMExports();
  try { await assert.rejects(withSwarmLease(f.pmRoot, 'shared-test', async () => 'unreachable'), /Injected post-pin/); }
  finally { observation.mock.restore(); syncBuiltinESMExports(); }
  await recovered(f.pmRoot, before, injected);
});

test('a failed atomic runtime rename removes its owned temporary without announcing liveness', async t => {
  const f = await sharedFixture(t); const root = join(f.pmRoot, 'runtime/swarm');
  const before = snapshot(f.pmRoot); let injected = false; const original = fs.renameSync;
  const observation = t.mock.method(fs, 'renameSync', new Proxy(original, { apply(target, receiver, args: unknown[]) {
    if (!injected && String(args[0]).startsWith(join(root, 'request-'))) { injected = true; throw new Error('Injected publication rename failure'); }
    return Reflect.apply(target, receiver, args);
  } }));
  syncBuiltinESMExports();
  try { await assert.rejects(withSwarmLease(f.pmRoot, 'shared-test', async () => 'unreachable'), /Injected publication/); }
  finally { observation.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(injected, true); assert.equal(snapshot(f.pmRoot), before);
});

test('runtime publication refuses a foreign temporary collision without truncating or deleting it', async t => {
  const f = await sharedFixture(t); const root = join(f.pmRoot, 'runtime/swarm'); let foreign = '';
  const original = fs.openSync;
  const observation = t.mock.method(fs, 'openSync', new Proxy(original, { apply(target, receiver, args: unknown[]) {
    if (foreign === '' && String(args[0]).startsWith(join(root, 'request-'))) { foreign = String(args[0]); writeFileSync(foreign, 'Foreign receipt'); }
    return Reflect.apply(target, receiver, args);
  } }));
  syncBuiltinESMExports();
  try { await assert.rejects(withSwarmLease(f.pmRoot, 'shared-test', async () => 'unreachable'), /EEXIST/); }
  finally { observation.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(readFileSync(foreign, 'utf8'), 'Foreign receipt');
  assert.deepEqual(readdirSync(root), [foreign.slice(root.length + 1)]);
  assert.equal(await withSwarmLease(f.pmRoot, 'shared-test', async () => 'Recovered'), 'Recovered');
});

test('runtime cleanup owns the file immediately after exclusive open even when writing loses its return', async t => {
  const f = await sharedFixture(t); const root = join(f.pmRoot, 'runtime/swarm'); const before = snapshot(f.pmRoot);
  let descriptor: number | undefined; let injected = false;
  const opened = fs.openSync; const written = fs.writeFileSync;
  const acquisition = t.mock.method(fs, 'openSync', new Proxy(opened, { apply(target, receiver, args: unknown[]) {
    const result: number = Reflect.apply(target, receiver, args);
    if (String(args[0]).startsWith(join(root, 'request-'))) descriptor = result;
    return result;
  } }));
  const write = t.mock.method(fs, 'writeFileSync', new Proxy(written, { apply(target, receiver, args: unknown[]) {
    const result: unknown = Reflect.apply(target, receiver, args);
    if (!injected && (typeof args[0] === 'string' ? args[0].startsWith(join(root, 'request-')) : descriptor !== undefined && args[0] === descriptor)) { injected = true; throw new Error('Injected failure after exclusive runtime write'); }
    return result;
  } })); syncBuiltinESMExports();
  try { await assert.rejects(withSwarmLease(f.pmRoot, 'shared-test', async () => 'unreachable'), /Injected failure after exclusive/); }
  finally { write.mock.restore(); acquisition.mock.restore(); syncBuiltinESMExports(); }
  await recovered(f.pmRoot, before, injected);
});
