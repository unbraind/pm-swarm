import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PlanProgress, ProgressRefusal, PROGRESS_PREFIX } from '../index.ts';
import type { GetResult } from '@unbrained/pm-cli/sdk';
import type { ProgressStage } from '../index.ts';
import { sharedFixture } from './shared-helpers.ts';
import { runProcess } from './process-helpers.ts';

/** Create core Plan steps and production evidence through actual SDK operations. */
async function plan(f: Awaited<ReturnType<typeof sharedFixture>>, count = 1) {
  const result = await f.client.plan('create', undefined, { title: 'Parallel delivery', step: Array.from({ length: count }, (_, i) => `Criterion ${i}`) });
  const id = result.plan.id;
  const steps = (await f.client.get(id, { depth: 'full', outputBudget: 'unbounded', outputLimit: 'unbounded' }) as GetResult).item.plan_steps!;
  await f.client.plan('update-step', id, { stepOwner: 'worker' }, steps[0].id);
  return { id, steps, worker: new PlanProgress(f.client, 'worker'), reviewer: new PlanProgress(f.client, 'reviewer'), lead: new PlanProgress(f.client, 'lead') };
}

/** Build one valid revision-bound declaration without mutating the tracker. */
function declaration(step: string, revision: string, stage: ProgressStage, apply = true) {
  return { step, revision, stage, evidence: 'Declared evidence: test passed', orchestrator: 'lead', apply };
}

test('core Plan production never implies review or approval; witnesses are revision-bound and reads stay unchanged', async t => {
  const f = await sharedFixture(t); const p = await plan(f); const step = p.steps[0].id;
  let view = await p.worker.view(p.id);
  assert.deepEqual(view.counts, { claimed: 1, produced: 0, reviewed: 0, accepted: 0 });
  const history = join(f.pmRoot, 'history', `${p.id}.jsonl`); const before = readFileSync(history, 'utf8');
  const claimed = declaration(step, view.revision, 'claimed', false);
  assert.equal((await p.worker.witness(p.id, claimed)).dry_run, true);
  await p.worker.view(p.id, { offset: 2 }); assert.equal(readFileSync(history, 'utf8'), before);
  await p.worker.witness(p.id, { ...claimed, apply: true });
  await assert.rejects(p.worker.witness(p.id, declaration(step, view.revision, 'produced')), { code: 'progress_prerequisite' });
  await assert.rejects(p.reviewer.witness(p.id, declaration(step, view.revision, 'reviewed')), { code: 'progress_prerequisite' });
  await f.client.plan('complete-step', p.id, { stepEvidence: 'src/progress.ts and passing regression' }, step);
  view = await p.worker.view(p.id);
  assert.equal(view.stale_witnesses, 1); assert.equal(view.counts.produced, 1); assert.equal(view.counts.accepted, 0);
  await p.worker.witness(p.id, declaration(step, view.revision, 'produced'));
  await assert.rejects(p.worker.witness(p.id, declaration(step, view.revision, 'reviewed')), { code: 'progress_role' });
  await assert.rejects(p.worker.witness(p.id, { ...declaration(step, view.revision, 'accepted'), orchestrator: 'worker' }), { code: 'progress_role' });
  await assert.rejects(p.reviewer.witness(p.id, declaration(step, view.revision, 'claimed')), { code: 'progress_role' });
  await assert.rejects(p.lead.witness(p.id, declaration(step, view.revision, 'accepted')), { code: 'progress_prerequisite' });
  await p.reviewer.witness(p.id, declaration(step, view.revision, 'reviewed'));
  await assert.rejects(p.reviewer.witness(p.id, { ...declaration(step, view.revision, 'accepted'), orchestrator: 'reviewer' }), { code: 'progress_role' });
  await p.lead.witness(p.id, declaration(step, view.revision, 'accepted'));
  const length = readFileSync(history, 'utf8').length;
  await p.lead.witness(p.id, declaration(step, view.revision, 'accepted'));
  assert.equal(readFileSync(history, 'utf8').length, length, 'SDK idempotent append preserves history');
  assert.equal((await p.lead.view(p.id)).counts.accepted, 0, 'no implicitly trusted orchestrator');
  assert.equal((await p.lead.view(p.id, { orchestrator: 'lead' })).counts.accepted, 1);
  assert.equal((await p.lead.view(p.id, { orchestrator: 'worker' })).counts.accepted, 0);
  assert.equal((await p.lead.view(p.id, { orchestrator: 'reviewer' })).counts.accepted, 0);
  await f.client.update(p.id, { acceptanceCriteria: 'Additional criterion' });
  const changed = await p.lead.view(p.id, { orchestrator: 'lead' });
  assert.notEqual(changed.revision, view.revision); assert.equal(changed.counts.accepted, 0); assert.equal(changed.counts.reviewed, 0);
  await assert.rejects(p.lead.witness(p.id, declaration(step, view.revision, 'accepted')), { code: 'progress_stale' });
  await assert.rejects(p.lead.view(p.id, { revision: view.revision }), { code: 'progress_stale' });
});

