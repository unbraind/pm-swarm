import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createExtensionTestHarness, decodeToon } from '@unbrained/pm-cli/sdk/testing';
import extension from '../index.ts';
import { git as repoGit } from '../src/git.ts';
import { Swarm } from '../src/swarm.ts';
import { gitEnvironment } from '../src/git-environment.ts';
import { statusChanges, watchInterval, watchStatus } from '../src/watch.ts';
import { fixture, swarmCli } from './helpers.ts';
import { fixtureGit as git, fixtureSnapshot } from './git-helpers.ts';


/** Publish two measured lanes over the same real source file. */
async function pairedLanes(t: TestContext) {
  const f = await fixture(t); const ids = [await f.item(['same.txt']), await f.item(['same.txt'])];
  f.write('same.txt', 'base\n'); f.save(['.agents/pm', 'same.txt']);
  const left = await f.swarm.start(ids[0]); const right = await f.swarm.start(ids[1]);
  return { f, ids, left, right };
}

test('next skips higher priority declared and actual overlaps, defers unknown and starts the safe item', async t => {
  const f = await fixture(t); const active = await f.item(['src']);
  f.write('drift.txt', 'base\n'); f.save(['.agents/pm', 'drift.txt']);
  const lane = await f.swarm.start(active);
  f.write('drift.txt', 'active change\n', lane.worktree); f.save(['drift.txt'], lane.worktree);
  const declared = await f.item(['src/a.ts']); const actual = await f.item(['drift.txt']); const unknown = await f.item(); const safe = await f.item(['docs']);
  for (const id of [declared, actual, unknown]) await f.client.update(id, { priority: 0 });
  await f.client.update(safe, { priority: 4 });
  const before = fixtureSnapshot(f.repo);
  const preview = await f.swarm.next(undefined, true);
  assert.equal(preview.selected, safe); assert.deepEqual(preview.warnings, []);
  assert.deepEqual(fixtureSnapshot(f.repo), before, 'dry-run changes no tracker or Git bytes');
  for (const [id, path] of [[declared, 'src/a.ts'], [actual, 'drift.txt']]) {
    const skipped = preview.skipped.find(row => row.id === id); assert.ok(skipped);
    assert.match(skipped.reasons.join(' '), new RegExp(active)); assert.ok(skipped.overlaps.some(row => row.path === path));
  }
  assert.match(preview.skipped.find(row => row.id === unknown)?.reasons.join(' ') ?? '', /Unknown/);
  const result = await new Swarm(f.repo, f.pmRoot, f.client, 'next-agent').next();
  assert.equal(result.selected, safe); assert.match(result.reason, /priority/);
  assert.equal(result.branch, `swarm/${safe}`); assert.equal(git(result.worktree!, ['branch', '--show-current']), result.branch);
  assert.equal((await f.client.get(safe)).claim_state?.assignee, 'next-agent');
  assert.deepEqual((await f.swarm.next(undefined, true)).warnings.length, 1);
});

test('next respects dependencies, direct parent, own and foreign claims and existing lane records', async t => {
  const f = await fixture(t); const parent = (await f.client.create({ type: 'Epic', title: 'Parent' })).item.id;
  const blocker = await f.item(['blocked']); const dependent = await f.item(['dependent']); const own = await f.item(['own']); const foreign = await f.item(['foreign']);
  const stale = await f.item(['stale']); const outside = await f.item(['outside']); const safe = await f.item(['safe']);
  for (const id of [blocker, dependent, own, foreign, stale, safe]) await f.client.update(id, { parent });
  await f.client.update(dependent, { blockedBy: blocker, priority: 0 });
  await f.client.claim(blocker); await f.client.claim(own); await f.client.claim(foreign, { author: 'other-agent' });
  await f.client.update(stale, { field: ['swarm_branch=swarm/stale'] }); await f.client.update(outside, { priority: 0 });
  const result = await f.swarm.next(parent, true); assert.equal(result.selected, safe);
  assert.deepEqual(result.skipped, []);
  await f.client.update(blocker, { status: 'closed', message: 'Fixture dependency completed' });
  assert.equal((await f.swarm.next(parent, true)).selected, dependent);
  assert.equal((await f.swarm.next('absent', true)).selected, null);
});

test('next orders priority then oldest creation time then id independently of SDK enumeration', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const old = (await f.client.create({ id: 'z-old', type: 'Task', title: 'Old work', priority: 2, file: ['path=old'] })).item.id;
  t.mock.timers.tick(1000);
  const b = (await f.client.create({ id: 'b-new', type: 'Task', title: 'New beta', priority: 2, file: ['path=beta'] })).item.id;
  const a = (await f.client.create({ id: 'a-new', type: 'Task', title: 'New alpha', priority: 2, file: ['path=alpha'] })).item.id;
  const urgent = (await f.client.create({ id: 'urgent', type: 'Task', title: 'Urgent work', priority: 0, file: ['path=urgent'] })).item.id;
  for (const id of [urgent, old, a, b]) {
    assert.equal((await f.swarm.next(undefined, true)).selected, id);
    await f.client.claim(id);
  }
  assert.equal((await f.swarm.next()).selected, null);
});

