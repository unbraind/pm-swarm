import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { getHistoryPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { Capacities, OBSERVATION_MAX_AGE_MS, withStartTransitionObserver, withItemMutationObserver, Swarm, SharedTracker, interruptLane } from '../index.ts';
import { CAPACITY_FIELD } from '../src/capacity.ts';
import { fixture } from './helpers.ts';
import { runProcess } from './process-helpers.ts';
import { sharedFixture } from './shared-helpers.ts';
import { waitForCapacityRace } from './support/capacity-race-extension.ts';

test('native capacity history retains observations and status forecasts with two fresh points', async t => {
  const f = await sharedFixture(t);
  let now = Date.parse('2026-11-25T08:00:00Z');
  const capacity = new Capacities(f.shared.engine, () => now);
  await assert.rejects(capacity.run('codex'), /capacity_undeclared/);
  const declaration = { action: 'declare', limit: 100, unit: 'percent', window: '7d', resetsAt: '2026-11-25T12:00:00Z' };
  assert.equal((await capacity.run(' CODEX ', declaration)).forecast, null);
  await assert.rejects(capacity.run('codex', declaration), /current window is active/);
  for (const [at, used] of [
    ['2026-11-24T09:00:00Z', 44], ['2026-11-24T16:00:00Z', 49],
    ['2026-11-25T01:00:00Z', 54], ['2026-11-25T08:00:00Z', 56],
  ] as const) {
    const result = await capacity.run('codex', { action: 'observe', at, used, source: 'codexbar' });
    if (used === 44) assert.equal(result.forecast, null);
  }
  const view = await capacity.run('codex');
  assert.equal(view.capacity, 'codex');
  assert.equal(view.used, 56);
  assert.equal(view.elapsed_share, 164 / 168);
  assert.equal(view.seconds_to_reset, 14_400);
  assert.ok(Math.abs(view.burn_rate_per_hour! - 2 / 7) < 1e-12);
  assert.ok(Math.abs(view.forecast_recent! - (56 + 8 / 7)) < 1e-12);
  assert.equal(view.forecast, 56 / view.elapsed_share);
  const record = (await f.shared.engine.corpus()).items.find(item => item.tags.includes('swarm-capacity'))!;
  assert.equal((await readHistoryEntries(getHistoryPath(f.pmRoot, record.id), record.id)).length, 5);
  const normalPlan = await f.shared.plan();
  assert.doesNotMatch(JSON.stringify(normalPlan), /swarm-capacity-codex/);
  await assert.rejects(f.shared.start(record.id), /Capacity records require/);

  now = Date.parse('2026-11-25T12:00:00Z');
  assert.equal((await capacity.run('codex')).forecast, null);
  await capacity.run('codex', { ...declaration, resetsAt: '2026-12-02T12:00:00Z' });
  assert.deepEqual((await capacity.run('codex')).observations, []);
  await capacity.run('codex', { action: 'observe', used: 0, source: 'reported' });
  now += OBSERVATION_MAX_AGE_MS + 1;
  await capacity.run('codex', { action: 'observe', used: 10, source: 'reported' });
  const stale = await capacity.run('codex');
  assert.deepEqual(stale.observations.map(point => point.stale), [true, false]);
  assert.equal(stale.forecast, null);
  assert.equal(stale.forecast_recent, null);
  assert.equal(stale.forecast_window, null);
  await assert.rejects(capacity.run('codex', { action: 'observe', used: 9, source: 'reported' }), /newer observation/);
  await assert.rejects(capacity.run('codex', { action: 'observe', used: -1, source: 'reported' }), /nonnegative finite decimal/);
  const secret = 'ghp_' + 'A1'.repeat(18);
  await assert.rejects(capacity.run('codex', { action: 'observe', used: 11, source: secret }), /public --source label/);
});

test('capacity declare, observe and status run through native JSON and TOON without Git', async t => {
  const f = await sharedFixture(t);
  const reset = new Date(Date.now() + 3_600_000).toISOString();
  assert.equal(f.run('swarm', 'capacity', 'runner', '--action', 'declare', '--limit', '12', '--unit', 'jobs', '--window', '1d', '--resets-at', reset).forecast, null);
  assert.equal(f.run('swarm', 'capacity', 'runner', '--action', 'observe', '--used', '4', '--source', 'manual').used, 4);
  assert.equal(f.run('swarm', 'capacity', 'runner').resets_at, reset);
  const toon = f.cli('swarm', 'capacity', 'runner', '--output-format', 'toon');
  assert.equal(toon.status, 0, toon.stderr);
  assert.match(toon.stdout, /^capacity: runner$/m);
  assert.match(toon.stdout, /^used: 4$/m);
});

/** Configure one active capacity through actual host argument parsing. */
function declare(f: Awaited<ReturnType<typeof sharedFixture>>, name: string, lanes: number) {
  const reset = new Date(Date.now() + 3_600_000).toISOString();
  f.run('swarm', 'capacity', name, '--action', 'declare', '--limit', '100', '--unit', 'percent', '--window', '7d', '--resets-at', reset);
  f.run('swarm', 'capacity', name, '--action', 'policy', '--else', String(lanes));
  return reset;
}

test('weekly replay selects the conservative forecast and respects forecast policy overrides', async t => {
  const f = await sharedFixture(t);
  const latestAt = Date.parse('2026-11-25T10:24:00Z');
  let now = latestAt;
  const capacity = new Capacities(f.shared.engine, () => now);
  await capacity.run('codex', { action: 'declare', limit: 100, unit: 'percent', window: '7d', resetsAt: '2026-11-27T22:20:00Z' });
  const policy = { action: 'policy', band: ['forecast<88=3', 'forecast<95=2', 'forecast<98=1'], else: 0 };
  const unknown = await capacity.run('codex', policy);
  assert.equal(unknown.admitted_lane_count, 0);
  assert.equal(unknown.forecast_recent, null);
  assert.equal(unknown.forecast_window, null);
  for (const [at, used] of [
    ['2026-11-24T10:15:00Z', 44], ['2026-11-24T18:54:00Z', 49],
    ['2026-11-25T00:25:00Z', 55], ['2026-11-25T10:24:00Z', 58],
  ] as const) await capacity.run('codex', { action: 'observe', at, used, source: 'codexbar' });

  const view = await capacity.run('codex');
  assert.equal(view.policy.forecast, 'max');
  assert.equal(view.forecast_recent?.toFixed(2), '76.01');
  assert.equal(view.forecast_window?.toFixed(2), '90.17');
  assert.equal(view.forecast, view.forecast_window);
  assert.equal(view.admitted_lane_count, 2);
  for (const minutes of [85, 360]) {
    now = latestAt + minutes * 60_000;
    const later = await capacity.run('codex');
    assert.ok(later.elapsed_share > view.elapsed_share);
    assert.equal(later.forecast_window, view.forecast_window, `Whole-window forecast changed after ${minutes} minutes without a new observation`);
    assert.equal(later.forecast_recent, view.forecast_recent);
    assert.equal(later.forecast, view.forecast);
    assert.equal(later.admitted_lane_count, 2);
  }
  now = latestAt + OBSERVATION_MAX_AGE_MS + 1;
  const stale = await capacity.run('codex');
  assert.equal(stale.observation_stale, true);
  assert.deepEqual([stale.forecast_recent, stale.forecast_window, stale.forecast], [null, null, null]);
  assert.equal(stale.exhausted, false);
  assert.equal(stale.admitted_lane_count, policy.else);
  now = latestAt;

  const recent = await capacity.run('codex', { ...policy, forecast: 'recent' });
  assert.equal(recent.forecast, view.forecast_recent);
  assert.equal(recent.admitted_lane_count, 3);
  const window = await capacity.run('codex', { ...policy, forecast: 'window' });
  assert.equal(window.forecast, view.forecast_window);
  assert.equal(window.admitted_lane_count, 2);
  assert.equal((await capacity.run('codex')).policy.forecast, 'window');
  assert.equal((await capacity.run('codex', { action: 'policy', band: ['forecast<' + view.forecast + '=9', 'forecast<95=2'], else: 1 })).admitted_lane_count, 2);
  await assert.rejects(capacity.run('codex', { ...policy, band: ['forecast<95=2', 'forecast<88=3'] }), /strictly increasing/);

  const record = (await f.shared.engine.corpus()).items.find(item => item.tags.includes('swarm-capacity'))!;
  const { item } = await f.client.get(record.id, { depth: 'full' });
  const old = JSON.parse(String(item[CAPACITY_FIELD]));
  old.policy = { bands: policy.band, otherwise: 0 };
  await f.client.update(record.id, { field: [CAPACITY_FIELD + '=' + JSON.stringify(old)] });
  assert.equal((await capacity.run('codex')).admitted_lane_count, 2);

  now = latestAt + 6 * 3_600_000;
  const updated = await capacity.run('codex', { action: 'observe', used: 58, source: 'codexbar' });
  assert.equal(updated.forecast_window, 58 / updated.elapsed_share);
  assert.equal(updated.admitted_lane_count, 3);
});

/** Observe termination at launch and surface its diagnostic while polling a race marker. */
function monitorCapacityWorker(result: ReturnType<typeof runProcess>, agent: string) {
  let failure: { error: unknown } | undefined;
  void result.then(({ code, signal, stderr, stdout }) => {
    failure = { error: new Error(`${agent} exited before its admission marker (code ${code}, signal ${signal}): ${stderr || stdout}`) };
  }, error => { failure = { error }; });
  return {
    result,
    check() { if (failure !== undefined) throw failure.error; },
  };
}

test('capacity race marker waits report spawn failures and early exit output', async t => {
  const f = await sharedFixture(t);
  const missing = monitorCapacityWorker(runProcess(join(f.repo, 'missing-race-worker'), [], f.repo, f.env, 1000), 'worker-a');
  await assert.rejects(waitForCapacityRace(() => { missing.check(); return false; }, 'missing first marker'), { code: 'ENOENT' });
  const early = monitorCapacityWorker(runProcess(process.execPath,
    ['-e', "process.stderr.write('early worker output'); process.exit(23)"], f.repo, f.env, 1000), 'worker-b');
  await assert.rejects(waitForCapacityRace(() => { early.check(); return false; }, 'missing second marker'), /worker-b.*code 23.*early worker output/);
});

test('one last capacity slot admits exactly one of two independent next processes', async t => {
  const f = await sharedFixture(t);
  const reset = declare(f, 'codex', 1);
  declare(f, 'ollama', 1);
  const now = Date.now();
  for (const [ago, used] of [[3600_000, 10], [1000, 11]]) {
    f.run('swarm', 'capacity', 'codex', '--action', 'observe', '--used', String(used), '--source', 'manual', '--at', new Date(now - ago).toISOString());
  }
  // Give each worker a distinct eligible item so an item revision guard cannot hide over-admission.
  const parents = [await f.item(), await f.item()];
  const ids: string[] = [];
  for (const [i, parent] of parents.entries()) {
    ids.push((await f.client.create({ type: 'Task', title: 'Race lane', parent, file: [`path=src/lane-${i}.ts`] })).item.id);
  }
  const observer = new URL('./support/capacity-race-extension.ts', import.meta.url).href;
  writeFileSync(join(f.pmRoot, 'extensions/pm-swarm/entry.js'), `export { default } from '${observer}';\n`);
  const runtime = join(f.pmRoot, 'runtime/swarm');
  const paused = join(f.pmRoot, 'admission-paused');
  const release = join(f.pmRoot, 'admission-release');
  const launch = (agent: string, parent: string) => monitorCapacityWorker(runProcess(process.execPath,
    [f.host, 'swarm', 'next', '--agent', agent, '--parent', parent, '--capacity', 'codex,ollama', '--json'], f.repo, f.env), agent);
  const first = launch('worker-a', parents[0]);
  let second: ReturnType<typeof launch> | undefined;
  try {
    await waitForCapacityRace(() => { first.check(); return existsSync(paused); }, 'First claim never paused after admission');
    assert.ok(existsSync(join(runtime, 'operation-pin.json')));
    assert.ok(!readdirSync(runtime).some(name => name.startsWith('request-')));
    const challenger = launch('worker-b', parents[1]);
    second = challenger;
    await waitForCapacityRace(() => {
      first.check();
      challenger.check();
      return readdirSync(runtime).some(name => name.startsWith('request-'));
    }, 'Second claim never queued while first held admission');
    for (const id of ids) assert.equal((await f.client.get(id)).item.assignee, undefined);
  } finally {
    writeFileSync(release, '');
    await Promise.allSettled([first.result, second?.result]);
  }
  const workers = await Promise.all([first.result, second!.result]);
  assert.deepEqual(workers.map(result => result.code).sort(), [0, 2], JSON.stringify(workers));
  const won = JSON.parse(workers.find(result => result.code === 0)!.stdout) as Record<string, unknown>;
  const losing = workers.find(result => result.code === 2)!;
  const refusal = JSON.parse(losing.stderr || losing.stdout) as { code: string; details: { next_command: string; forecast: number } };
  assert.equal(refusal.code, 'capacity_lanes_occupied');
  assert.match(JSON.stringify(refusal), /1 of 1 admitted lanes active/);
  assert.ok(Number.isFinite(refusal.details.forecast), 'a full lane pool with two fresh observations has a numeric forecast');
  assert.ok(refusal.details.forecast < 100);
  assert.match(JSON.stringify(refusal), /--capacity ollama/);
  assert.match(JSON.stringify(refusal), new RegExp(reset));
  assert.equal(won.capacity, 'codex');
  const free = ids.find(id => id !== won.id)!;
  assert.equal((await f.client.get(free)).item.assignee, undefined);
  assert.equal(f.run('swarm', 'capacity', 'codex').active_lanes, 1);
  assert.equal((await runCapacityRetry(f, refusal.details.next_command)).capacity, 'ollama');
});

/** Execute the CLI's literal retry command in the same scratch tracker. */
async function runCapacityRetry(f: Awaited<ReturnType<typeof sharedFixture>>, command: string): Promise<Record<string, unknown>> {
  const launcher = 'pm() { "$SWARM_TEST_NODE" "$SWARM_TEST_HOST" "$@"; }\n';
  const result = await runProcess('/bin/sh', ['-ec', launcher + command + ' --json'], f.repo,
    { ...f.env, SWARM_TEST_NODE: process.execPath, SWARM_TEST_HOST: f.host });
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test('capacity dry-run and start use the same forecast refusal and JSON/TOON remedies', async t => {
  const f = await sharedFixture(t);
  const reset = declare(f, 'codex', 1);
  declare(f, 'ollama', 1);
  let fallbackCommand = '';
  const id = await f.item(['src/standalone.ts']);
  const now = Date.now();
  f.run('swarm', 'capacity', 'codex', '--action', 'observe', '--used', '10', '--source', 'manual', '--at', new Date(now - 10_000).toISOString());
  f.run('swarm', 'capacity', 'codex', '--action', 'observe', '--used', '30', '--source', 'manual', '--at', new Date(now - 1_000).toISOString());
  for (const [args, format] of [
    [['next', '--dry-run'], 'toon'], [['start', id, '--strict'], 'json'],
  ] as const) {
    const refusal = f.cli('swarm', ...args, '--capacity', 'codex,ollama', '--output-format', format);
    assert.equal(refusal.status, 2);
    const output = refusal.stdout + refusal.stderr;
    assert.match(output, /capacity_forecast_exceeded/);
    assert.match(output, /used 30, forecast /);
    assert.ok(output.includes(reset));
    assert.match(output, /--capacity ollama/);
    if (format === 'json') {
      assert.match(output, /--strict --agent/);
      const body = JSON.parse(refusal.stdout || refusal.stderr) as { details: Record<string, unknown> };
      assert.equal(body.details.next_capacity, 'ollama');
      assert.equal(body.details.used, 30);
      fallbackCommand = String(body.details.next_command);
    }
    else assert.match(output, /--dry-run --agent/);
  }
  assert.equal((await f.client.get(id)).item.assignee, undefined);
  assert.equal((await runCapacityRetry(f, fallbackCommand)).capacity, 'ollama');
});

for (const exhaustion of ['reported', 'measured']) test(`${exhaustion} exhaustion keeps its code and offers the next capacity in order`, async t => {
  const f = await sharedFixture(t);
  const reset = declare(f, 'codex', 1);
  declare(f, 'ollama', 1);
  if (exhaustion === 'reported') {
    const stopped = await f.item(['src/stopped.ts']);
    const claim = await f.shared.start(stopped, {}, true, 'codex');
    f.run('swarm', 'interrupt', stopped, '--capacity', 'codex', '--reason', 'capacity_exhausted', '--token', claim.token);
  } else {
    f.run('swarm', 'capacity', 'codex', '--action', 'observe', '--used', '100', '--source', 'manual');
  }
  const ready = await f.item(['src/ready.ts']);
  const refusal = f.cli('swarm', 'start', ready, '--capacity', 'codex,ollama', '--json');
  assert.equal(refusal.status, 2);
  const body = JSON.parse(refusal.stderr || refusal.stdout) as { code: string; details: { used: number | null; resets_at: string; next_command: string } };
  assert.equal(body.code, 'capacity_exhausted');
  assert.equal(body.details.used, exhaustion === 'reported' ? null : 100);
  assert.equal(body.details.resets_at, reset);
  assert.equal((await runCapacityRetry(f, body.details.next_command)).capacity, 'ollama');
});

test('Git start binds a fenced capacity lane and cleans up its slot after publication failure', async t => {
  const f = await fixture(t);
  const capacities = new Capacities(f.swarm);
  await capacities.run('runner', { action: 'declare', limit: 100, unit: 'percent', window: '1d', resetsAt: new Date(Date.now() + 3_600_000).toISOString() });
  await capacities.run('runner', { action: 'policy', else: 1 });
  const first = await f.item(['src/first.ts']); const second = await f.item(['src/second.ts']);
  await assert.rejects(withStartTransitionObserver(transition => {
    if (transition === 'published') throw new Error('Fixture post-publication failure');
  }, () => f.swarm.start(first, {}, true, 'runner')), /Fixture post-publication failure/);
  assert.equal((await capacities.run('runner')).active_lanes, 0);
  const lane = await f.swarm.start(second, {}, true, 'runner');
  assert.equal(lane.capacity, 'runner');
  assert.equal(lane.token, '1');
  assert.equal((await capacities.run('runner')).active_lanes, 1);
  await assert.rejects(f.swarm.start(first, {}, true, 'runner'), /capacity_lanes_occupied/);
});

test('a fenced interruption is idempotent and prevents reclaim until its reset', async t => {
  const f = await sharedFixture(t);
  const reset = declare(f, 'runner', 2);
  declare(f, 'other', 1);
  const lane = await f.item(['src/paused.ts']);
  const waiting = await f.item(['src/waiting.ts']);
  const { token } = await f.shared.start(lane, {}, true, 'runner');
  const interrupt = ['swarm', 'interrupt', lane, '--reason', 'capacity_exhausted', '--capacity', 'runner'];
  const wrong = f.cli(...interrupt, '--token', '0', '--json');
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr + wrong.stdout, /swarm_stale_fence/);
  const paused = f.run(...interrupt, '--token', token);
  assert.equal((paused.interruption as { resets_at: string }).resets_at, reset);
  const history = () => readHistoryEntries(getHistoryPath(f.pmRoot, lane), lane);
  const count = (await history()).length;
  assert.deepEqual(f.run(...interrupt, '--token', token), paused);
  assert.equal((await history()).length, count);
  assert.equal((await f.client.get(lane)).item.assignee, 'shared-test');
  assert.equal(f.run('swarm', 'capacity', 'runner').reported_exhausted, true);
  const next = f.cli('swarm', 'next', '--agent', 'dispatcher', '--capacity', 'runner,other', '--json');
  assert.equal(next.status, 2);
  assert.match(next.stderr + next.stdout, /capacity_exhausted/);
  assert.equal((await f.client.get(waiting)).item.assignee, undefined);
  await assert.rejects(f.shared.start(lane), /capacity_exhausted/);
  await assert.rejects(f.shared.handoff(lane, 'receiver', 'Public checkpoint', token), /capacity_exhausted/);

  const dispatcher = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'dispatcher'));
  for (const preview of [true, false]) {
    const result = await dispatcher.reclaim(0.001, 'receiver', preview);
    assert.deepEqual(result.recovered, []);
    assert.equal(result.refused.find(row => row.id === lane)?.code, 'capacity_exhausted');
  }
  assert.equal((await history()).length, count);
  const clock = t.mock.method(Date, 'now', () => Date.parse(reset) + 1);
  const released = await dispatcher.reclaim(0.001, 'receiver');
  clock.mock.restore();
  assert.equal(released.recovered[0].agent, 'receiver');
  const recovered = (await f.client.get(lane)).item;
  assert.equal(recovered.swarm_token, '2');
  assert.equal(recovered.swarm_capacity, undefined);
  await assert.rejects(f.shared.heartbeat(lane, token), /swarm_stale_fence/);
});

