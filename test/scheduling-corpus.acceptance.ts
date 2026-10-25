import assert from 'node:assert/strict';
import { publicCorpus, corpusEvidence } from './public-corpus-helpers.ts';
import { test } from 'node:test';

test('public fleet scheduling reads a non-Git copy without changing baseline bytes', async t => {
  const snapshot = await publicCorpus(t); const { f } = snapshot;
  const start = performance.now(); const corpus = await f.shared.engine.corpus();
  const options = { skills: ['typescript'], now: '2026-10-23T15:00:00.000Z', maxWaitSeconds: 86400, dryRun: true, limit: 5 };
  const first = await f.shared.schedule(options); const second = await f.shared.schedule(options); assert.deepEqual(first, second);
  const cli = f.run('swarm', 'schedule', '--skills', 'typescript', '--dry-run', '--limit', '5');
  const toon = f.cli('swarm', 'schedule', '--skills', 'typescript', '--dry-run', '--limit', '5'); assert.equal(toon.status, 0, toon.stderr);
  console.log(JSON.stringify({ ...corpusEvidence(snapshot), public_items: corpus.items.length, native_skill_tags: corpus.items.flatMap(item => item.tags).filter(tag => tag.startsWith('skill:')).length, native_preferences: corpus.items.filter(item => item.swarm_preferred_agent !== undefined).length, counts: first.counts, selected: first.selected, decision_rows: first.decisions.length, omitted: first.omitted, equal_input_equal_receipts: true, sdk_previews: 2, cli_previews: 2, json_bytes: Buffer.byteLength(JSON.stringify(cli)), toon_bytes: Buffer.byteLength(toon.stdout), elapsed_ms: Math.round(performance.now() - start) }));
});