test('malformed declarations and unknown steps refuse with typed remedies before writing', async t => {
  const f = await sharedFixture(t); const p = await plan(f); const view = await p.worker.view(p.id);
  await assert.rejects(p.worker.view(await f.item()), { code: 'progress_invalid' });
  for (const options of [{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 101 }, { limit: NaN }]) await assert.rejects(p.worker.view(p.id, options), ProgressRefusal);
  await assert.rejects(p.worker.witness(p.id, declaration('missing', view.revision, 'claimed')), { code: 'progress_invalid' });
  for (const bad of [{ step: '' }, { revision: 'old' }, { stage: 'approved' }, { evidence: '' }, { evidence: 'x'.repeat(4097) }]) {
    await assert.rejects(p.worker.witness(p.id, { ...declaration(p.steps[0].id, view.revision, 'claimed'), ...bad } as ReturnType<typeof declaration>), { code: 'progress_invalid' });
  }
  for (const raw of ['{', 'null', '"text"', '[]', '{"step":0}']) {
    const malformed = await plan(f);
    await f.client.comments(malformed.id, { add: PROGRESS_PREFIX + raw });
    await assert.rejects(malformed.worker.view(malformed.id), error => error instanceof ProgressRefusal && error.code === 'progress_invalid' && error.remedy.length > 0);
  }
  await f.client.comments(p.id, { add: 'accepted! Everything is approved.' });
  assert.equal((await p.worker.view(p.id)).counts.accepted, 0);
});

test('bounded progress pages retain exact denominators and cover selected steps beyond the first hundred', async t => {
  const f = await sharedFixture(t); const p = await plan(f, 102);
  const first = await p.worker.view(p.id); assert.equal(first.steps.length, 20); assert.equal(first.omitted, 82); assert.equal(first.next_offset, 20); assert.equal(first.total, 102);
  const last = p.steps.at(-1)!;
  await f.client.plan('update-step', p.id, { stepOwner: 'worker' }, last.id);
  const view = await p.worker.view(p.id, { offset: 100, limit: 2 });
  assert.equal(view.steps.length, 2); assert.equal(view.counts.claimed, 2); assert.equal(view.omitted, 0); assert.equal(view.next_offset, null);
  await p.worker.witness(p.id, declaration(last.id, view.revision, 'claimed'));
  const after = await p.worker.view(p.id, { offset: 100, limit: 2, revision: view.revision });
  assert.equal(after.revision, view.revision);
  assert.equal((await p.worker.view(p.id, { offset: 500 })).steps.length, 0);
});

