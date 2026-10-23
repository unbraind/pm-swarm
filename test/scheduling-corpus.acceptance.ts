import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { sharedFixture } from './shared-helpers.ts';

test('public fleet scheduling reads a non-Git copy without changing baseline bytes', async t => {
  const source = process.env.PUBLIC_TRACKER_REPO;
  assert.ok(source, 'Set PUBLIC_TRACKER_REPO to the public pm-ops checkout');
  const metadata: { private: boolean } = JSON.parse(execFileSync('gh', ['api', 'repos/unbraind/pm-ops'], { encoding: 'utf8' }));
  assert.equal(metadata.private, false);
  /** Inspect committed public data without modifying the source checkout. */
  const inspect = (args: string[]) => execFileSync('git', ['-C', source, ...args], { maxBuffer: 32 * 1024 * 1024 });
  const remote = inspect(['remote', 'get-url', 'origin']).toString().trim();
  assert.match(remote, /^https:\/\/github.com\/unbraind\/pm-ops\.git$/);
  const head = inspect(['rev-parse', 'origin/main']).toString().trim();
  const f = await sharedFixture(t);
  execFileSync('tar', ['-x', '-C', f.repo], { input: inspect(['archive', head, '.agents/pm']) });
  const hashes = new Map<string, string>();
  const entries = readdirSync(f.pmRoot, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filename = join(entry.parentPath, entry.name);
    const parts = relative(f.pmRoot, filename).split('/');
    if (parts.some(part => ['extensions', 'runtime', 'locks'].includes(part))) continue;
    hashes.set(filename, createHash('sha256').update(readFileSync(filename)).digest('hex'));
    chmodSync(filename, 0o444);
  }
  const baseline = [...hashes.keys()];
  const start = performance.now(); const corpus = await f.shared.engine.corpus();
  const options = { skills: ['typescript'], now: '2026-10-23T15:00:00.000Z', maxWaitSeconds: 86400, dryRun: true, limit: 5 };
  const first = await f.shared.schedule(options); const second = await f.shared.schedule(options); assert.deepEqual(first, second);
  const cli = f.run('swarm', 'schedule', '--skills', 'typescript', '--dry-run', '--limit', '5');
  const toon = f.cli('swarm', 'schedule', '--skills', 'typescript', '--dry-run', '--limit', '5'); assert.equal(toon.status, 0, toon.stderr);
  for (const [path, hash] of hashes) assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), hash, relative(f.pmRoot, path));
  assert.equal(inspect(['rev-parse', 'origin/main']).toString().trim(), head);
  console.log(JSON.stringify({ source: 'unbraind/pm-ops', head, public_items: corpus.items.length, baseline_files: baseline.length, baseline_bytes: baseline.reduce((sum, path) => sum + readFileSync(path).length, 0), baseline_changed: 0, native_skill_tags: corpus.items.flatMap(item => item.tags).filter(tag => tag.startsWith('skill:')).length, native_preferences: corpus.items.filter(item => item.swarm_preferred_agent !== undefined).length, counts: first.counts, selected: first.selected, decision_rows: first.decisions.length, omitted: first.omitted, equal_input_equal_receipts: true, sdk_previews: 2, cli_previews: 2, json_bytes: Buffer.byteLength(JSON.stringify(cli)), toon_bytes: Buffer.byteLength(toon.stdout), elapsed_ms: Math.round(performance.now() - start) }));
});
