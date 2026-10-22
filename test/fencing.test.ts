import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs, { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock } from '@unbrained/pm-cli/sdk';
import { createExtensionTestHarness } from '@unbrained/pm-cli/sdk/testing';
import extension from '../index.ts';
import { heartbeatPath, processStart, readRuntime, retryLock, StaleFenceError, withSwarmLease } from '../src/lease.ts';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { sharedFixture } from './shared-helpers.ts';
import { monitorLeaseHolder } from './process-helpers.ts';

/** Bind a separate real worker to the same physical tracker. */
function worker(f: Awaited<ReturnType<typeof sharedFixture>>, author: string) {
  return new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, author));
}

test('handoff atomically publishes owner, higher fence, note and receiver context; ABA writers cannot mutate', async t => {
  const f = await sharedFixture(t); const id = await f.item(['src/one.ts']);
  const first = await f.shared.start(id); assert.equal(first.token, '1');
  const history = join(f.pmRoot, 'history', `${id}.jsonl`);
  const before = readFileSync(history, 'utf8');
  const sameAuthor = worker(f, 'shared-test');
  await assert.rejects(sameAuthor.sync(id, true, ['bad.ts']), StaleFenceError);
  await assert.rejects(f.shared.sync(id, true, ['bad.ts'], '0'), StaleFenceError);
  await assert.rejects(f.shared.handoff(id, 'receiver', 'continue', '0'), StaleFenceError);
  assert.equal(readFileSync(history, 'utf8'), before);
  for (const [to, note] of [['', 'continue'], ['shared-test', 'continue'], ['receiver', ''], ['receiver', 'x'.repeat(4097)]]) await assert.rejects(f.shared.handoff(id, to, note), /requires/);
  for (let index = 0; index < 5; index++) await f.client.run('comments', { id, options: { add: `context ${index}` } });
  const transferBefore = readFileSync(history, 'utf8').trim().split('\n').length;
  const sent = await f.shared.handoff(id, 'receiver', 'Continue with the linked test');
  assert.equal(sent.token, '2'); assert.equal(sent.context.comments.length, 3); assert.equal(sent.context.comments[2].text, 'context 4');
  assert.equal(readFileSync(history, 'utf8').trim().split('\n').length, transferBefore + 1, 'one history transaction');
  const receiver = worker(f, 'receiver');
  const preview = await receiver.next(undefined, true); assert.equal(preview.selected, id); assert.deepEqual(preview.context, sent.context);
  const received = await receiver.next(); assert.equal(received.token, '2'); assert.deepEqual(received.context?.files, ['src/one.ts']);
  await assert.rejects(f.shared.sync(id, true, ['bad.ts'], '1'), StaleFenceError);
  await receiver.heartbeat(id, '2'); await receiver.heartbeat(); await receiver.sync(id, true, ['test/one.test.ts']);
  const back = await receiver.handoff(id, 'shared-test', 'Round trip'); assert.equal(back.token, '3');
  await assert.rejects(f.shared.close(id, 'Old result', '1'), StaleFenceError);
  await assert.rejects(f.shared.heartbeat(id, '1'), StaleFenceError);
  await f.shared.next(); await assert.rejects(f.shared.close(id, ''), /requires/);
  assert.deepEqual(await f.shared.close(id, 'Verified'), { id, closed: true });
  const final = (await f.client.get(id, { depth: 'full' })).item;
  assert.equal(final.status, 'closed'); assert.equal(final.assignee, undefined); assert.equal(final.swarm_token, '4');
  assert.equal((await f.shared.next()).selected, null);
});

