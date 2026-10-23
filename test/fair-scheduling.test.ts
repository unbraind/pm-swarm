import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FairPolicy, SchedulingRefusal } from '../src/fair-scheduling.ts';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { sharedFixture } from './shared-helpers.ts';
import { fixture } from './helpers.ts';
import { processExit } from './process-helpers.ts';

const NOW = '2026-10-23T12:00:00.000Z';

test('aging promotes low priority work over fresh arrivals and handoff cost without changing conflicts or readiness', async t => {
  const f = await sharedFixture(t);
  const old = await f.item(['docs/old'], 4, 'old'); const fresh = await f.item(['docs/new'], 0, 'new');
  await f.client.update(old, { tags: 'skill:ts', field: ['swarm_preferred_agent=previous', 'swarm_handoff_cost=99'] });
  // Schedule against a future clock so this real tracker naturally crosses the age threshold.
  const created = String((await f.client.get(old, { depth: 'full' })).item.created_at);
  const now = new Date(Date.parse(created) + 500).toISOString();
  assert.equal((await f.shared.schedule({ skills: ['ts'], now, maxWaitSeconds: 1, dryRun: true })).selected, fresh);
  const aged = await f.shared.schedule({ skills: ['ts'], now: new Date(Date.parse(created) + 2000).toISOString(), maxWaitSeconds: 1, dryRun: true });
  assert.equal(aged.selected, old); assert.match(aged.reason, /Starvation promotion/); assert.equal(aged.counts.starved, 2);
  assert.equal(aged.decisions.find(row => row.id === old)!.handoff_cost, 99);
  const active = await f.item(['docs']); await f.client.claim(active, { author: 'foreign' });
  const conflict = await f.shared.schedule({ skills: ['ts'], now: new Date(Date.parse(created) + 3000).toISOString(), maxWaitSeconds: 1, dryRun: true });
  assert.equal(conflict.selected, null); assert.equal(conflict.counts.conflicts, 2);
  await f.client.update(old, { blockedBy: active });
  assert.equal((await f.shared.schedule({ skills: ['ts'], dryRun: true })).counts.ready, 1);
});

test('real CLI skills, continuity costs, compact rows and dry-run history are honored without Git', async t => {
  const f = await sharedFixture(t);
  const a = await f.item(['a'], 2, 'a'); const b = await f.item(['b'], 2, 'b'); const c = await f.item(['c'], 2, 'c');
  await f.client.update(a, { tags: 'skill:ts,skill:sql', field: ['swarm_preferred_agent=other', 'swarm_handoff_cost=10'] });
  await f.client.update(b, { tags: 'skill:ts', field: ['swarm_preferred_agent=shared-test', 'swarm_handoff_cost=50'] });
  await f.client.update(c, { tags: 'skill:python' });
  const path = join(f.pmRoot, 'history', `${b}.jsonl`); const before = readFileSync(path, 'utf8');
  const preview = f.run('swarm', 'schedule', '--skills', 'ts,sql', '--dry-run', '--limit', '1') as { selected: string; decisions: unknown[]; omitted: number; counts: { ready: number; qualified: number } };
  assert.equal(preview.selected, b); assert.equal(preview.decisions.length, 1); assert.equal(preview.omitted, 2);
  assert.deepEqual(preview.counts, { ready: 3, qualified: 2, conflicts: 0, starved: 0 }); assert.equal(readFileSync(path, 'utf8'), before);
  assert.match(f.cli('swarm', 'schedule', '--skills', 'ts', '--dry-run').stdout, /selected:/);
  const claimed = f.run('swarm', 'schedule', '--skills', 'ts'); assert.equal(claimed.selected, b); assert.equal(claimed.token, '1');
  const missing = await f.shared.schedule({ skills: [], dryRun: true }); assert.equal(missing.selected, null); assert.equal(missing.counts.qualified, 0);
  assert.equal(f.cli('swarm', 'schedule', '--max-wait', '0', '--json').status, 2);
  const invalid = f.cli('swarm', 'schedule', '--skills', 'bad!', '--json'); assert.match(invalid.stdout + invalid.stderr, /schedule_invalid/);
  assert.equal(f.cli('swarm', 'schedule', '--limit', '101').status, 2);
});