test('next falls back to unknown with warning, never knowingly overlapping work; terminal lanes do not block', async t => {
  const f = await fixture(t); const active = await f.item(['src']); f.save(); await f.swarm.start(active);
  const overlap = await f.item(['src/code.ts']);
  let result = await f.swarm.next(undefined, true); assert.equal(result.selected, null); assert.match(result.reason, /No ready/);
  const unknown = await f.item(); result = await f.swarm.next();
  assert.equal(result.selected, unknown); assert.match(result.warnings.join(' '), /Unknown footprint/);
  assert.equal((await f.client.get(unknown)).claim_state?.claimed, true);
  assert.equal((await f.swarm.next(undefined, true)).selected, null, 'active unknown lane blocks unmeasured safety');
  await f.client.update(active, { status: 'closed', message: 'Fixture completed' });
  await f.client.update(unknown, { status: 'closed', message: 'Fixture completed' });
  assert.equal((await f.swarm.next(undefined, true)).selected, overlap);
});

test('start warns on declared and changed paths and strict refuses before claim or worktree creation', async t => {
  const f = await fixture(t); const id = await f.item(['src']); f.write('other.txt', 'base\n'); f.save(['.agents/pm', 'other.txt']);
  const active = await f.swarm.start(id); f.write('other.txt', 'changed\n', active.worktree); f.save(['other.txt'], active.worktree);
  const second = await f.item(['src/a.ts', 'other.txt']);
  await assert.rejects(f.swarm.start(second, {}, true), new RegExp(`lane ${id} on path`));
  assert.equal((await f.client.get(second)).claim_state?.claimed, false);
  assert.equal(git(f.repo, ['worktree', 'list', '--porcelain']).includes(`swarm/${second}`), false);
  const result = await f.swarm.start(second);
  assert.deepEqual(result.overlap_warnings.map(row => [row.lane_id, row.path]), [[id, 'other.txt'], [id, 'src/a.ts']]);
});

test('CLI next flags and strict starts use the real host and return normal success for warnings', async t => {
  const f = await fixture(t); const parent = (await f.client.create({ type: 'Epic', title: 'CLI parent' })).item.id;
  const id = await f.item(['src']); await f.client.update(id, { parent }); f.save();
  /** Invoke the actual extension parser with a scrubbed Git environment. */
  const run = (...args: string[]) => swarmCli(f, args);
  const dry = run('next', '--parent', parent, '--dry-run', '--agent', 'cli-agent'); assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).selected, id); assert.equal((await f.client.get(id)).claim_state?.claimed, false);
  const started = run('next', '--parent', parent, '--agent', 'cli-agent'); assert.equal(started.status, 0, started.stderr);
  assert.equal((await f.client.get(id)).claim_state?.assignee, 'cli-agent');
  const second = await f.item(['src/a.ts']);
  const strict = run('start', second, '--strict'); assert.notEqual(strict.status, 0); assert.match(strict.stdout + strict.stderr, new RegExp(id));
  const warning = run('start', second); assert.equal(warning.status, 0, warning.stderr); assert.match(warning.stdout, /overlap_warnings/);
  assert.equal(run('status', '--interval', '2').status, 2);
  assert.equal(run('status', '--watch', '--interval', 'bad').status, 2);
});

test('watch intervals validate finite positive seconds and enforce the minimum', () => {
  assert.equal(watchInterval(), 2000); assert.equal(watchInterval('0.1'), 2000); assert.equal(watchInterval('3'), 3000);
  for (const value of ['0', '-1', 'NaN', 'Infinity', '86401']) assert.throws(() => watchInterval(value), /interval/);
});

test('watch compares real status, stays quiet on unchanged data, reports resolution/removal and stops during emission', async t => {
  const { f, left, right } = await pairedLanes(t);
  const before = await f.swarm.status();
  f.write('same.txt', 'left\n', left.worktree); f.save(['same.txt'], left.worktree);
  f.write('same.txt', 'right\n', right.worktree); f.save(['same.txt'], right.worktree);
  const conflict = await f.swarm.status(); assert.ok(statusChanges(before, conflict).some(row => row.event === 'conflict_predicted'));
  assert.deepEqual(statusChanges(conflict, await f.swarm.status()), []);
  const reordered = { ...conflict, predictions: conflict.predictions.map(row => ({ ...row, left_id: row.right_id, right_id: row.left_id })) };
  assert.deepEqual(statusChanges(conflict, reordered), [], 'pair enumeration order is not a conflict change');
  f.write('another.txt', 'another\n', right.worktree); f.save(['another.txt'], right.worktree);
  const still = await f.swarm.status(); assert.deepEqual(statusChanges(conflict, still).map(row => row.event), ['lane_changed']);
  // A second conflict changes the evidence of the same pair.
  f.write('another.txt', 'left other\n', left.worktree); f.save(['another.txt'], left.worktree);
  const changed = await f.swarm.status(); assert.ok(statusChanges(still, changed).some(row => row.event === 'conflict_changed'));
  git(right.worktree, ['reset', '--hard', 'main']);
  const resolved = await f.swarm.status(); assert.ok(statusChanges(changed, resolved).some(row => row.event === 'conflict_resolved'));
  git(right.worktree, ['switch', '--detach']); git(f.repo, ['branch', '-D', right.branch]);
  assert.ok(statusChanges(resolved, await f.swarm.status()).some(row => row.event === 'lane_removed'));
  const controller = new AbortController(); let count = 0;
  await watchStatus(f.swarm, 2000, controller.signal, () => { count++; controller.abort(); });
  assert.equal(count, 1);
  await watchStatus(f.swarm, 2000, controller.signal, () => assert.fail('aborted watcher emitted'));
});

