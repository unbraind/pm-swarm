import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createExtensionTestHarness } from '@unbrained/pm-cli/sdk/testing';
import extension from '../index.ts';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { repositoryRoot } from '../src/workspace.ts';
import { statusChanges, watchStatus } from '../src/watch.ts';
import { fixture, swarmCli } from './helpers.ts';

import { sharedFixture } from './shared-helpers.ts';
import { verifyScaleHistories } from './scale-helpers.ts';
import { processExit } from './process-helpers.ts';

test('no-git settings fully previews and applies while preserving other settings', async t => {
  const f = await sharedFixture(t);
  assert.ok(f.run('swarm', 'settings').swarm);
  f.run('swarm', 'settings', '--limit', '2', '--branch-prefix', 'review/', '--apply');
  const prefs = JSON.parse(readFileSync(join(f.pmRoot, 'settings.json'), 'utf8')) as { swarm: { lane_limit: number }; id_prefix: string };
  assert.equal(prefs.swarm.lane_limit, 2); assert.ok(prefs.id_prefix);
  assert.equal(f.cli('swarm', 'settings', '--limit', '9').status, 2);
});

test('no-git plan uses readiness, dependencies, claims, parent and active footprints', async t => {
  const f = await sharedFixture(t);
  const parent = (await f.client.create({ type: 'Epic', title: 'Shared epic' })).item.id;
  const active = await f.item(['src']); await f.client.claim(active, { author: 'foreign' });
  const overlap = await f.item(['src/code.ts']); const unknown = await f.item();
  const a = await f.item(['docs']); const b = await f.item(['test']); const blocked = await f.item(['blocked']);
  for (const id of [active, overlap, unknown, a, b, blocked]) await f.client.update(id, { parent });
  await f.client.update(blocked, { blockedBy: active });
  const plan = f.run('swarm', 'plan', '--parent', parent, '--limit', '2') as { mode: string; suggested_start_set: string[]; blocked: { id: string }[] };
  assert.equal(plan.mode, 'shared-tracker'); assert.deepEqual(plan.suggested_start_set.sort(), [a, b].sort());
  assert.deepEqual(plan.blocked.map(row => row.id).sort(), [overlap, unknown].sort());
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(blocked));
  assert.deepEqual((await f.shared.plan('absent')).suggested_start_set, []);
  assert.match(f.cli('swarm', 'plan').stdout, /^mode: "?shared-tracker/);
});

test('no-git next ranks safely, previews without mutation and publishes no branch/base fields', async t => {
  const f = await sharedFixture(t); const active = await f.item(['src']); await f.client.claim(active, { author: 'foreign' });
  const overlap = await f.item(['src/a.ts'], 0); const unknown = await f.item([], 0); const safe = await f.item(['docs'], 4);
  const history = join(f.pmRoot, 'history', `${safe}.jsonl`); const before = readFileSync(history, 'utf8');
  const preview = f.run('swarm', 'next', '--agent', 'worker', '--dry-run') as { selected: string; skipped: { id: string; overlaps: unknown[] }[] };
  assert.equal(preview.selected, safe); assert.equal(readFileSync(history, 'utf8'), before);
  assert.ok(preview.skipped.find(row => row.id === overlap)!.overlaps.length > 0);
  const result = f.run('swarm', 'next', '--agent', 'worker'); assert.equal(result.selected, safe); assert.equal(result.mode, 'shared-tracker');
  for (const key of ['branch', 'base', 'worktree']) assert.equal(key in result, false);
  const item = (await f.client.get(safe, { depth: 'full' })).item;
  assert.equal(item.assignee, 'worker'); for (const key of ['swarm_branch', 'swarm_base', 'swarm_base_ref']) assert.equal(key in item, false);
  assert.equal((await f.shared.next(undefined, true)).selected, unknown);
  const fallback = await f.shared.next(); assert.equal(fallback.selected, unknown); assert.match(fallback.warnings.join(' '), /Unknown/);
  assert.equal((await f.shared.next()).selected, null);
});

