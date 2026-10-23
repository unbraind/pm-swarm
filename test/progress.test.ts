import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PlanProgress, ProgressRefusal, PROGRESS_PREFIX } from '../index.ts';
import type { GetResult } from '@unbrained/pm-cli/sdk';
import type { ProgressStage } from '../index.ts';
import { sharedFixture } from './shared-helpers.ts';
import { runProcess } from './process-helpers.ts';

/** Bind each worker to the author option the SDK itself records in mutation history. */
function progress(f: Awaited<ReturnType<typeof sharedFixture>>, author: string) {
  return new PlanProgress({ cwd: f.repo, pmRoot: f.pmRoot, author });
}

/** Create core Plan steps and production evidence through actual SDK operations. */
async function plan(f: Awaited<ReturnType<typeof sharedFixture>>, count = 1) {
  f.run('swarm', 'settings', '--progress-orchestrator', 'lead', '--apply');
  const result = await f.client.plan('create', undefined, { title: 'Parallel delivery', step: Array.from({ length: count }, (_, i) => `Criterion ${i}`) });
  const id = result.plan.id;
  const steps = (await f.client.get(id, { depth: 'full', outputBudget: 'unbounded', outputLimit: 'unbounded' }) as GetResult).item.plan_steps!;
  await f.client.plan('update-step', id, { stepOwner: 'worker' }, steps[0].id);
  return { id, steps, worker: progress(f, 'worker'), reviewer: progress(f, 'reviewer'), lead: progress(f, 'lead') };
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
  assert.equal((await p.lead.view(p.id)).counts.accepted, 1, 'tracker configuration supplies the orchestrator without a caller hint');
  assert.equal((await p.lead.view(p.id, { orchestrator: 'lead' })).counts.accepted, 1);
  await assert.rejects(p.lead.view(p.id, { orchestrator: 'worker' }), { code: 'progress_role' });
  await assert.rejects(p.lead.view(p.id, { orchestrator: 'reviewer' }), { code: 'progress_role' });
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
  f.env.PM_AUTHOR = 'worker';
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
await new PlanProgress({ cwd: process.cwd(), pmRoot: process.env.PM_PATH, author: process.env.WITNESS_AUTHOR }).witness(process.env.PLAN_ID, JSON.parse(process.env.DECLARATION));`;
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

/** Complete one real core step before testing recorded-author approval boundaries. */
async function produced(f: Awaited<ReturnType<typeof sharedFixture>>) {
  const p = await plan(f); const step = p.steps[0].id;
  await f.client.plan('complete-step', p.id, { stepEvidence: 'Recorded-author regression artifact' }, step);
  const view = await p.worker.view(p.id);
  return { ...p, step, revision: view.revision };
}

test('recorded authors refuse the exact CLI agent and orchestrator spoofing sequence', async t => {
  const f = await sharedFixture(t); const p = await produced(f); f.env.PM_AUTHOR = 'worker';
  f.run('swarm', 'settings', '--progress-orchestrator', 'coordinator', '--apply');
  const revision = (await p.worker.view(p.id)).revision;
  const history = join(f.pmRoot, 'history', `${p.id}.jsonl`); const before = readFileSync(history, 'utf8');
  for (const [agent, stage] of [['reviewer', 'reviewed'], ['coordinator', 'accepted']]) {
    const refused = f.cli('swarm', 'progress', p.id, '--agent', agent, '--orchestrator', 'coordinator', '--stage', stage, '--step', p.step, '--revision', revision, '--evidence', 'Spoofed declaration', '--apply', '--json');
    assert.equal(refused.status, 2, refused.stdout + refused.stderr); assert.match(refused.stdout + refused.stderr, /progress_role/); assert.match(refused.stdout + refused.stderr, /SDK-recorded author/);
  }
  assert.equal(readFileSync(history, 'utf8'), before);
  assert.equal((await p.worker.view(p.id)).counts.accepted, 0);
});

test('a recorded worker cannot accept its own witness by borrowing the configured principal flag', async t => {
  const f = await sharedFixture(t); const p = await produced(f);
  await p.reviewer.witness(p.id, declaration(p.step, p.revision, 'reviewed'));
  const before = readFileSync(join(f.pmRoot, 'history', `${p.id}.jsonl`), 'utf8');
  await assert.rejects(p.worker.witness(p.id, { ...declaration(p.step, p.revision, 'accepted'), agent: 'lead' }), { code: 'progress_role' });
  await assert.rejects(p.worker.witness(p.id, declaration(p.step, p.revision, 'accepted')), { code: 'progress_role' });
  assert.equal(readFileSync(join(f.pmRoot, 'history', `${p.id}.jsonl`), 'utf8'), before);
  assert.equal((await p.worker.view(p.id)).counts.accepted, 0);
});

test('a recorded non-configured principal cannot appoint itself as orchestrator', async t => {
  const f = await sharedFixture(t); const p = await produced(f);
  await p.reviewer.witness(p.id, declaration(p.step, p.revision, 'reviewed'));
  const outsider = progress(f, 'outsider');
  await assert.rejects(outsider.witness(p.id, { ...declaration(p.step, p.revision, 'accepted'), orchestrator: 'outsider' }), { code: 'progress_role' });
  await assert.rejects(outsider.witness(p.id, declaration(p.step, p.revision, 'accepted')), { code: 'progress_role' });
  assert.equal((await outsider.view(p.id)).counts.accepted, 0);
});

test('three distinct SDK-recorded authors approve using tracker configuration and history attribution', async t => {
  const f = await sharedFixture(t); const p = await produced(f);
  await p.worker.witness(p.id, { ...declaration(p.step, p.revision, 'produced'), orchestrator: undefined });
  await p.reviewer.witness(p.id, { ...declaration(p.step, p.revision, 'reviewed'), orchestrator: undefined });
  const receipt = await p.lead.witness(p.id, { ...declaration(p.step, p.revision, 'accepted'), orchestrator: undefined });
  assert.equal(receipt.actor, 'lead');
  const view = await p.lead.view(p.id); assert.equal(view.orchestrator, 'lead'); assert.equal(view.counts.accepted, 1);
  const comments = (await f.client.get(p.id, { depth: 'full' })).item.comments!.filter(row => row.text.startsWith(PROGRESS_PREFIX));
  assert.deepEqual(comments.map(row => row.author), ['worker', 'reviewer', 'lead']);
  const history = readFileSync(join(f.pmRoot, 'history', `${p.id}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { author: string });
  assert.deepEqual(history.slice(-3).map(row => row.author), ['worker', 'reviewer', 'lead']);
  f.run('swarm', 'settings', '--progress-orchestrator', 'successor', '--apply');
  assert.equal((await p.lead.view(p.id)).counts.accepted, 0, 'authority changes invalidate acceptance');
});