test('equal input and reversed corpus order give the same explained selection; unknown fallbacks remain explicit', () => {
  const candidates = ['b', 'a'].map(id => ({ id, files: [id], dependencies: [], priority: 2, created_at: NOW }));
  const items = candidates.map(row => ({ id: row.id, tags: [] }));
  const run = (reverse: boolean, maxWaitSeconds = 1) => {
    const policy = new FairPolicy('worker', { skills: [], now: NOW, maxWaitSeconds });
    return policy.select(reverse ? [...candidates].reverse() : [...candidates], [], reverse ? [...items].reverse() : items);
  };
  assert.deepEqual(run(false), run(true)); assert.equal(run(false).chosen!.item.id, 'a');
  const older = { ...candidates[0], id: 'older', created_at: '2026-10-22T12:00:00.000Z' };
  for (const ordered of [[older, candidates[1]], [candidates[1], older]]) {
    const ages = new FairPolicy('worker', { skills: [], now: NOW, maxWaitSeconds: 60 });
    assert.equal(ages.select(ordered, [], [...items, { id: older.id, tags: [] }]).chosen!.item.id, older.id);
  }
  const policy = new FairPolicy('worker', { skills: [], now: '2026-10-24', maxWaitSeconds: 1 });
  assert.equal(policy.select(candidates, [], items).chosen!.item.id, 'a');
  const unknown = { ...candidates[0], id: 'unknown', files: [] };
  assert.equal(policy.select([unknown, ...candidates], [], [...items, { id: unknown.id, tags: [] }]).chosen!.item.id, 'a');
  const fallback = policy.select([unknown], [], [{ id: unknown.id, tags: [] }]); assert.equal(fallback.unknown, true); assert.match(fallback.reason, /Unknown footprint scheduled alone/);
  assert.equal(policy.select([], [], []).chosen, undefined);
});

test('invalid policy inputs and metadata produce typed refusals with remedies', async t => {
  const f = await sharedFixture(t); const id = await f.item(['code']);
  for (const options of [ { skills: ['bad!'] }, { skills: Array.from({ length: 65 }, () => 'ts') }, { skills: [], maxWaitSeconds: 1.5 }, { skills: [], maxWaitSeconds: 31536001 }, { skills: [], limit: 0 }, { skills: [], now: 'invalid' } ]) {
    await assert.rejects(f.shared.schedule(options), error => error instanceof SchedulingRefusal && error.code === 'schedule_invalid' && error.remedy.length > 0);
  }
  for (const fields of [['swarm_handoff_cost=no'], ['swarm_handoff_cost=1000001'], ['swarm_handoff_cost=1', 'swarm_preferred_agent= ']]) {
    await f.client.update(id, { field: fields }); await assert.rejects(f.shared.schedule({ skills: [] }), SchedulingRefusal);
  }
  await f.client.update(id, { unset: ['swarm_preferred_agent', 'swarm_handoff_cost'], tags: 'skill:bad!' });
  await assert.rejects(f.shared.schedule({ skills: [] }), /Repair skill tags/);
  // Pure policy guards also cover malformed imported metadata without rewriting real history.
  const policy = new FairPolicy('worker', { skills: [], now: NOW });
  const candidate = { id: 'bad', files: ['bad'], dependencies: [], priority: 2, created_at: 'invalid' };
  assert.throws(() => policy.select([candidate], [], [{ id: 'bad', tags: [] }]), /creation timestamp/);
  assert.throws(() => policy.handoff({ id: 'bad', tags: Array.from({ length: 65 }, () => 'skill:ts') }), SchedulingRefusal);
  assert.throws(() => policy.handoff({ id: 'bad', tags: [], swarm_handoff_cost: 2 }), SchedulingRefusal);
  assert.throws(() => policy.handoff({ id: 'bad', tags: [], swarm_preferred_agent: 2 }), SchedulingRefusal);
  assert.throws(() => policy.handoff({ id: 'bad', tags: [], swarm_preferred_agent: 'x'.repeat(129) }), SchedulingRefusal);
});

