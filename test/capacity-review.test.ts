import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Capacities, SharedTracker, Swarm, interruptLane, withStartTransitionObserver } from '../index.ts';
import { reissueHandoff } from '../src/handoff-context.ts';
import { gitRecords } from '../src/git.ts';
import { interruptions } from '../src/interruption.ts';
import { readItemHistoryHead } from '../src/settings.ts';
import { fixture } from './helpers.ts';
import { runProcess } from './process-helpers.ts';
import { sharedFixture } from './shared-helpers.ts';

/** Declare a real native window and its admission policy. */
async function window(capacity: Capacities, name: string, now: number, otherwise = 3) {
  await capacity.run(name, { action: 'declare', unit: 'percent', limit: 100, window: '7d', resetsAt: new Date(now + 3_600_000).toISOString() });
  await capacity.run(name, { action: 'policy', else: otherwise });
}

test('review clock-ahead samples cannot hide exhaustion from status and admission', async t => {
  const f = await sharedFixture(t);
  const now = Date.now();
  const capacity = new Capacities(f.shared.engine, () => now + 60_000);
  await window(capacity, 'runner', now);
  for (const [at, used] of [[now - 1_000, 100], [now + 30_000, 1]]) {
    await capacity.run('runner', { action: 'observe', used, source: 'manual', at: new Date(at).toISOString() });
  }
  const id = await f.item(['src/clock.ts']);
  const clock = t.mock.method(Date, 'now', () => now);
  try {
    const status = await new Capacities(f.shared.engine).run('runner');
    assert.equal(status.used, 100);
    assert.equal(status.exhausted, true);
    assert.equal(status.available_lanes, 0);
    await assert.rejects(f.shared.start(id, {}, true, 'runner'), /capacity_exhausted/);
    await assert.rejects(f.shared.next(undefined, true, undefined, 'runner'), /capacity_exhausted/);
  } finally { clock.mock.restore(); }
});

test('review tracker retry preserves the explicit selector and runs from the same cwd', async t => {
  const f = await sharedFixture(t);
  const capacity = new Capacities(f.shared.engine);
  await window(capacity, 'runner', Date.now(), 0);
  await window(capacity, 'spare', Date.now());
  const id = await f.item(['src/retry.ts']);
  const result = f.cli('--path', f.pmRoot, 'swarm', 'start', id, '--capacity', 'runner,spare', '--json');
  assert.equal(result.status, 2);
  const failure = JSON.parse(result.stderr || result.stdout) as { code: string; details: { next_command: string } };
  assert.equal(failure.code, 'capacity_policy_denied');
  assert.match(failure.details.next_command, /--path .*\.agents\/pm/);
  assert.ok(!failure.details.next_command.includes(f.pmRoot));
  const environment = { ...f.env, PM_PATH: 'missing-tracker', SWARM_TEST_NODE: process.execPath, SWARM_TEST_HOST: f.host };
  const retry = await runProcess('/bin/sh', ['-ec', 'pm() { "$SWARM_TEST_NODE" "$SWARM_TEST_HOST" "$@"; }\n' + failure.details.next_command + ' --json'], f.repo, environment);
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).capacity, 'spare');

  const missing = await runProcess(process.execPath, [f.host, '--path', '.', 'swarm', 'capacity', 'missing', '--json'], f.pmRoot, f.env);
  assert.equal(missing.code, 2);
  const recovery = JSON.parse(missing.stderr || missing.stdout);
  assert.equal(recovery.details.next_command, 'pm swarm capacity --help --path .');
});

