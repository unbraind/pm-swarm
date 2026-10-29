import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { Swarm, ResourceDeadlocks, RESOURCE_TAG } from '../index.ts';
import { inspectItems } from '../src/inspection.ts';

/** Hash every regular file in an explicitly supplied public scratch tracker. */
function snapshot(root: string): string {
  const hash = createHash('sha256');
  for (const name of readdirSync(root, { recursive: true, encoding: 'utf8' }).sort()) {
    const path = join(root, name);
    if (statSync(path).isFile()) hash.update(name).update(readFileSync(path));
  }
  return hash.digest('hex');
}

const pmRoot = process.argv[2];
assert.ok(pmRoot, 'Supply a public tracker copy outside Git.');
const cwd = dirname(dirname(pmRoot));
process.env.GIT_CEILING_DIRECTORIES = dirname(cwd);
const client = new PmClient({ cwd, pmRoot, author: 'public-validation', noExtensions: false });
const before = snapshot(pmRoot);
const started = performance.now();
const items = await inspectItems(pmRoot, cwd);
assert.ok(items);
const report = await new ResourceDeadlocks(new Swarm(cwd, pmRoot, client, 'public-validation')).detect(50);
const elapsed = Math.round(performance.now() - started);
assert.equal(snapshot(pmRoot), before, 'Read-only public tracker changed');
assert.equal(report.resources, items.filter(item => item.tags.includes(RESOURCE_TAG)).length);
console.log(JSON.stringify({ items: items.length, resources: report.resources, requests: report.requests, edges: report.edges.length, cycles: report.cycles.length, alternatives: report.alternatives.length, elapsed_ms: elapsed, changed_files: 0, tracker_sha256: before, git_required: false }));