test('reclaim preserves live agents, returns stale work to open pool or assigns a context packet', async t => {
  const f = await sharedFixture(t); const dead = await f.item(['dead']); const live = await f.item(['live']); const terminal = await f.item(['done']);
  const deadWorker = worker(f, 'dead-agent'); await deadWorker.start(dead); await f.client.update(dead, { status: 'in_progress' });
  await f.shared.start(live); await f.client.update(terminal, { status: 'closed', message: 'Fixture' }); await f.client.claim(terminal, { force: true, author: 'dead-agent' });
  for (const value of [NaN, Infinity, 0, -1]) await assert.rejects(f.shared.reclaim(value), /positive/);
  await assert.rejects(f.shared.reclaim(10, ''), /positive/);
  assert.deepEqual((await f.shared.reclaim(3600)).recovered, []);
  // Age only disposable fixture evidence; neither SDK nor the system clock is mocked.
  const old = new Date(Date.now() - 120000).toISOString();
  writeFileSync(heartbeatPath(f.pmRoot, 'dead-agent'), JSON.stringify({ heartbeat: old }));
  await f.client.update(dead, { field: [`swarm_claimed_at=${old}`] });
  const reclaimed = (await f.shared.reclaim(60)).recovered;
  assert.equal(reclaimed.length, 1); assert.equal(reclaimed[0].id, dead); assert.equal(reclaimed[0].agent, null); assert.equal(reclaimed[0].token, '2');
  assert.match(reclaimed[0].context.note, /previous owner dead-agent; last heartbeat .*previous token 1; destination pool/);
  const pool = (await f.client.get(dead, { depth: 'full' })).item; assert.equal(pool.status, 'open'); assert.equal(pool.assignee, undefined);
  assert.equal(pool.comments?.at(-1)?.text, reclaimed[0].context.note, 'reclaim evidence is durably appended');
  await assert.rejects(deadWorker.sync(dead, true, ['stale'], '1'), StaleFenceError);
  assert.equal((await f.shared.next()).selected, dead);
  // Legacy SDK-only ownership is reclaimable too, without inventing a heartbeat.
  const legacy = await f.item(['legacy']); await f.client.claim(legacy, { author: 'legacy-agent' });
  await f.client.update(legacy, { field: [`swarm_claimed_at=${old}`] });
  const moved = await f.shared.reclaim(60, 'receiver'); assert.equal(moved.recovered[0].id, legacy);
  const receiver = worker(f, 'receiver'); assert.equal((await receiver.next()).selected, legacy);
  await receiver.sync(legacy, true, ['legacy/result']);
  await receiver.close(legacy, 'Recovered legacy claim');
  assert.deepEqual((await receiver.reclaim(60)).recovered, [], 'fresh transfer grants a heartbeat grace interval');
});

test('renewal outlives the lease, expiry and supersession fail closed, live pins cannot be stolen', async t => {
  const f = await sharedFixture(t); const path = join(f.pmRoot, 'runtime/swarm/operation.json');
  await withSwarmLease(f.pmRoot, 'long-worker', async lease => {
    const initial = readRuntime<{ heartbeat: number }>(path)!.heartbeat;
    await delay(5200); lease.assert();
    assert.ok(readRuntime<{ heartbeat: number }>(path)!.heartbeat > initial);
    assert.ok(readRuntime(heartbeatPath(f.pmRoot, 'long-worker')));
    await assert.rejects(withSwarmLease(f.pmRoot, 'rival', async () => {}, { waitMs: 0 }), /swarm_busy/);
    await lease.write(() => f.client.create({ type: 'Task', title: 'Renewed write' }));
  }, { leaseMs: 5000, renewMs: 100 });
  assert.equal(existsSync(path), false);
  await withSwarmLease(f.pmRoot, 'expired', async lease => {
    const owner = readRuntime<{ heartbeat: number }>(path)!;
    owner.heartbeat = Date.now() - 10000; writeFileSync(path, JSON.stringify(owner));
    await delay(150);
    await assert.rejects(lease.write(() => f.client.create({ type: 'Task', title: 'Must not persist' })), StaleFenceError);
  }, { leaseMs: 5000, renewMs: 50 });
  await withSwarmLease(f.pmRoot, 'superseded', async lease => {
    const owner = readRuntime<{ token: string }>(path)!; owner.token = 'successor'; writeFileSync(path, JSON.stringify(owner));
    assert.throws(lease.assert, StaleFenceError);
  });
  assert.equal(readRuntime<{ token: string }>(path)!.token, 'successor', 'old owner cannot unlink new generation');
  writeFileSync(join(f.pmRoot, 'runtime/swarm/operation-pin.json'), JSON.stringify({ pid: 2147483647, token: 'killed', heartbeat: 0 }));
  await withSwarmLease(f.pmRoot, 'recovered', async lease => { lease.assert(); });
  writeFileSync(path, '{broken'); assert.throws(() => readRuntime(path), SyntaxError);
});