test('no-git start warns, strict refuses overlaps, and terminal/foreign claims stay protected', async t => {
  const f = await sharedFixture(t); const id = await f.item(['src']); f.run('swarm', 'start', id, '--agent', 'worker');
  const second = await f.item(['src/a.ts']);
  const strict = f.cli('swarm', 'start', second, '--strict', '--json'); assert.equal(strict.status, 2, strict.stdout + strict.stderr); assert.match(strict.stdout + strict.stderr, /Overlapping start refused/);
  assert.equal((await f.client.get(second)).claim_state?.claimed, false);
  const started = f.run('swarm', 'start', second) as { overlap_warnings: unknown[] }; assert.equal(started.overlap_warnings.length, 1);
  assert.equal(f.cli('swarm', 'start', id, '--json').status, 2);
  await f.client.update(second, { status: 'closed', message: 'Fixture complete' });
  assert.equal(f.cli('swarm', 'start', second, '--json').status, 2);
  const empty = await f.item(); assert.deepEqual((await f.shared.start(empty)).overlap_warnings, []);
  assert.equal((await f.shared.start(empty)).id, empty, 'own claim is idempotent');
});

test('expired tracker lease refuses a stalled start before item history changes', { timeout: 60000 }, async t => {
  const f = await sharedFixture(t); const first = await f.item(['src']); const second = await f.item(['src/code.ts']);
  let enter = () => {}; let resume = () => {};
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  const corpus = f.shared.engine.corpus.bind(f.shared.engine);
  f.shared.engine.corpus = async () => { const snapshot = await corpus(); enter(); await resumed; return snapshot; };
  const history = join(f.pmRoot, 'history', `${first}.jsonl`); const before = readFileSync(history, 'utf8');
  const stalled = f.shared.start(first, {}, true);
  await entered;
  const path = join(f.pmRoot, 'runtime/swarm/operation.json');
  const lease = JSON.parse(readFileSync(path, 'utf8')) as { heartbeat: number };
  lease.heartbeat = Date.now() - 31000; writeFileSync(path, JSON.stringify(lease));
  resume(); await assert.rejects(stalled, /swarm_stale_fence/); f.shared.engine.corpus = corpus;
  assert.equal(readFileSync(history, 'utf8'), before);
  const successor = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'lease-successor'));
  await successor.start(second, {}, true);
  await assert.rejects(f.shared.start(first, {}, true), /Overlapping/);
  assert.equal((await f.shared.status()).overlaps.length, 0);
});

test('no-git status reports claim age and declared overlaps, omitting Git measurements', async t => {
  const f = await sharedFixture(t); const a = await f.item(['src']); const b = await f.item(['src/a.ts']);
  const unknown = await f.item(); const terminal = await f.item(['done']);
  for (const id of [a, b, unknown, terminal]) await f.client.claim(id);
  await f.client.update(terminal, { status: 'closed', message: 'Fixture complete' });
  // Status must also tolerate assignments lacking a claim history event.
  const assigned = await f.item(['assigned']); await f.client.update(assigned, { assignee: 'assigned-worker' });
  const status = f.run('swarm', 'status', '--full') as { lanes: { id: string; agent: string; claim_age_seconds: number | null; claimed_at: string | null }[]; overlaps: unknown[]; note: string };
  assert.equal((await f.shared.status()).lanes.length, 4);
  assert.equal(status.lanes.length, 4); assert.ok(status.lanes.some(row => row.id === a && row.agent === 'shared-test' && row.claim_age_seconds !== null && row.claim_age_seconds >= 0));
  assert.equal(status.lanes.find(row => row.id === assigned)!.claimed_at, null);
  assert.ok(status.overlaps.length >= 3); assert.match(status.note, /unavailable/);
  for (const key of ['ahead', 'behind', 'predictions', 'clean_pairs', 'branch', 'sha', 'missing_merge_drivers']) assert.doesNotMatch(JSON.stringify(status), new RegExp(`"${key}"`));
});

