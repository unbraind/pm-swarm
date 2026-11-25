import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getHistoryPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { Capacities, OBSERVATION_MAX_AGE_MS, withStartTransitionObserver } from '../index.ts';
import { fixture } from './helpers.ts';
import { runProcess } from './process-helpers.ts';
import { sharedFixture } from './shared-helpers.ts';

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
  assert.ok(Math.abs(view.forecast! - (56 + 8 / 7)) < 1e-12);
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

test('policy uses ordered strict forecast thresholds and applies else to unknown values', async t => {
  const f = await sharedFixture(t);
  const now = Date.parse('2026-11-25T08:00:00Z');
  const capacity = new Capacities(f.shared.engine, () => now);
  await capacity.run('codex', { action: 'declare', limit: 100, unit: 'percent', window: '7d', resetsAt: '2026-11-25T12:00:00Z' });
  const policy = { action: 'policy', band: ['forecast<88=3', 'forecast<95=2', 'forecast<98=1'], else: 0 };
  assert.equal((await capacity.run('codex', policy)).admitted_lane_count, 0);
  for (const [at, used] of [
    ['2026-11-24T09:00:00Z', 44], ['2026-11-24T16:00:00Z', 49],
    ['2026-11-25T01:00:00Z', 54], ['2026-11-25T08:00:00Z', 56],
  ] as const) await capacity.run('codex', { action: 'observe', at, used, source: 'codexbar' });
  assert.equal((await capacity.run('codex')).admitted_lane_count, 3);
  const forecast = (await capacity.run('codex')).forecast!;
  assert.equal((await capacity.run('codex', { action: 'policy', band: ['forecast<' + forecast + '=9', 'forecast<60=2'], else: 1 })).admitted_lane_count, 2);
  await assert.rejects(capacity.run('codex', { ...policy, band: ['forecast<95=2', 'forecast<88=3'] }), /strictly increasing/);
});

test('one last capacity slot admits exactly one of two independent next processes', async t => {
  const f = await sharedFixture(t);
  const reset = declare(f, 'runner', 1);
  declare(f, 'fallback', 1);
  const ids = await Promise.all([f.item(['src/a.ts']), f.item(['src/b.ts'])]);
  const workers = await Promise.all(['worker-a', 'worker-b'].map(agent => runProcess(process.execPath,
    [f.host, 'swarm', 'next', '--agent', agent, '--capacity', 'runner,fallback', '--json'], f.repo, f.env)));
  assert.deepEqual(workers.map(result => result.code).sort(), [0, 2], JSON.stringify(workers));
  const won = JSON.parse(workers.find(result => result.code === 0)!.stdout) as Record<string, unknown>;
  const losing = workers.find(result => result.code === 2)!;
  const refusal = JSON.parse(losing.stderr || losing.stdout) as Record<string, unknown>;
  assert.equal(refusal.code, 'capacity_exhausted');
  assert.match(JSON.stringify(refusal), /--capacity fallback/);
  assert.match(JSON.stringify(refusal), new RegExp(reset));
  assert.equal(won.capacity, 'runner');
  const free = ids.find(id => id !== won.id)!;
  assert.equal((await f.client.get(free)).item.assignee, undefined);
  assert.equal(f.run('swarm', 'capacity', 'runner').active_lanes, 1);
  assert.equal(f.run('swarm', 'start', free, '--agent', 'receiver', '--capacity', 'fallback').capacity, 'fallback');
});

test('capacity dry-run and start use the same forecast refusal and JSON/TOON remedies', async t => {
  const f = await sharedFixture(t);
  const reset = declare(f, 'limited', 1);
  const id = await f.item(['src/standalone.ts']);
  const now = Date.now();
  f.run('swarm', 'capacity', 'limited', '--action', 'observe', '--used', '10', '--source', 'manual', '--at', new Date(now - 10_000).toISOString());
  f.run('swarm', 'capacity', 'limited', '--action', 'observe', '--used', '30', '--source', 'manual', '--at', new Date(now - 1_000).toISOString());
  for (const [args, format] of [
    [['next', '--dry-run'], 'toon'], [['start', id, '--strict'], 'json'],
  ] as const) {
    const refusal = f.cli('swarm', ...args, '--capacity', 'limited,alternate', '--output-format', format);
    assert.equal(refusal.status, 2);
    const output = refusal.stdout + refusal.stderr;
    assert.match(output, /capacity_forecast_exceeded/);
    assert.match(output, /used 30, forecast /);
    assert.ok(output.includes(reset));
    assert.match(output, /--capacity alternate/);
    if (format === 'json') assert.match(output, /--strict --agent/);
    else assert.match(output, /--dry-run --agent/);
  }
  assert.equal((await f.client.get(id)).item.assignee, undefined);
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
  await assert.rejects(f.swarm.start(first, {}, true, 'runner'), /capacity_exhausted/);
});
