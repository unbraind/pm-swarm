import assert from 'node:assert/strict';
import { publicCorpus, corpusEvidence } from './public-corpus-helpers.ts';
import { test } from 'node:test';
import { settings, assertPrivatePathSafe } from '../src/settings.ts';

test('public fleet settings and rendering read a non-Git copy without changing baseline bytes', async t => {
  const snapshot = await publicCorpus(t); const { f } = snapshot;
  const start = performance.now(); const corpus = await f.shared.engine.corpus();
  const config = await settings(f.pmRoot); assert.equal(config.lane_limit, 4);
  const preview = f.run('swarm', 'settings', '--limit', '2');
  assert.equal((preview.swarm as { lane_limit: number }).lane_limit, 2); assert.equal(preview.dry_run, true);
  assert.equal((await settings(f.pmRoot)).lane_limit, 4);
  const first = await f.shared.plan(undefined, 2); const second = await f.shared.plan(undefined, 2); assert.deepEqual(first, second);
  const cli = preview;
  const toon = f.cli('swarm', 'settings', '--limit', '2');
  assert.equal(toon.status, 0, toon.stderr);
  assertPrivatePathSafe(cli); assertPrivatePathSafe(toon.stdout);
  const plan = f.run('swarm', 'plan', '--limit', '2');
  const status = f.run('swarm', 'status');
  console.log(JSON.stringify({ ...corpusEvidence(snapshot), public_items: corpus.items.length, candidates: first.suggested_start_set.length, planned_lanes: first.lanes.length, active_lanes: (status.lanes as unknown[]).length, equal_input_equal_receipts: true, sdk_previews: 3, cli_previews: 4, json_bytes: Buffer.byteLength(JSON.stringify(cli)), toon_bytes: Buffer.byteLength(toon.stdout), plan_json_bytes: Buffer.byteLength(JSON.stringify(plan)), elapsed_ms: Math.round(performance.now() - start) }));
});