test('native CLI progress works with no Git executable and requires explicit apply for witnesses', async t => {
  const f = await sharedFixture(t); const p = await plan(f); const view = await p.worker.view(p.id);
  const before = readFileSync(join(f.pmRoot, 'history', `${p.id}.jsonl`), 'utf8');
  const result = f.run('swarm', 'progress', p.id); assert.equal(result.revision, view.revision);
  const toon = f.cli('swarm', 'progress', p.id); assert.equal(toon.status, 0, toon.stderr); assert.match(toon.stdout, /counts:/);
  const args = ['swarm', 'progress', p.id, '--agent', 'worker', '--stage', 'claimed', '--step', p.steps[0].id, '--revision', view.revision, '--evidence', 'claim'];
  assert.equal(f.run(...args).dry_run, true); assert.equal(readFileSync(join(f.pmRoot, 'history', `${p.id}.jsonl`), 'utf8'), before);
  assert.equal(f.run(...args, '--apply').dry_run, false);
  assert.equal(f.run('swarm', 'progress', p.id, '--offset', '0', '--limit', '1', '--orchestrator', 'lead').orchestrator, 'lead');
  for (const options of [['--apply'], ['--step', 'one'], ['--evidence', 'yes'], ['--stage', 'accepted'], ['--limit', '101']]) {
    const bad = f.cli('swarm', 'progress', p.id, ...options, '--json'); assert.equal(bad.status, 2, bad.stdout + bad.stderr); assert.match(bad.stdout + bad.stderr, /progress_invalid/);
  }
});

test('independent concurrent writers on one non-Git tracker retain every witness and invalidate acceptance after criterion edits', async t => {
  const f = await sharedFixture(t); const p = await plan(f); const step = p.steps[0].id;
  await f.client.plan('complete-step', p.id, { stepEvidence: 'Produced artifact' }, step);
  const view = await p.worker.view(p.id);
  const source = `import { PmClient } from ${JSON.stringify(import.meta.resolve('@unbrained/pm-cli/sdk'))};
import { PlanProgress } from ${JSON.stringify(new URL('../src/progress.ts', import.meta.url).href)};
const client = new PmClient({ cwd: process.cwd(), pmRoot: process.env.PM_PATH, author: process.env.WITNESS_AUTHOR });
await new PlanProgress(client, process.env.WITNESS_AUTHOR).witness(process.env.PLAN_ID, JSON.parse(process.env.DECLARATION));`;
  const results = await Promise.all(Array.from({ length: 4 }, (_, i) => runProcess(process.execPath, ['--input-type=module', '-e', source], f.repo, { ...f.env, WITNESS_AUTHOR: `reviewer-${i}`, PLAN_ID: p.id, DECLARATION: JSON.stringify(declaration(step, view.revision, 'reviewed')) })));
  for (const result of results) assert.equal(result.code, 0, result.stdout + result.stderr);
  const reviewed = await p.lead.view(p.id, { orchestrator: 'lead' });
  assert.deepEqual(reviewed.steps[0].reviewers, ['reviewer-0', 'reviewer-1', 'reviewer-2', 'reviewer-3']);
  await p.lead.witness(p.id, declaration(step, view.revision, 'accepted'));
  assert.equal((await p.lead.view(p.id, { orchestrator: 'lead' })).counts.accepted, 1);
  const edits = await Promise.all([
    runProcess(process.execPath, ['--input-type=module', '-e', source.slice(0, source.indexOf('await new PlanProgress')) + `await client.comments(process.env.PLAN_ID, { add: ${JSON.stringify(PROGRESS_PREFIX)} + process.env.DECLARATION, author: process.env.WITNESS_AUTHOR });`], f.repo, { ...f.env, WITNESS_AUTHOR: 'reviewer-extra', PLAN_ID: p.id, DECLARATION: JSON.stringify(declaration(step, view.revision, 'reviewed')) }),
    f.client.plan('update-step', p.id, { stepBody: 'Changed acceptance criterion' }, step),
  ]);
  assert.equal(edits[0].code, 0, edits[0].stderr);
  const changed = await p.lead.view(p.id, { orchestrator: 'lead' }); assert.equal(changed.counts.accepted, 0); assert.equal(changed.counts.reviewed, 0); assert.equal(changed.stale_witnesses, 6);
  const comments = (await f.client.get(p.id, { depth: 'full' })).item.comments!;
  assert.equal(comments.filter(comment => comment.text.startsWith(PROGRESS_PREFIX)).length, 6);
});