for (const operation of ['sharedLanes', 'status', 'watch'] as const) {
  test(`shared ${operation} skips terminal claim reads and retains active provenance`, async t => {
    const f = await sharedFixture(t);
    const active = await f.item(['active']); await f.client.claim(active);
    const assigned = await f.item(['assigned']); await f.client.update(assigned, { assignee: 'assigned-worker' });
    const completed = await f.item(['completed']); await f.client.claim(completed);
    await f.client.update(completed, { status: 'closed', message: 'Fixture complete' });
    await f.client.claim(completed, { force: true });
    const terminalAssigned = await f.item(['terminal-assigned']);
    await f.client.update(terminalAssigned, { status: 'closed', message: 'Fixture complete' });
    await f.client.update(terminalAssigned, { assignee: 'assigned-worker' });
    await f.item(['unassigned']);
    const claimedAt = (await f.client.get(active)).claim_state!.last_claim!.ts;
    const history = [active, assigned, completed, terminalAssigned].map(id => join(f.pmRoot, 'history', `${id}.jsonl`));
    const before = history.map(path => readFileSync(path, 'utf8'));
    const reads: string[] = []; const get = f.client.get.bind(f.client);
    // Count actual SDK reads without replacing tracker responses.
    f.client.get = new Proxy(get, { apply: (target, receiver, args: unknown[]) => { reads.push(String(args[0])); return Reflect.apply(target, receiver, args); } });
    const polls = operation === 'watch' ? 3 : 1;
    if (operation === 'sharedLanes') {
      const lanes = await f.shared.sharedLanes();
      assert.deepEqual(lanes.filter(lane => lane.terminal).map(lane => [lane.id, lane.claimed_at]).sort(), [[completed, null], [terminalAssigned, null]].sort());
      assert.equal(lanes.find(lane => lane.id === active)!.claimed_at, claimedAt);
      assert.equal(lanes.find(lane => lane.id === assigned)!.claimed_at, null);
    } else {
      const controller = new AbortController(); const status = f.shared.status.bind(f.shared); let measured = 0;
      // Exercise the real status implementation on each serial watch poll.
      f.shared.status = async () => {
        const result = await status(); measured++;
        assert.deepEqual(result.lanes.map(lane => lane.id).sort(), [active, assigned].sort());
        assert.equal(result.lanes.find(lane => lane.id === active)!.claimed_at, claimedAt);
        assert.equal(result.lanes.find(lane => lane.id === assigned)!.claimed_at, null);
        if (measured === polls) controller.abort();
        return result;
      };
      if (operation === 'watch') await watchStatus(f.shared, 1, controller.signal, () => {});
      else await f.shared.status();
      assert.equal(measured, polls);
    }
    assert.deepEqual(reads.sort(), Array.from({ length: polls }, () => [active, assigned]).flat().sort());
    reads.length = 0;
    assert.ok((await f.shared.sharedLanes(undefined, false)).every(lane => lane.claimed_at === null));
    assert.deepEqual(reads, [], 'claim-disabled callers perform no claim reads');
    assert.deepEqual(history.map(path => readFileSync(path, 'utf8')), before, 'observational operations preserve history');
  });
}

test('no-git sync requires explicit safe files and applies only when requested', async t => {
  const f = await sharedFixture(t); const id = await f.item(['existing']); await f.client.claim(id);
  const refused = f.cli('swarm', 'sync', id, '--json'); assert.equal(refused.status, 2, refused.stdout + refused.stderr); assert.match(refused.stdout + refused.stderr, /--files/);
  for (const files of ['a,', '../escape', '/absolute', 'C:/absolute']) assert.equal(f.cli('swarm', 'sync', id, '--files', files, '--json').status, 2);
  assert.deepEqual(f.run('swarm', 'sync', id, '--files', 'a,b,a,existing', '--apply', '--dry-run').add, ['a', 'b']);
  assert.deepEqual((await f.client.get(id, { depth: 'full' })).item.files?.map(file => file.path), ['existing']);
  assert.deepEqual(f.run('swarm', 'sync', id, '--files', 'a,b', '--apply').add, ['a', 'b']);
  assert.deepEqual(f.run('swarm', 'sync', id, '--files', 'a', '--apply').add, []);
  const unclaimed = await f.item(); assert.equal(f.cli('swarm', 'sync', unclaimed, '--files', 'a', '--json').status, 2);
  await assert.rejects(f.shared.sync(id, false, []), /--files/);
});

