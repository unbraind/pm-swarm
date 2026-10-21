import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { ResourceReservations, trackerResourceBackend, RESOURCE_TAG } from '../index.ts';
import { Swarm } from '../src/swarm.ts';
import { sharedFixture } from './shared-helpers.ts';

test('read-only committed public fleet corpus stays unchanged during non-Git resource coordination', async t => {
  const source = process.env.PUBLIC_TRACKER_REPO; assert.ok(source, 'Set PUBLIC_TRACKER_REPO to the public pm-ops checkout');
  /** Inspect a committed public source; never write to that checkout. */
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  assert.match(git('remote', 'get-url', 'origin'), /^https:\/\/github\.com\/unbraind\/pm-ops(?:\.git)?$/);
  const head = git('rev-parse', 'origin/main');
  const archive = spawnSync('git', ['-C', source, 'archive', head, '.agents/pm'], { maxBuffer: 32 * 1024 * 1024 });
  assert.equal(archive.status, 0);
  const f = await sharedFixture(t);
  const extracted = spawnSync('tar', ['-x', '-C', f.repo], { input: archive.stdout }); assert.equal(extracted.status, 0);
  /** Enumerate only the copied tracker, excluding ignored runtime and the test extension. */
  const files = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (['runtime', 'locks', 'extensions'].includes(entry.name)) return [];
    const path = join(root, entry.name); return entry.isDirectory() ? files(path) : [path];
  });
  const baseline = files(f.pmRoot);
  const hashes = new Map(baseline.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
  for (const path of baseline) chmodSync(path, 0o444);
  const started = performance.now(); const corpus = await f.shared.engine.corpus();
  assert.ok(corpus.items.length > 50);
  const a = new ResourceReservations(trackerResourceBackend(f.shared.engine), 'worker-a');
  const b = new ResourceReservations(trackerResourceBackend(new Swarm(f.repo, f.pmRoot, f.client, 'worker-b')), 'worker-b');
  let busy = 0; let stale = 0;
  const id = (await f.client.create({ type: 'Task', title: 'Synthetic public-corpus resource proof', tags: RESOURCE_TAG })).item.id;
  const first = await a.reserve(id, 60);
  await assert.rejects(b.reserve(id), error => { busy++; return typeof error === 'object' && error !== null && 'code' in error && error.code === 'resource_busy'; });
  await a.publish(id, first.token, 'Synthetic corpus validation result');
  await a.renew(id, first.token, 120); await a.release(id, first.token);
  const second = await b.reserve(id, 60);
  await assert.rejects(a.publish(id, first.token, 'Stale'), error => { stale++; return typeof error === 'object' && error !== null && 'code' in error && error.code === 'resource_stale_fence'; });
  await b.release(id, second.token);
  const status = f.run('swarm', 'resource', id);
  assert.equal(status.held, false);
  let bytes = 0;
  for (const [path, hash] of hashes) {
    const body = readFileSync(path); bytes += body.length;
    assert.equal(createHash('sha256').update(body).digest('hex'), hash, relative(f.pmRoot, path));
  }
  assert.equal(git('rev-parse', 'origin/main'), head);
  console.log(JSON.stringify({ source: 'unbraind/pm-ops', head, items: corpus.items.length, baseline_files: baseline.length, baseline_bytes: bytes, resource_records: 1, successful_mutations: 7, busy_refusals: busy, stale_refusals: stale, final_generation: status.token, json_bytes: Buffer.byteLength(JSON.stringify(status)), baseline_changed: 0, elapsed_ms: Math.round(performance.now() - started) }));
});