test('fair scheduling applies capacity admission and preserves policy flags in retries', async t => {
  const f = await sharedFixture(t);
  declare(f, 'primary', 0);
  declare(f, 'alternate', 1);
  const id = await f.item(['src/fair.ts']);
  await f.client.update(id, { addTags: ['skill:typescript'] });
  const refusal = f.cli('swarm', 'schedule', '--skills', 'typescript', '--max-wait', '30', '--limit', '1',
    '--dry-run', '--capacity', 'primary,alternate', '--json');
  assert.equal(refusal.status, 2);
  assert.match(refusal.stdout + refusal.stderr, /capacity_policy_denied/);
  assert.match(refusal.stdout + refusal.stderr, /pm swarm schedule --dry-run --skills typescript --max-wait 30 --limit 1 --agent shared-test --capacity alternate/);
  const ready = f.run('swarm', 'schedule', '--skills', 'typescript', '--capacity', 'alternate');
  assert.equal(ready.selected, id);
  assert.equal(ready.capacity, 'alternate');
  assert.equal(f.run('swarm', 'capacity', 'alternate').active_lanes, 1);
});

test('host help and the README replay agree with the real non-Git CLI', async t => {
  const f = await sharedFixture(t);
  const help = {
    capacity: [/declare, observe, policy or status/, /Positive capacity limit/, /Public unit label/, /s, m, h, d or w suffix/,
      /ISO reset timestamp/, /Caller-measured cumulative usage/, /Public source label/, /ISO observation time/,
      /Repeatable strict threshold/, /Allowed lanes when no band matches/, /recent, window or max/],
    next: [/comma-separated retry order/, /capacity_lanes_occupied/],
    start: [/comma-separated retry order/],
    schedule: [/comma-separated retry order/],
    interrupt: [/Single capacity name/, /Stop reason: capacity_exhausted/],
    brief: [/comma-separated retry order/, /with --continuation --to/, /Read the current fenced continuation packet/,
      /Receiver of the continuation fence/, /Maximum estimated tokens in JSON and TOON/],
  };
  for (const [verb, descriptions] of Object.entries(help)) {
    const result = f.cli('swarm', verb, '--help');
    assert.equal(result.status, 0, result.stderr);
    for (const description of descriptions) assert.match(result.stdout.replace(/\s+/g, ' '), description);
  }
  const queued = await f.item(['src/queued.ts'], 1, 'queued');
  const task = await f.item(['src/task.ts'], 3, 'task-id');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.split('## Windowed capacity')[1].split('## Budgeted assignment briefs')[0];
  const blocks = Array.from(section.matchAll(/```sh\n([\s\S]+?)\n```/g), match => match[1]);
  assert.equal(blocks.length, 3, 'README must include the replay, claim, and transfer scripts');
  const script = 'pm() { "$SWARM_TEST_NODE" "$SWARM_TEST_HOST" "$@"; }\n' + blocks.join('\n');
  const result = await runProcess('/bin/sh', ['-ec', script], f.repo, { ...f.env, SWARM_TEST_NODE: process.execPath, SWARM_TEST_HOST: f.host });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /"admitted_lane_count":2/);
  assert.match(result.stdout, /"forecast_recent":76\.01/);
  assert.match(result.stdout, /"forecast_window":90\.1/);
  assert.equal((await f.client.get(queued)).item.assignee, 'worker');
  const transferred = (await f.client.get(task, { depth: 'full' })).item;
  assert.equal(transferred.assignee, 'worker-2');
  assert.equal(transferred.swarm_capacity, 'ollama');
  assert.equal(transferred.swarm_token, '2');
  const interrupt = f.cli('swarm', 'interrupt', task, '--agent', 'worker-2', '--token', '2',
    '--reason', 'capacity_exhausted', '--capacity', 'ollama,codex', '--json');
  assert.equal(interrupt.status, 2);
  assert.match(interrupt.stderr || interrupt.stdout, /capacity_invalid/);
  const read = f.cli('swarm', 'brief', task, '--agent', 'worker-2', '--token', '2', '--continuation', '--capacity', 'ollama', '--json');
  assert.equal(read.status, 2);
  assert.match(read.stderr || read.stdout, /Supply --to/);
});