test('review oversized Git evidence preserves complete paths and exact budget omissions', async t => {
  const f = await fixture(t);
  const id = await f.item(['src/large.ts']);
  const lane = await f.swarm.start(id);
  const directory = join(lane.worktree!, 'local');
  mkdirSync(directory);
  const paths = Array.from({ length: 13_000 }, (_, i) => 'local/' + String(i).padStart(5, '0') + '-' + 'x'.repeat(72) + '\nname');
  for (const path of paths) writeFileSync(join(lane.worktree!, path), '');
  const packet = await new SharedTracker(f.swarm).continuation(id, 'receiver', undefined, 800);
  const shown = packet.context.uncommitted_paths ?? [];
  assert.ok(shown.length > 0);
  assert.deepEqual(shown, paths.slice(0, shown.length));
  assert.equal(shown.length + Number(packet.omission_receipt.uncommitted_paths), paths.length);
});

test('review live intake checks a provider added after an unbound corpus read', async t => {
  const f = await sharedFixture(t);
  const id = await f.item(['src/intake.ts']);
  const claim = await f.shared.start(id);
  const transfer = await f.shared.handoff(id, 'receiver', 'Public checkpoint', claim.token);
  const receiver = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'receiver'));
  await window(new Capacities(f.shared.engine), 'runner', Date.now(), 0);
  const read = receiver.engine.readyCandidates.bind(receiver.engine);
  let field = ['swarm_capacity=runner'];
  const edit = t.mock.method(receiver.engine, 'readyCandidates', async (...args: Parameters<Swarm['readyCandidates']>) => {
    const corpus = await read(...args);
    await f.client.update(id, { author: 'receiver', field });
    return corpus;
  });
  try {
    await assert.rejects(receiver.next(), /capacity_policy_denied/);
    const status = await new Capacities(f.shared.engine).run('runner');
    const stop = {
      capacity: 'runner', agent: 'receiver', token: transfer.token, reason: 'capacity_exhausted',
      at: new Date().toISOString(), resets_at: status.resets_at, used: null, forecast: null,
    };
    field = ['swarm_interruptions=' + JSON.stringify([stop])];
    await assert.rejects(receiver.next(), /capacity_exhausted/);
  } finally { edit.mock.restore(); }
  assert.equal((await f.client.get(id, { depth: 'full' })).item.swarm_token, transfer.token);
});

test('review token publications keep live handoff, capacity and interruption fields coherent', async t => {
  const f = await fixture(t);
  const capacity = new Capacities(f.swarm);
  await window(capacity, 'runner', Date.now());
  await window(capacity, 'spare', Date.now());
  const shared = new SharedTracker(f.swarm);
  const receiver = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'receiver'));
  /** Verify the durable current generation after each native entry point. */
  const consistent = async (id: string, token: string, binding?: string) => {
    const { item } = await f.client.get(id, { depth: 'full' });
    assert.equal(item.swarm_token, token);
    if (item.swarm_handoff !== undefined) assert.equal(JSON.parse(String(item.swarm_handoff)).token, token);
    assert.equal(item.swarm_capacity, binding);
    for (const stop of interruptions(item)) assert.ok(stop.token === null || stop.token === token);
    return item;
  };
  const id = await f.item(['src/attach.ts']);
  const first = await shared.start(id, {}, true, 'runner');
  await consistent(id, first.token, 'runner');
  const sent = await shared.handoff(id, 'receiver', 'Continue work', first.token);
  await consistent(id, sent.token, 'runner');
  await assert.rejects(withStartTransitionObserver(stage => {
    if (stage === 'published') throw new Error('test rollback');
  }, () => receiver.engine.start(id)), /test rollback/);
  const rolled = await consistent(id, String(BigInt(sent.token) + 1n), 'runner');
  assert.equal(JSON.parse(String(rolled.swarm_handoff)).note, 'Continue work');
  assert.equal(rolled.swarm_branch, undefined);
  const attached = await receiver.engine.start(id);
  assert.equal((await consistent(id, attached.token!, 'runner')).swarm_handoff, undefined);
  await interruptLane(receiver.engine, id, attached.token, 'runner', 'capacity_exhausted');
  await consistent(id, attached.token!, 'runner');
  const packet = await receiver.continuation(id, f.swarm.author, attached.token, 800, 'spare');
  assert.equal(packet.interruption?.token, attached.token);
  await consistent(id, packet.token, 'spare');
  assert.equal((await capacity.run('runner')).reported_exhausted, true);
  await shared.close(id, 'Work complete', packet.token);
  await consistent(id, String(BigInt(packet.token) + 1n));

  const nextId = await f.item(['src/shared.ts']);
  const next = await shared.next(undefined, false, undefined, 'spare');
  assert.equal(next.id, nextId);
  await consistent(nextId, next.token!, 'spare');
  const later = Date.now() + 60_000;
  const clock = t.mock.method(Date, 'now', () => later);
  try {
    const reclaimed = (await receiver.reclaim(1)).recovered.find(row => row.id === nextId)!;
    await consistent(nextId, reclaimed.token);
  } finally { clock.mock.restore(); }
  const git = await f.swarm.next(undefined, false, undefined, 'spare');
  assert.equal(git.id, nextId);
  await consistent(nextId, git.token!, 'spare');
  assert.ok((await readItemHistoryHead(f.pmRoot, nextId)).length >= 4);
  await interruptLane(f.swarm, nextId, git.token, 'spare', 'capacity_exhausted');
  await shared.close(nextId, 'Finish interrupted work', git.token);
  const closed = await consistent(nextId, String(BigInt(git.token!) + 1n));
  assert.equal(closed.swarm_handoff, undefined);
  assert.deepEqual(await shared.close(nextId, 'Finish interrupted work', git.token), { id: nextId, closed: true });
});


