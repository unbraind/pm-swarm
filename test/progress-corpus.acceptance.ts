import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { PlanProgress } from '../index.ts';
import { sharedFixture } from './shared-helpers.ts';

/** Fingerprint a copied public tracker without its disposable runtime or extensions. */
function fingerprints(root: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile() && !relative(root, path).split('/').some(part => ['runtime', 'locks', 'extensions'].includes(part))) result.set(path, createHash('sha256').update(readFileSync(path)).digest('hex'));
  }
  return result;
}

test('public fleet tracker copy retains every baseline byte during non-Git progress validation', async t => {
  const source = process.env.PUBLIC_TRACKER_REPO;
  assert.ok(source, 'Provide the public pm-ops checkout using PUBLIC_TRACKER_REPO');
  assert.equal(execFileSync('gh', ['api', 'repos/unbraind/pm-ops', '--jq', '.private'], { encoding: 'utf8' }).trim(), 'false');
  /** All Git access is read-only and ends before invoking the progress command. */
  const inspect = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
  assert.match(inspect('remote', 'get-url', 'origin'), /github.com[:/]unbraind\/pm-ops(?:\.git)?$/);
  const head = inspect('rev-parse', 'origin/main');
  const archived = execFileSync('git', ['-C', source, 'archive', head, '.agents/pm'], { maxBuffer: 32 * 1024 * 1024 });
  const f = await sharedFixture(t);
  execFileSync('tar', ['-x', '-C', f.repo], { input: archived });
  const baseline = fingerprints(f.pmRoot);
  for (const path of baseline.keys()) chmodSync(path, 0o444);
  const start = performance.now();
  const corpus = await f.shared.engine.corpus();
  const nativePlans = corpus.items.filter(item => item.type === 'Plan');
  for (const item of nativePlans) await new PlanProgress(f.client, 'auditor').view(item.id);
  // Public baseline contains no Plan items; a separately identified scratch overlay
  // exercises the feature against its real workflow/settings and full item corpus.
  const seeded = await f.client.plan('create', undefined, { title: 'Synthetic progress acceptance overlay', step: ['Produce artifact', 'Review edge case', 'Document contract'] });
  const id = seeded.plan.id;
  const initial = (await f.client.get(id, { depth: 'full', outputBudget: 'unbounded' }));
  assert.ok('item' in initial);
  const step = initial.item.plan_steps![0].id;
  await f.client.plan('update-step', id, { stepOwner: 'worker' }, step);
  await f.client.plan('complete-step', id, { stepEvidence: 'Synthetic artifact verified' }, step);
  const reviewer = new PlanProgress(f.client, 'reviewer');
  const lead = new PlanProgress(f.client, 'coordinator');
  const view = await lead.view(id, { orchestrator: 'coordinator' });
  await reviewer.witness(id, { step, revision: view.revision, stage: 'reviewed', evidence: 'Independent synthetic review', apply: true });
  await lead.witness(id, { step, revision: view.revision, stage: 'accepted', evidence: 'Synthetic criterion verified', orchestrator: 'coordinator', apply: true });
  const result = await lead.view(id, { orchestrator: 'coordinator' });
  const historyPath = join(f.pmRoot, 'history', `${id}.jsonl`);
  const historyBefore = readFileSync(historyPath, 'utf8');
  const cli = f.run('swarm', 'progress', id, '--orchestrator', 'coordinator');
  const toon = f.cli('swarm', 'progress', id, '--orchestrator', 'coordinator'); assert.equal(toon.status, 0, toon.stderr);
  assert.equal(readFileSync(historyPath, 'utf8'), historyBefore);
  assert.equal(result.counts.accepted, 1);
  await f.client.update(id, { acceptanceCriteria: 'Changed synthetic criterion' });
  const changed = await lead.view(id, { orchestrator: 'coordinator' }); assert.equal(changed.counts.accepted, 0);
  const after = fingerprints(f.pmRoot);
  for (const [path, hash] of baseline) assert.equal(after.get(path), hash, relative(f.pmRoot, path));
  console.log(JSON.stringify({ source: 'unbraind/pm-ops', head, public_items: corpus.items.length, public_plans: nativePlans.length, baseline_files: baseline.size, baseline_bytes: [...baseline.keys()].reduce((sum, path) => sum + readFileSync(path).length, 0), baseline_changed: 0, overlay_plans: 1, overlay_steps: result.total, counts: result.counts, accepted_after_criterion_change: changed.counts.accepted, json_bytes: Buffer.byteLength(JSON.stringify(cli)), toon_bytes: Buffer.byteLength(toon.stdout), read_history_changes: 0, elapsed_ms: Math.round(performance.now() - start) }));
});
