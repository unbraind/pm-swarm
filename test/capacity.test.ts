import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getHistoryPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { Capacities, OBSERVATION_MAX_AGE_MS } from '../index.ts';
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