test('no-git land clearly refuses branch merging and names usable tracker commands', async t => {
  const f = await sharedFixture(t);
  for (const flags of [[], ['--execute']]) {
    const result = f.cli('swarm', 'land', ...flags, '--json'); assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /needs a git repository.*already on the shared tracker/);
    assert.match(result.stdout + result.stderr, /sync --files/);
    assert.doesNotMatch(result.stdout + result.stderr, /git rev-parse failed/);
  }
});

test('no-git reap previews and releases own terminal claims, preserving active and foreign claims', async t => {
  const f = await sharedFixture(t); const own = await f.item(); const foreign = await f.item(); const active = await f.item();
  for (const id of [own, foreign]) { await f.client.update(id, { status: 'closed', message: 'Fixture complete' }); await f.client.claim(id, { force: true, author: id === own ? 'shared-test' : 'foreign' }); }
  await f.client.claim(active);
  const preview = f.run('swarm', 'reap', '--dry-run'); assert.deepEqual(preview.released, [own]); assert.equal((await f.client.get(own)).claim_state?.claimed, true);
  assert.deepEqual(f.run('swarm', 'reap').released, [own]);
  assert.equal((await f.client.get(own)).claim_state?.claimed, false);
  assert.equal((await f.client.get(active)).claim_state?.claimed, true);
  assert.equal((await f.client.get(foreign)).claim_state?.assignee, 'foreign');
  assert.deepEqual(f.run('swarm', 'reap', '--agent', 'foreign').released, [foreign]);
});