test('explicit handoffs keep their context and fence and refuse an unqualified receiver', async t => {
  const f = await sharedFixture(t); const id = await f.item(['code']); await f.client.update(id, { tags: 'skill:ts' });
  const start = await f.shared.start(id); await f.shared.handoff(id, 'receiver', 'Inspect linked work', start.token);
  const receiver = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'receiver'));
  await assert.rejects(receiver.schedule({ skills: [] }), error => error instanceof SchedulingRefusal && error.code === 'schedule_skills');
  const preview = await receiver.schedule({ skills: ['ts'], dryRun: true }); assert.equal(preview.selected, id); assert.equal(preview.context!.note, 'Inspect linked work');
  const result = await receiver.schedule({ skills: ['ts'] }); assert.equal(result.token, '2'); assert.equal(result.reason, 'Assigned handoff');
  await receiver.close(id, 'Verified', result.token);
});

test('concurrent real process selectors cannot double-claim, including ordinary next', { timeout: 120000 }, async t => {
  const f = await sharedFixture(t); const ids = [await f.item(['a']), await f.item(['b']), await f.item(['c'])];
  const children = ['schedule', 'schedule', 'next'].map((command, index) => {
    const child = spawn(process.execPath, [f.host, 'swarm', command, '--agent', `worker-${index}`, '--json'], { cwd: f.repo, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.on('data', data => { stdout += String(data); }); child.stderr.on('data', data => { stderr += String(data); });
    return { child, output: () => ({ stdout, stderr }) };
  });
  const exits = await Promise.all(children.map(row => processExit(row.child, 'close')));
  for (const [index, exit] of exits.entries()) assert.equal(exit[0], 0, children[index].output().stderr);
  const selected = children.map(row => (JSON.parse(row.output().stdout) as { selected: string }).selected);
  assert.deepEqual(selected.sort(), ids.sort());
  for (const id of ids) {
    const events = readFileSync(join(f.pmRoot, 'history', `${id}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { patch: { path: string }[] });
    assert.equal(events.filter(row => row.patch.some(patch => patch.path === '/metadata/assignee')).length, 1);
  }
});

test('Git scheduling uses the same measured lane conflict checks and SDK ownership path', async t => {
  const f = await fixture(t); f.write('code.txt', 'base\n'); f.write('docs.txt', 'base\n');
  const active = await f.item(['code.txt']); const safe = await f.item(['docs.txt']); const blocked = await f.item(['code.txt']); f.save();
  await f.swarm.start(active);
  const preview = await f.swarm.schedule({ skills: [], dryRun: true }); assert.equal(preview.selected, safe); assert.equal(preview.counts.conflicts, 1);
  const result = await f.swarm.schedule({ skills: [] }); assert.equal(result.selected, safe); assert.ok(result.worktree); assert.ok(result.branch);
  assert.equal((await f.client.get(blocked)).claim_state?.claimed, false);
});


test('starved unknown work runs alone when safe and service storage refuses local coordination', async t => {
  const f = await sharedFixture(t); const unknown = await f.item([], 4, 'old'); const known = await f.item(['known'], 0, 'new');
  const created = String((await f.client.get(known, { depth: 'full' })).item.created_at);
  const result = await f.shared.schedule({ skills: [], now: new Date(Date.parse(created) + 10000).toISOString(), maxWaitSeconds: 1, dryRun: true });
  assert.equal(result.selected, unknown); assert.match(result.reason, /Unknown footprint/);
  await f.client.claim(known, { author: 'other' });
  assert.equal((await f.shared.schedule({ skills: [], dryRun: true })).selected, null);
  const manifest = join(f.pmRoot, 'extensions/pm-swarm/manifest.json');
  for (const capabilities of [['services'], [], undefined]) {
    writeFileSync(manifest, JSON.stringify({ name: 'pm-swarm', version: '2026.10.15', entry: 'entry.js', capabilities }));
    await assert.rejects(f.shared.schedule({ skills: [] }), error => error instanceof SchedulingRefusal && error.code === 'schedule_backend_refused');
  }
});