test('unconfigured authority and legacy flag-authored witnesses fail closed; SDK environment author stays recorded', async t => {
  const f = await sharedFixture(t); const p = await produced(f);
  await f.client.comments(p.id, { add: 'swarm-progress/v1 ' + JSON.stringify(declaration(p.step, p.revision, 'accepted')), author: 'lead' });
  assert.equal((await p.lead.view(p.id)).counts.accepted, 0);
  const path = join(f.pmRoot, 'settings.json'); const settings = JSON.parse(readFileSync(path, 'utf8')) as { swarm: { progress_orchestrator?: unknown } };
  delete settings.swarm.progress_orchestrator; writeFileSync(path, JSON.stringify(settings));
  const bare = new PlanProgress({ pmRoot: f.pmRoot, author: 'lead' }); const view = await bare.view(p.id); assert.equal(view.orchestrator, null);
  await assert.rejects(bare.witness(p.id, { ...declaration(p.step, view.revision, 'accepted'), orchestrator: undefined }), { code: 'progress_role' });
  for (const invalid of ['', 7, 'bad\nname', 'bad\0name']) {
    settings.swarm.progress_orchestrator = invalid; writeFileSync(path, JSON.stringify(settings));
    await assert.rejects(bare.view(p.id), { code: 'progress_invalid' });
  }
  settings.swarm.progress_orchestrator = 'lead'; writeFileSync(path, JSON.stringify(settings));
  process.env.PM_PATH = f.pmRoot; process.env.PM_AUTHOR = 'worker';
  const environment = new PlanProgress();
  const current = await environment.view(p.id);
  await environment.witness(p.id, declaration(p.step, current.revision, 'produced'));
  assert.equal((await f.client.get(p.id, { depth: 'full' })).item.comments!.at(-1)!.author, 'worker');
});

test('the configured orchestrator cannot accept a review recorded under its own author', async t => {
  const f = await sharedFixture(t); const p = await produced(f);
  f.run('swarm', 'settings', '--progress-orchestrator', 'reviewer', '--apply');
  const revision = (await p.worker.view(p.id)).revision;
  await p.reviewer.witness(p.id, { ...declaration(p.step, revision, 'reviewed'), orchestrator: undefined });
  await assert.rejects(p.reviewer.witness(p.id, { ...declaration(p.step, revision, 'accepted'), orchestrator: undefined }), { code: 'progress_role' });
  assert.equal((await p.reviewer.view(p.id)).counts.accepted, 0);
});