test('invalid capacity input is side-effect free and a native peer edit wins a revision race', async t => {
  const f = await sharedFixture(t);
  const now = Date.parse('2026-11-25T08:00:00Z');
  const capacity = new Capacities(f.shared.engine, () => now);
  const declaration = { action: 'declare', limit: 100, unit: 'percent', window: '7d', resetsAt: '2026-11-25T12:00:00Z' };
  for (const [name, options] of [
    ['bad label', declaration], ['codex', { ...declaration, unit: ' '.repeat(90) }],
    ['codex', { ...declaration, limit: 0 }], ['codex', { ...declaration, limit: '0xff' }],
    ['codex', { ...declaration, window: '0d' }], ['codex', { ...declaration, window: '400d' }],
    ['codex', { ...declaration, resetsAt: '2026-11-25' }], ['codex', { ...declaration, resetsAt: '2026-11-25T07:00:00Z' }],
    ['codex', { ...declaration, resetsAt: '2026-12-05T12:00:00Z' }], ['codex', { action: 'invalid' }],
  ] as const) await assert.rejects(capacity.run(name, options), /capacity_invalid/);
  assert.equal((await f.shared.engine.corpus()).items.length, 0);
  await capacity.run('codex', declaration);
  for (const policy of [
    { band: ['forecast<=80=1'] }, { band: ['forecast<80=9007199254740992'] },
    { band: ['forecast<95=2', 'forecast<88=3'] }, { else: 1.1 },
  ]) await assert.rejects(capacity.run('codex', { ...policy, action: 'policy' }), /capacity_invalid/);
  for (const at of ['2026-11-25T09:00:00Z', '2026-11-13T09:00:00Z']) {
    await assert.rejects(capacity.run('codex', { action: 'observe', used: 10, source: 'manual estimate', at }), /active window/);
  }
  const record = (await f.shared.engine.corpus()).items.find(item => item.tags.includes('swarm-capacity'))!;
  const count = (await readHistoryEntries(getHistoryPath(f.pmRoot, record.id), record.id)).length;
  let intervened = false;
  await assert.rejects(withItemMutationObserver(boundary => {
    if (boundary !== 'before_commit' || intervened) return;
    intervened = true;
    f.run('update', record.id, '--title', 'Human-readable quota name');
  }, () => capacity.run('codex', { action: 'observe', used: 40, source: 'manual estimate' })), /swarm_superseded/);
  assert.equal(intervened, true);
  assert.equal((await readHistoryEntries(getHistoryPath(f.pmRoot, record.id), record.id)).length, count + 1);
  assert.equal((await capacity.run('codex')).used, null);
});