test('lock retries wait through real SDK contention and never retry unrelated or exhausted failures', async t => {
  const f = await sharedFixture(t); const release = await acquireLock(f.pmRoot, 'retry-proof', 1800, 'blocker');
  const pending = retryLock(async () => { const unlock = await acquireLock(f.pmRoot, 'retry-proof', 1800, 'waiter', false, false, 0); await unlock(); return 'retained'; });
  await delay(100); await release(); assert.equal(await pending, 'retained');
  const locked = await acquireLock(f.pmRoot, 'exhausted', 1800, 'blocker');
  await assert.rejects(retryLock(() => acquireLock(f.pmRoot, 'exhausted', 1800, 'waiter', false, false, 0), 0), { code: 'lock_conflict' }); await locked();
  for (const error of [null, 'failure', {}, { code: 'disk_failure' }]) await assert.rejects(retryLock(async () => { throw error; }), value => value === error);
});

test('new registered commands parse tokens and report actionable native errors without git', async t => {
  const f = await sharedFixture(t); const id = await f.item(['src']);
  const harness = await createExtensionTestHarness(extension, { name: 'pm-swarm', capabilities: ['commands', 'schema', 'renderers'] });
  /** Dispatch registered handlers against the real fixture SDK. */
  const run = async (verb: string, args: string[] = [], options: Record<string, unknown> = {}) => (await harness.runCommand({ command: `swarm ${verb}`, pmRoot: f.pmRoot, args, options, global: { author: 'shared-test' } })).result;
  await run('start', [id]); await run('heartbeat'); await run('heartbeat', [id], { token: '1' });
  await assert.rejects(run('handoff', [id]), /requires/); await assert.rejects(run('reclaim'), /positive/); await assert.rejects(run('close', [id]), /requires/);
  await run('reclaim', [], { staleAfter: '3600', to: 'receiver' });
  await run('handoff', [id], { token: '1', to: 'receiver', note: 'Next steps' });
  const result = f.run('swarm', 'next', '--agent', 'receiver'); assert.equal(result.selected, id);
  const refused = f.cli('swarm', 'sync', id, '--agent', 'receiver', '--files', 'new', '--apply', '--token', '1', '--json');
  assert.equal(refused.status, 2); assert.match(refused.stdout + refused.stderr, /swarm_stale_fence/);
  f.run('swarm', 'heartbeat', id, '--agent', 'receiver', '--token', '2');
  f.run('swarm', 'close', id, '--agent', 'receiver', '--token', '2', '--note', 'Complete');
  await assert.rejects(run('close', [id], { note: 'Stale', token: '2' }), /swarm_stale_fence/);
});