test('no-git watch emits lanes and overlap changes, ignores age-only changes and exits on SIGINT', { timeout: 30000 }, async t => {
  const f = await sharedFixture(t); const a = await f.item(['src']); const b = await f.item(['src/a.ts']);
  await f.client.claim(a); await f.client.claim(b);
  const before = await f.shared.status();
  assert.deepEqual(statusChanges(before, { ...before, lanes: before.lanes.map(row => ({ ...row, claim_age_seconds: 99 })) }), []);
  assert.ok(statusChanges(undefined, before).some(row => row.event === 'overlap_detected'));
  await f.client.files(b, { add: ['src/b.ts'] });
  const changed = await f.shared.status(); assert.ok(statusChanges(before, changed).some(row => row.event === 'overlap_changed'));
  await f.client.release(b);
  assert.ok(statusChanges(changed, await f.shared.status()).some(row => row.event === 'overlap_resolved'));
  const controller = new AbortController(); await watchStatus(f.shared, 2000, controller.signal, () => controller.abort());
  const child = spawn(process.execPath, [f.host, 'swarm', 'status', '--watch', '--json'], { cwd: f.repo, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL')); const exit = processExit(child, 'exit'); let output = ''; let error = '';
  child.stdout.setEncoding('utf8').on('data', (data: string) => { output += data; });
  child.stderr.setEncoding('utf8').on('data', (data: string) => { error += data; });
  const deadline = Date.now() + 15000;
  while (!output.includes('lane_added') && child.exitCode === null && Date.now() < deadline) await delay(20);
  assert.match(output, /lane_added/); const initial = output; await delay(2300); assert.equal(output, initial);
  child.kill('SIGINT'); const [code, signal] = await exit; assert.equal(code, 0, error); assert.equal(signal, null);
});

test('real eight-process next contention keeps every claim and history valid without git', { timeout: 120000 }, async t => {
  const f = await sharedFixture(t); const ids = [];
  for (let i = 0; i < 8; i++) ids.push(await f.item([`src/lane-${i}.ts`], 2, `lane-${i}`));
  const started = performance.now();
  const results = await Promise.all(ids.map(async (_, i) => {
    const child = spawn(process.execPath, [f.host, 'swarm', 'next', '--agent', `worker-${i}`, '--json'], { cwd: f.repo, env: f.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 });
    const complete = once(child, 'close');
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const [code] = await complete;
    const output = Buffer.concat(stdout).toString();
    assert.equal(code, 0, output + Buffer.concat(stderr).toString());
    return JSON.parse(output) as { selected: string; agent: string; mode: string };
  }));
  const elapsed = performance.now() - started;
  assert.equal(new Set(results.map(row => row.selected)).size, 8);
  assert.deepEqual(results.map(row => row.selected).sort(), ids.sort());
  for (const row of results) { const claim = (await f.client.get(row.selected)).claim_state; assert.equal(claim?.assignee, row.agent); assert.equal(claim?.claimed, true); assert.equal(row.mode, 'shared-tracker'); }
  const historyFiles = verifyScaleHistories(f.pmRoot, ids.length + 1);
  const health = f.run('--no-extensions', 'health', '--strict-exit'); assert.equal(health.ok, true);
  t.diagnostic(`8 processes, 8 distinct retained claims, ${historyFiles} valid history files, health ok; ${elapsed.toFixed(0)} ms`);
});

test('workspace detection respects Git ceilings, nested worktrees and a filesystem root without git', async t => {
  const f = await fixture(t); assert.equal(repositoryRoot(f.repo), f.repo); assert.equal(repositoryRoot(f.pmRoot), f.repo);
  const old = process.env.GIT_CEILING_DIRECTORIES; process.env.GIT_CEILING_DIRECTORIES = f.repo;
  assert.equal(repositoryRoot(f.pmRoot), undefined);
  assert.equal(repositoryRoot(f.repo), f.repo, 'Git ceilings exclude parents, not the current directory');
  delete process.env.GIT_CEILING_DIRECTORIES;
  assert.equal(repositoryRoot(dirname(tmpdir())), undefined);
  if (old !== undefined) process.env.GIT_CEILING_DIRECTORIES = old;
});

/** Keep a concise human-output receipt for the audited eight-command surface. */
test('no-git command matrix records exit codes and first lines', async t => {
  const f = await sharedFixture(t); const id = await f.item(['src']);
  const commands = [
    ['plan'], ['next', '--agent', 'matrix-worker', '--dry-run'],
    ['start', id, '--agent', 'matrix-worker'], ['status'],
    ['sync', id, '--files', 'src,docs', '--apply', '--agent', 'matrix-worker', '--token', '1'],
    ['land'], ['reap', '--dry-run'], ['settings'],
  ];
  const codes = [];
  for (const args of commands) {
    const result = f.cli('swarm', ...args); codes.push(result.status);
    t.diagnostic(`${args[0]} | ${result.status} | ${(result.stdout || result.stderr).trim().split('\n')[0]}`);
  }
  assert.deepEqual(codes, [0, 0, 0, 0, 0, 2, 0, 0]);
});


test('shared planning retains unknown solitary waves and ignores stale Git fields; Git sync accepts explicit files', async t => {
  const f = await sharedFixture(t); const id = await f.item();
  await f.client.update(id, { field: ['swarm_branch=swarm/previous'] });
  const plan = await f.shared.plan(); assert.deepEqual(plan.suggested_start_set, [id]);
  assert.equal(plan.lanes[0].items[0].footprint, 'unknown');
  assert.equal((await f.shared.next()).selected, id);
  const g = await fixture(t); const gitId = await g.item(['declared']); g.save();
  await g.swarm.start(gitId);
  assert.deepEqual((await g.swarm.sync(gitId, true, ['explicit'])).add, ['explicit']);
});


/** Measure host-bound shared dispatch as well as real CLI subprocess behavior. */
test('shared SDK dispatch covers active, terminal, unknown and explicit-file operations', async t => {
  const f = await sharedFixture(t);
  const harness = await createExtensionTestHarness(extension, { name: 'pm-swarm', capabilities: ['commands', 'schema', 'renderers'] });
  /** Call the registered handler with the real host SDK and complete tracker context. */
  const run = async (verb: string, options: Record<string, unknown> = {}, args: string[] = []) => (await harness.runCommand({ command: `swarm ${verb}`, pmRoot: f.pmRoot, options, args, global: { author: 'shared-test' } })).result;
  await run('settings', { limit: '3', apply: true });
  const a = await f.item(['src']); const b = await f.item(['src/a.ts']); const terminal = await f.item(['done']);
  await run('plan'); await run('plan', { full: true, limit: '2' });
  await run('next', { dryRun: true }); await run('next');
  const first = (await f.client.get(a)).claim_state?.claimed ? a : b;
  const second = first === a ? b : a;
  await assert.rejects(run('start', { strict: true }, [second]), /Overlapping/);
  await run('start', {}, [second]);
  await assert.rejects(run('start', { agent: 'foreign' }, [first]), /claimed/);
  const assigned = await f.item(['assignment']); await f.client.update(assigned, { assignee: 'foreign' });
  await run('status', { full: true });
  await assert.rejects(run('sync', {}, [first]), /--files/);
  await run('sync', { files: 'src, docs,docs', apply: true, dryRun: true }, [first]);
  await run('sync', { files: 'src, docs,docs', apply: true, token: '1' }, [first]);
  await run('sync', { files: 'docs', apply: true }, [first]);
  await assert.rejects(run('sync', { files: 'a,' }, [first]), /--files/);
  await assert.rejects(run('sync', { files: 'docs' }, [terminal]), /No active/);
  await f.client.update(terminal, { status: 'closed', message: 'Fixture complete' });
  await assert.rejects(run('start', {}, [terminal]), /terminal/);
  await f.client.claim(terminal, { author: 'shared-test', force: true });
  await f.client.update(assigned, { status: 'closed', message: 'Fixture complete' });
  await f.client.claim(assigned, { author: 'foreign', force: true });
  await run('reap', { dryRun: true }); await run('reap'); await run('reap');
  await assert.rejects(f.shared.land(), /needs a git repository/); await assert.rejects(run('land', { execute: true }), /needs a git repository/);
  await f.client.release(first); await f.client.release(second);
  await run('plan', {}, []);
});


/** Preserve the existing Git error transport while adding expected shared-mode refusals. */
test('Git refusal exit codes retain the existing dispatcher behavior', async t => {
  const f = await fixture(t); const id = await f.item(['src']);
  await f.client.claim(id, { author: 'foreign-worker' });
  const result = swarmCli(f, ['start', id]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /claimed by foreign-worker/);
});


for (const operation of ['plan', 'preview', 'next', 'start', 'sync', 'reap'] as const) {
  test(`shared ${operation} reuses one corpus without per-lane claim reads`, async t => {
    const f = await sharedFixture(t);
    const active = await f.item(['active']); await f.client.claim(active);
    const ready = await f.item(['ready']);
    const engine = f.shared.engine; const corpus = engine.corpus.bind(engine); const get = f.client.get.bind(f.client);
    let corpusReads = 0; const itemReads: string[] = [];
    // Instrument real SDK calls without substituting tracker responses.
    engine.corpus = async () => { corpusReads++; return corpus(); };
    f.client.get = new Proxy(get, { apply: (target, receiver, args: unknown[]) => { itemReads.push(String(args[0])); return Reflect.apply(target, receiver, args); } });
    switch (operation) {
      case 'plan': await f.shared.plan(); break;
      case 'preview': await f.shared.next(undefined, true); break;
      case 'next': assert.equal((await f.shared.next()).selected, ready); break;
      case 'start': await f.shared.start(ready); break;
      case 'sync': await f.shared.sync(active, true, ['extra']); break;
      case 'reap': await f.shared.reap(); break;
    }
    assert.equal(corpusReads, operation === 'sync' ? 0 : 1, 'sync reads only its target; selection certifies the corpus');
    assert.deepEqual(itemReads, operation === 'next' || operation === 'start' ? [ready] : operation === 'sync' ? [active] : [], 'only the selected item needs a direct ownership read');
  });
}

for (const mode of ['shared', 'Git'] as const) {
  test(`${mode} sync protects foreign footprints while preserving previews and no-op applies`, async t => {
    const f = mode === 'shared' ? await sharedFixture(t) : await fixture(t);
    const id = await f.item(['existing']);
    const engine = 'shared' in f ? f.shared : f.swarm;
    if ('swarm' in f) { f.save(); await f.swarm.start(id); await f.client.release(id); }
    await f.client.claim(id, { author: 'foreign' });
    const history = join(f.pmRoot, 'history', `${id}.jsonl`); const before = readFileSync(history, 'utf8');
    assert.deepEqual((await engine.sync(id, false, ['new'])).add, ['new']);
    assert.deepEqual((await engine.sync(id, true, ['existing'])).add, []);
    await assert.rejects(engine.sync(id, true, ['new']), /Item claimed by foreign/);
    if ('cli' in f) {
      const refused = f.cli('swarm', 'sync', id, '--files', 'new', '--apply', '--json');
      assert.equal(refused.status, 2); assert.match(refused.stdout + refused.stderr, /Item claimed by foreign/);
    }
    assert.equal(readFileSync(history, 'utf8'), before, 'refused foreign writes preserve history');
    const item = (await f.client.get(id, { depth: 'full' })).item;
    assert.deepEqual(item.files?.map(file => file.path), ['existing']);
    if ('run' in f) assert.deepEqual(f.run('swarm', 'sync', id, '--files', 'new', '--apply', '--agent', 'foreign').add, ['new']);
    await assert.rejects(engine.sync(id, true, ['   ']), /--files/);
  });
}

test('Git sync requires reclaiming an unassigned lane before applying file links', async t => {
  const f = await fixture(t); const id = await f.item(['existing']); f.save(); await f.swarm.start(id);
  await f.client.release(id);
  const history = join(f.pmRoot, 'history', `${id}.jsonl`); const before = readFileSync(history, 'utf8');
  assert.deepEqual((await f.swarm.sync(id, false, ['new'])).add, ['new']);
  assert.deepEqual((await f.swarm.sync(id, true, ['existing'])).add, []);
  await assert.rejects(f.swarm.sync(id, true, ['new']), /Lane is unclaimed; claim it before applying file links/);
  const refused = swarmCli(f, ['sync', id, '--files', 'new', '--apply']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /Lane is unclaimed; claim it before applying file links/);
  assert.equal(readFileSync(history, 'utf8'), before, 'refusal and previews preserve the released lane history');
  assert.deepEqual((await f.client.get(id, { depth: 'full' })).item.files?.map(file => file.path), ['existing']);
  await f.client.claim(id);
  assert.deepEqual((await f.swarm.sync(id, true, ['new'])).add, ['new']);
});

test('Git sync rejects empty explicit files', async t => {
  const f = await fixture(t); const id = await f.item(['existing']); f.save(); await f.swarm.start(id);
  for (const files of [[], [''], ['new', ''], ['   ']]) await assert.rejects(f.swarm.sync(id, true, files), /--files requires nonempty/);
  for (const files of ['new,', ',new', 'new, ,other']) {
    const refused = swarmCli(f, ['sync', id, '--files', files, '--apply']);
    assert.notEqual(refused.status, 0); assert.match(refused.stdout + refused.stderr, /--files requires nonempty/);
  }
});

test('Git sync deduplicates normalized explicit paths', async t => {
  const f = await fixture(t); const id = await f.item(['existing']); f.save(); await f.swarm.start(id);
  const history = join(f.pmRoot, 'history', `${id}.jsonl`); const before = readFileSync(history, 'utf8');
  const paths = ['new/file.ts', 'new/./file.ts', 'new/file.ts', 'existing'];
  assert.deepEqual((await f.swarm.sync(id, false, paths)).add, ['new/file.ts']);
  assert.equal(readFileSync(history, 'utf8'), before);
  assert.deepEqual((await f.swarm.sync(id, true, paths)).add, ['new/file.ts']);
  assert.deepEqual((await f.swarm.sync(id, true, paths)).add, []);
  assert.deepEqual((await f.client.get(id, { depth: 'full' })).item.files?.map(file => file.path), ['existing', 'new/file.ts']);
});
