import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { TestContext } from 'node:test';
import { sharedFixture } from './shared-helpers.ts';

/** Copy an independently verified public fleet tracker and retain read-only byte fingerprints. */
export async function publicCorpus(t: TestContext) {
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

  return { f, inspect, head, hashes, baseline };
}

/** Verify every read-only source byte and return only aggregate public measurements. */
export function corpusEvidence(snapshot: Awaited<ReturnType<typeof publicCorpus>>) {
  const { f, inspect, head, hashes, baseline } = snapshot;
  for (const [path, hash] of hashes) assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), hash, relative(f.pmRoot, path));
  assert.equal(inspect(['rev-parse', 'origin/main']).toString().trim(), head);
  return { source: 'unbraind/pm-ops', head, baseline_files: baseline.length, baseline_bytes: baseline.reduce((sum, path) => sum + readFileSync(path).length, 0), baseline_changed: 0 };
}