for (const json of [true, false]) test(`watch child streams ${json ? 'JSON lines' : 'TOON blocks'} for a pushed conflict and exits on SIGINT`, { timeout: 60000 }, async t => {
  const { f, ids, left, right } = await pairedLanes(t);
  f.write('same.txt', 'left\n', left.worktree); f.save(['same.txt'], left.worktree);
  git(right.worktree, ['switch', '--detach']);
  const sender = join(f.root, 'sender');
  repoGit(f.root, ['clone', '--branch', right.branch, f.repo, sender]);
  const child = spawn(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), 'swarm', 'status', '--watch', '--interval', '0.1', ...(json ? ['--json'] : [])], { cwd: f.repo, env: gitEnvironment({ ...process.env, PM_PATH: f.pmRoot, PM_AUTHOR: 'swarm-test' }), stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit'); t.after(() => { child.kill('SIGKILL'); });
  let output = ''; let error = ''; child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { error += String(data); });
  /** Decode only complete frames so separate pipe chunks cannot race assertions. */
  const records = () => output.split(json ? '\n' : '\n\n').slice(0, -1).filter(part => part.trim() !== '').map(part => (json ? JSON.parse(part) : decodeToon(part)) as { event: string; data: { id?: string } });
  /** Wait for semantic output, with bounded failure diagnostics. */
  const until = async (predicate: () => boolean) => { const deadline = Date.now() + 15000; while (!predicate() && Date.now() < deadline) await delay(30); assert.ok(predicate(), output + error); };
  await until(() => ids.every(id => records().some(row => row.event === 'lane_added' && row.data.id === id)));
  const initial = output; await delay(2300); assert.equal(output, initial, 'unchanged polls are silent');
  f.write('same.txt', 'right\n', sender); f.save(['same.txt'], sender);
  await delay(2300); assert.equal(output, initial, 'an unpushed sender commit does not change watched refs');
  git(sender, ['push', 'origin', right.branch]);
  assert.equal(git(f.repo, ['rev-parse', right.branch]), git(sender, ['rev-parse', 'HEAD']));
  await until(() => records().some(row => row.event === 'conflict_predicted'));
  assert.match(output, /same.txt/); assert.match(output, /lane_changed/);
  assert.equal(records().filter(row => row.event === 'conflict_predicted').length, 1);
  const beforeStop = output;
  child.kill('SIGINT'); const [code, signal] = await exit; assert.equal(code, 0, error); assert.equal(signal, null);
  assert.equal(output.trimEnd(), beforeStop.trimEnd(), 'shutdown adds no non-change output');
});

test('watch restores SIGINT listener after a real status failure', async t => {
  const f = await fixture(t); const id = await f.item(); await f.client.update(id, { field: ['swarm_branch=main'] });
  const ext = await createExtensionTestHarness(extension, { name: 'pm-swarm', capabilities: ['commands', 'schema', 'renderers'] });
  const before = process.listenerCount('SIGINT');
  await assert.rejects(ext.runCommand({ command: 'swarm status', pmRoot: f.pmRoot, options: { watch: true }, global: { outputFormat: 'json' } }), /no base SHA/);
  assert.equal(process.listenerCount('SIGINT'), before);
});


test('watch completion renderer owns only completed watch results, preserving native status and other commands', async () => {
  const ext = await createExtensionTestHarness(extension, { name: 'pm-swarm', capabilities: ['commands', 'schema', 'renderers'] });
  for (const format of ['toon', 'json'] as const) {
    const completed = await ext.runRendererOverride({ format, command: 'swarm status', result: { swarm_watch_complete: true } });
    assert.equal(completed.overridden, true); assert.equal(completed.rendered, '');
    for (const result of [null, 'ordinary', {}, { swarm_watch_complete: false }]) {
      assert.equal((await ext.runRendererOverride({ format, command: 'swarm status', result })).overridden, false);
    }
    assert.equal((await ext.runRendererOverride({ format, command: 'list', result: { swarm_watch_complete: true } })).overridden, false);
  }
});