test('stale over-limit samples are labeled and cannot suppress the unknown-forecast fallback', async t => {
  const f = await sharedFixture(t);
  let now = Date.parse('2026-11-25T08:00:00Z');
  const capacity = new Capacities(f.shared.engine, () => now);
  await capacity.run('limited', { action: 'declare', limit: 100, window: '7d', unit: 'percent', resetsAt: '2026-11-28T12:00:00Z' });
  await capacity.run('limited', { action: 'policy', band: ['forecast<88=3'], else: 1 });
  const observed = await capacity.run('limited', { action: 'observe', used: 100, source: 'manual' });
  assert.equal(observed.admitted_lane_count, 0);
  now += OBSERVATION_MAX_AGE_MS + 1;
  const stale = await capacity.run('limited');
  assert.equal(stale.admitted_lane_count, 1);
  assert.equal(stale.observation_stale, true);
  assert.equal(stale.forecast, null);
});

test('Git start preserves a lane interrupted through the shared tracker engine', async t => {
  const f = await fixture(t);
  const shared = new SharedTracker(f.swarm);
  const capacities = new Capacities(f.swarm);
  for (const name of ['primary', 'alternate']) {
    await capacities.run(name, { action: 'declare', limit: 100, window: '1d', unit: 'percent', resetsAt: new Date(Date.now() + 3_600_000).toISOString() });
    await capacities.run(name, { action: 'policy', else: 1 });
  }
  const id = await f.item(['src/stopped.ts']);
  const assignment = await shared.start(id, {}, true, 'primary');
  await interruptLane(f.swarm, id, assignment.token, 'primary', 'capacity_exhausted');
  const entries = await readHistoryEntries(getHistoryPath(f.pmRoot, id), id);
  await assert.rejects(f.swarm.start(id, {}, true, 'alternate'), /capacity_exhausted/);
  assert.equal((await f.client.get(id)).item.swarm_branch, undefined);
  assert.deepEqual(await readHistoryEntries(getHistoryPath(f.pmRoot, id), id), entries);
});