test('review unbound attachment keeps a valid handoff and compensation only restores valid context', async t => {
  const f = await fixture(t);
  const shared = new SharedTracker(f.swarm);
  const receiver = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'receiver'));
  const unbound = await f.item(['src/unbound.ts']);
  const first = await shared.start(unbound);
  const sent = await shared.handoff(unbound, 'receiver', 'Continue without a capacity', first.token);
  const lane = await receiver.engine.start(unbound);
  assert.equal(lane.token, undefined);
  const retained = (await f.client.get(unbound, { depth: 'full' })).item;
  assert.equal(retained.swarm_token, sent.token);
  assert.equal(JSON.parse(String(retained.swarm_handoff)).token, sent.token);

  const capacity = new Capacities(f.swarm);
  await window(capacity, 'runner', Date.now());
  const malformed = await f.item(['src/invalid-context.ts']);
  await shared.start(malformed, {}, true, 'runner');
  await f.client.update(malformed, { field: ['swarm_handoff={'] });
  await assert.rejects(withStartTransitionObserver(stage => {
    if (stage === 'published') throw new Error('test rollback');
  }, () => f.swarm.start(malformed)), /test rollback/);
  const after = (await f.client.get(malformed, { depth: 'full' })).item;
  assert.equal(after.swarm_handoff, undefined);
  assert.equal(after.swarm_token, '2');
  assert.equal(after.swarm_capacity, 'runner');
  assert.equal(reissueHandoff({ id: malformed, swarm_token: '1', swarm_handoff: '[]' }, '2'), undefined);
  const privateNote = ['', 'home', 'fictional-user', 'checkpoint'].join('/');
  assert.throws(() => reissueHandoff({ id: malformed, swarm_token: '1', swarm_handoff: JSON.stringify({ token: '1', note: privateNote }) }, '2'), /swarm_private_path/);
});

test('review streamed Git evidence distinguishes incomplete records, spawn errors and bad exits', async t => {
  const f = await fixture(t);
  await assert.rejects(gitRecords(f.repo, ['rev-parse', 'HEAD'], '\0'), /incomplete evidence record/);
  await assert.rejects(gitRecords(join(f.root, 'missing'), ['status', '--porcelain', '-z'], '\0'), /probe unavailable/);
  await assert.rejects(gitRecords(f.repo, ['rev-parse', '--verify', 'refs/heads/missing'], '\n'), /git rev-parse failed/);
});