test('a real killed lease holder is recovered, and Linux PID reuse does not retain a stale pin', { timeout: 30000 }, async t => {
  const f = await sharedFixture(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { withSwarmLease } from ${JSON.stringify(new URL('../src/lease.ts', import.meta.url).href)}; await withSwarmLease(process.env.PM_PATH, 'killed-worker', async () => { process.stdout.write('ready'); await new Promise(() => {}); });`], { cwd: f.repo, env: f.env });
  const { ready, exit } = monitorLeaseHolder(child); t.after(() => { if (child.signalCode === null) child.kill('SIGKILL'); });
  await ready; child.kill('SIGKILL'); const [code, signal] = await exit;
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  await withSwarmLease(f.pmRoot, 'rescuer', async lease => { lease.assert(); });
  assert.equal(existsSync(join(f.pmRoot, 'runtime/swarm/operation-pin.json')), false);
  assert.equal(processStart(2147483647), undefined);
  if (processStart(process.pid) !== undefined) {
    writeFileSync(join(f.pmRoot, 'runtime/swarm/operation-pin.json'), JSON.stringify({ pid: process.pid, process_start: 'reused-pid', token: 'old' }));
    await withSwarmLease(f.pmRoot, 'new-process', async lease => { lease.assert(); });
  }
});


test('queued operations renew agent liveness while respecting the live process pin', async t => {
  const f = await sharedFixture(t); let entered = () => {};
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let release = () => {}; const resume = new Promise<void>(resolve => { release = resolve; });
  const owner = withSwarmLease(f.pmRoot, 'busy-worker', async () => { entered(); await resume; });
  await ready;
  const waiting = withSwarmLease(f.pmRoot, 'queued-worker', async lease => { lease.assert(); }, { renewMs: 20 });
  const first = readRuntime<{ heartbeat: string }>(heartbeatPath(f.pmRoot, 'queued-worker'))!.heartbeat;
  let second = first;
  try {
    const deadline = Date.now() + 10000;
    while (second === first && Date.now() < deadline) {
      await delay(25);
      second = readRuntime<{ heartbeat: string }>(heartbeatPath(f.pmRoot, 'queued-worker'))!.heartbeat;
    }
  } finally { release(); await Promise.all([owner, waiting]); }
  assert.ok(Date.parse(second) > Date.parse(first));
});

test('unsupported filesystem pin publication fails before invoking a writer', async t => {
  const f = await sharedFixture(t); let writes = 0;
  const injected = t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('Hard links unavailable'), { code: 'EXDEV' }); });
  syncBuiltinESMExports();
  t.after(() => { injected.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(withSwarmLease(f.pmRoot, 'unsupported', async () => { writes++; }), { code: 'EXDEV' });
  assert.equal(writes, 0); assert.equal(existsSync(join(f.pmRoot, 'runtime/swarm/operation-pin.json')), false);
});

test('terminal handoff refuses before writes and reclaim respects fresh legacy claim timestamps', async t => {
  const f = await sharedFixture(t); const terminal = await f.item(['done']); await f.shared.start(terminal);
  await f.client.update(terminal, { status: 'closed', message: 'Fixture complete' });
  await f.client.claim(terminal, { force: true });
  const history = join(f.pmRoot, 'history', `${terminal}.jsonl`); const before = readFileSync(history, 'utf8');
  await assert.rejects(f.shared.handoff(terminal, 'reviewer', 'Continue'), /terminal/);
  assert.equal(readFileSync(history, 'utf8'), before);
  const legacy = await f.item(['fresh']); await f.client.claim(legacy, { author: 'legacy-worker' });
  assert.deepEqual((await f.shared.reclaim(3600)).recovered, []);
});


test('ordered admission prevents newer waiters passing older requests and recovers abandoned tickets', async t => {
  const f = await sharedFixture(t); let entered = () => {}; let release = () => {};
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const owner = withSwarmLease(f.pmRoot, 'holder', async () => { entered(); await resume; });
  await ready;
  const runtime = join(f.pmRoot, 'runtime/swarm'); const order: string[] = [];
  // An incomplete staged record never enters the queue; dead complete tickets are reaped.
  writeFileSync(join(runtime, 'request-000-incomplete.json.staged'), '{');
  writeFileSync(join(runtime, 'request-000-dead.json'), JSON.stringify({ pid: 2147483647, token: 'abandoned' }));
  const attempted: string[] = []; const link = fs.linkSync;
  const observation = t.mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => { attempted.push(String(args[0])); return link(...args); });
  syncBuiltinESMExports();
  const first = withSwarmLease(f.pmRoot, 'first', async () => { order.push('first'); });
  await delay(20);
  const second = withSwarmLease(f.pmRoot, 'second', async () => { order.push('second'); });
  try {
    await delay(250);
    const requests = fs.readdirSync(runtime).filter(name => name.startsWith('request-') && name.endsWith('.json')).sort();
    assert.equal(requests.length, 2);
    assert.ok(attempted.length > 0);
    assert.ok(attempted.every(path => path.endsWith(requests[0])), 'only the oldest live request may attempt the pin');
  } finally {
    observation.mock.restore(); syncBuiltinESMExports(); release(); await Promise.all([owner, first, second]);
  }
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(existsSync(join(runtime, 'request-000-dead.json')), false);
});


test('receiver next respects the requested parent and refuses a mismatched stored context generation', async t => {
  const f = await sharedFixture(t); const parent = (await f.client.create({ type: 'Epic', title: 'Handoff scope' })).item.id;
  const id = await f.item(['scoped']); await f.client.update(id, { parent }); await f.shared.start(id);
  const sent = await f.shared.handoff(id, 'receiver', 'Scoped context'); const receiver = worker(f, 'receiver');
  assert.equal((await receiver.next('another-parent')).selected, null);
  assert.equal((await receiver.next(parent, true)).selected, id);
  await f.client.update(id, { force: true, field: [`swarm_handoff=${JSON.stringify({ ...sent.context, token: 'obsolete' })}`] });
  const history = join(f.pmRoot, 'history', `${id}.jsonl`); const before = readFileSync(history, 'utf8');
  await assert.rejects(receiver.next(parent), StaleFenceError);
  assert.equal(readFileSync(history, 'utf8'), before);
});
