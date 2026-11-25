import assert from 'node:assert/strict';
import { test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { getHistoryPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { Capacities, SharedTracker, Swarm, interruptLane } from '../index.ts';
import { capacityAction, capacityOrder, CAPACITY_FIELD } from '../src/capacity.ts';
import { buildContinuation } from '../src/continuation.ts';
import { interruptions, INTERRUPTION_FIELD } from '../src/interruption.ts';
import { readItemHistoryHead } from '../src/settings.ts';
import { fixture } from './helpers.ts';
import { fixtureGit as git } from './git-helpers.ts';
import { declareService } from './privacy-mutations.ts';
import { sharedFixture } from './shared-helpers.ts';

/** One open policy window with a configured unknown-forecast allowance. */
async function enable(capacities: Capacities, name: string) {
  await capacities.run(name, { action: 'declare', limit: 100, unit: 'percent', window: '7d', resetsAt: new Date(Date.now() + 3_600_000).toISOString() });
  await capacities.run(name, { action: 'policy', else: 2 });
}

test('declarations and admission reject corrupt, duplicate and undeclared capacity records', async t => {
  const f = await sharedFixture(t);
  const capacities = new Capacities(f.shared.engine);
  const id = await f.item(['src/lane.ts']);
  for (const capacity of ['missing', 'missing,fallback']) {
    await assert.rejects(f.shared.start(id, {}, true, capacity), error => {
      assert.equal((error as { code: string }).code, 'capacity_undeclared');
      assert.match(String(error), capacity.includes(',') ? /--capacity fallback/ : /capacity --help/);
      return true;
    });
  }
  await assert.rejects(capacities.run('missing', { action: 'observe', used: 1, source: 'manual' }), /capacity_undeclared/);
  assert.equal((await f.client.get(id)).item.assignee, undefined);
  await enable(capacities, 'runner');
  const record = (await f.shared.engine.corpus()).items.find(item => item.tags.includes('swarm-capacity'))!;
  const stored = (await f.client.get(record.id, { depth: 'full' })).item[CAPACITY_FIELD] as string;
  const state = JSON.parse(stored) as Record<string, unknown>;
  for (const patch of [
    { name: 'foreign' }, { limit: '100' }, { limit: 0 }, { unit: ' percent' },
    { window: 0 }, { window: 400 * 86_400_000 }, { window: 8.5 },
    { resets_at: String(state.resets_at).replace('.000Z', '+00:00').replace(/\.\d{3}Z$/, 'Z') },
    { observations: false }, { observations: [null, null, null] },
    { observations: [{ at: '2000-01-01T00:00:00Z', source: 'manual', used: 0 }] },
    { observations: [{ at: state.resets_at, source: 'manual', used: 0 }] },
    { observations: [{ at: new Date(Date.now() - 1_000).toISOString(), source: 'manual', used: '1' }] },
  ]) {
    await f.client.update(record.id, { field: [CAPACITY_FIELD + '=' + JSON.stringify({ ...state, ...patch })] });
    await assert.rejects(capacities.run('runner'), /Inspect the native history/);
  }
  await f.client.update(record.id, { unset: [CAPACITY_FIELD] });
  await assert.rejects(capacities.run('runner'), /Inspect the native history/);
  await f.client.update(record.id, { field: [CAPACITY_FIELD + '=' + stored] });
  const duplicate = (await f.client.create({ type: 'Task', title: 'Duplicate fixture', addTags: ['swarm-capacity'], field: [CAPACITY_FIELD + '=' + stored] })).item.id;
  await assert.rejects(capacities.run('runner'), /duplicate native records/);
  await f.client.update(duplicate, { field: [CAPACITY_FIELD + '={'] });
  assert.equal((await capacities.run('runner')).admitted_lane_count, 2);
  await f.client.update(duplicate, { field: [CAPACITY_FIELD + '=null'] });
  assert.equal((await capacities.run('runner')).admitted_lane_count, 2);
  await f.client.update(duplicate, { unset: [CAPACITY_FIELD] });
  assert.equal((await capacities.run('runner')).admitted_lane_count, 2);
  declareService(f);
  await assert.rejects(capacities.run('runner'), /local tracker with shared SDK writer fencing/);
});

test('capacity options distinguish missing values and enforce explicit command combinations', () => {
  for (const options of [
    { action: 5 }, { action: 'constructor' }, { action: 'declare' }, { action: 'declare', unit: 'units', limit: 1, window: false },
    { action: 'observe', used: 1, source: 'manual', at: false },
    { action: 'observe', used: 1, source: 'manual', at: '2026-99-99T00:00:00Z' },
    { action: 'policy', band: Array(33).fill('forecast<10=1') }, { action: 'policy', band: [false] },
    { action: 'status', used: 1 },
  ]) assert.throws(() => capacityAction(options, Date.now()), /capacity_invalid/);
  assert.throws(() => capacityOrder('same,SAME'), /distinct/);
  assert.throws(() => capacityOrder(Array.from({ length: 17 }, (_, index) => 'capacity-' + index).join(',')), /up to 16/);
  assert.deepEqual(capacityAction({ action: 'policy', band: 'forecast<10=2', agent: 'worker', unused: undefined }, Date.now()), { action: 'policy', policy: { bands: ['forecast<10=2'], otherwise: 0 } });
});

test('handoff reception binds capacity once, with a write-free preview and a fenced stopped receipt', async t => {
  const f = await sharedFixture(t);
  const engine = f.shared.engine;
  const capacities = new Capacities(engine);
  await enable(capacities, 'runner');
  await enable(capacities, 'another');
  const id = await f.item(['src/receiver.ts']);
  const initial = await f.shared.start(id);
  const handoff = await f.shared.handoff(id, 'receiver', 'Continue here', initial.token);
  const receiver = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'receiver'));
  assert.equal((await receiver.next(undefined, true, undefined, 'runner')).capacity, 'runner');
  assert.equal((await capacities.run('runner')).active_lanes, 0);
  assert.equal((await receiver.next(undefined, false, undefined, 'runner')).token, handoff.token);
  assert.equal((await capacities.run('runner')).active_lanes, 1);
  const revision = (await readHistoryEntries(getHistoryPath(f.pmRoot, id), id)).length;
  assert.equal((await receiver.next(undefined, false, undefined, 'runner')).capacity, 'runner');
  assert.equal((await readHistoryEntries(getHistoryPath(f.pmRoot, id), id)).length, revision);
  await assert.rejects(interruptLane(receiver.engine, id, handoff.token, 'another', 'capacity_exhausted'), /active lane bound to this capacity/);
  await interruptLane(receiver.engine, id, handoff.token, 'runner', 'capacity_exhausted');
  await assert.rejects(receiver.next(), /capacity_exhausted/);
});

test('interrupt validates portable records, writer fences and the command shape', async t => {
  const f = await sharedFixture(t);
  const capacities = new Capacities(f.shared.engine);
  await enable(capacities, 'runner');
  const id = await f.item(['src/lane.ts']);
  const claim = await f.shared.start(id, {}, true, 'runner');
  for (const [token, reason] of [[undefined, 'capacity_exhausted'], ['bad', 'capacity_exhausted'], [claim.token, 'invalid']] as const) {
    await assert.rejects(interruptLane(f.shared.engine, id, token, 'runner', reason), /current decimal --token/);
  }
  for (const args of [
    ['interrupt', id, '--reason', 'capacity_exhausted', '--token', claim.token],
    ['interrupt', id, '--reason', 'capacity_exhausted', '--capacity', 'runner'],
    ['brief', id, '--continuation', '--token', claim.token],
    ['brief', id, '--to', 'receiver', '--token', claim.token],
    ['brief', id, '--capacity', 'runner', '--token', claim.token],
  ]) assert.equal(f.cli('swarm', ...args, '--json').status, 2);
  await assert.rejects(f.shared.continuation(id, '   ', claim.token), /different nonempty/);
  await assert.rejects(f.shared.continuation(id, 'shared-test', claim.token), /different nonempty/);
  const paused = await interruptLane(f.shared.engine, id, claim.token, 'runner', 'capacity_exhausted');
  const valid = paused.interruption;
  for (const invalid of [
    12, 'null', JSON.stringify([{ ...valid, capacity: 'Other' }]),
    ...[{ agent: 1 }, { agent: '' }, { agent: 'ghp_' + 'A1'.repeat(18) }, { token: false }, { token: 'bad' },
      { reason: 'other' }, { at: 'now' }, { at: false }, { resets_at: '2026-11-30' }, { at: valid.resets_at },
      { forecast: -1 }, { used: '4' }].map(patch => JSON.stringify([{ ...valid, ...patch }])),
  ]) assert.throws(() => interruptions({ [INTERRUPTION_FIELD]: invalid }), /Inspect the native interruption history/);
  assert.deepEqual(interruptions({ [INTERRUPTION_FIELD]: JSON.stringify([{ ...valid, used: 3, forecast: 9 }]) }), [{ ...valid, used: 3, forecast: 9 }]);
});

test('Git capacity next preserves previews and continuation can retain an unmounted branch', async t => {
  const f = await fixture(t);
  const capacities = new Capacities(f.swarm);
  await enable(capacities, 'runner');
  const id = await f.item(['src/git.ts']);
  const flags = { base: 'main', root: 'worktree lanes', branch_prefix: 'capacity/' };
  await assert.rejects(f.swarm.start(id, flags, true, 'missing,runner'), /--strict --base main --root 'worktree lanes' --branch-prefix 'capacity\/'/);
  await f.client.update(id, { field: ['swarm_token=malformed'] });
  await assert.rejects(f.swarm.start(id, {}, true, 'runner'), /Inspect malformed native lane generation/);
  await f.client.update(id, { unset: ['swarm_token'] });
  assert.equal((await f.swarm.next(undefined, true, undefined, 'runner')).capacity, 'runner');
  const lane = await f.swarm.next(undefined, false, undefined, 'runner');
  assert.equal(lane.id, id);
  const head = await readItemHistoryHead(f.pmRoot, id);
  await f.client.update(id, { comment: ['New peer context'] });
  const item = (await f.client.get(id, { depth: 'full' })).item;
  await assert.rejects(buildContinuation(f.swarm, item, 'receiver', '2', 800, 'runner', head), /Native history advanced/);
  git(f.repo, ['worktree', 'remove', lane.worktree!]);
  const packet = await new SharedTracker(f.swarm).continuation(id, 'receiver', lane.token);
  assert.equal(packet.git_worktree_available, false);
  assert.equal(packet.capacity, 'runner');
});

test('renewed claims retain their provider and a fresh unbound claim clears the old binding', async t => {
  const f = await sharedFixture(t);
  const capacities = new Capacities(f.shared.engine);
  await enable(capacities, 'runner');
  const id = await f.item(['src/retry.ts']);
  await f.shared.start(id, {}, true, 'runner');
  assert.equal((await f.shared.start(id)).capacity, 'runner');
  await f.client.release(id);
  assert.equal((await f.shared.start(id)).capacity, undefined);
  assert.equal((await capacities.run('runner')).active_lanes, 0);
});

test('an expired window, terminal lane and invalid author cannot publish an interruption', async t => {
  const f = await sharedFixture(t);
  const endedAt = new Date(Date.now() - 1_000).toISOString();
  const previous = Date.parse(endedAt) - 10_000;
  const historical = new Capacities(f.shared.engine, () => previous);
  await historical.run('ended', { action: 'declare', limit: 100, unit: 'percent', window: '7d', resetsAt: endedAt });
  await enable(new Capacities(f.shared.engine), 'runner');
  const id = await f.item(['src/clock.ts']);
  const { token } = await f.shared.start(id, {}, true, 'runner');
  await f.client.update(id, { field: ['swarm_capacity=ended'] });
  await assert.rejects(interruptLane(f.shared.engine, id, token, 'ended', 'capacity_exhausted'), /active lane bound/);

  // Status is sampled just before reset. The interruption timestamp is sampled after it.
  const clock = t.mock.method(Date, 'now', () => Date.parse(endedAt) - 1);
  try {
    await assert.rejects(interruptLane(f.shared.engine, id, token, 'ended', 'capacity_exhausted'), /window has ended/);
  } finally { clock.mock.restore(); }
  assert.equal((await f.client.get(id, { depth: 'full' })).item[INTERRUPTION_FIELD], undefined);
  const invalid = new Swarm(f.repo, f.pmRoot, f.client, 'ghp_' + 'A1'.repeat(18));
  await assert.rejects(interruptLane(invalid, id, token, 'ended', 'capacity_exhausted'), /public agent identity/);
  await f.client.update(id, { status: 'canceled', field: ['swarm_capacity=runner'] });
  await f.client.claim(id, { force: true });
  await assert.rejects(interruptLane(f.shared.engine, id, token, 'runner', 'capacity_exhausted'), /active lane/);
  await assert.rejects(f.shared.continuation(id, 'receiver', token), /active work item/);
});

test('continuation refuses a real Git ref advancement between its read and packet', async t => {
  const f = await fixture(t);
  const id = await f.item(['src/race.ts']);
  const base = git(f.repo, ['rev-parse', 'HEAD']);
  const lane = await f.swarm.start(id);
  f.write('src/race.ts', 'committed\n', lane.worktree);
  const tip = f.save(['src/race.ts'], lane.worktree);
  const spawn = childProcess.spawnSync;
  let advanced = false;
  const change = t.mock.method(childProcess, 'spawnSync', (...args: Parameters<typeof childProcess.spawnSync>) => {
    const result = Reflect.apply(spawn, childProcess, args);
    const command = args[1];
    if (!advanced && args[0] === 'git' && Array.isArray(command) && command[0] === '--no-optional-locks') {
      advanced = true;
      const moved = spawn('git', ['update-ref', 'refs/heads/' + lane.branch, tip, base], { cwd: f.repo, timeout: 300000 });
      assert.equal(moved.status, 0, moved.stderr?.toString());
    }
    return result;
  });
  git(f.repo, ['update-ref', 'refs/heads/' + lane.branch, base, tip]);
  syncBuiltinESMExports();
  try {
    await assert.rejects(new SharedTracker(f.swarm).continuation(id, 'receiver'), /lane branch advanced/);
  } finally { change.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(advanced, true);
  assert.equal((await f.client.get(id)).item.assignee, f.swarm.author);
});

test('a native assignment with no swarm claim and absent Git provenance is handled explicitly', async t => {
  const f = await sharedFixture(t);
  const id = await f.item(['src/provenance.ts']);
  await f.client.update(id, { assignee: 'shared-test' });
  await assert.rejects(f.shared.continuation(id, 'receiver'), /Inspect the native claim history/);
  const claim = await f.shared.start(id);
  await f.client.update(id, { field: ['swarm_branch=work/imported', 'swarm_base=' + 'a'.repeat(40)] });
  const packet = await f.shared.continuation(id, 'receiver', claim.token);
  assert.equal(packet.git_worktree_available, false);
  assert.equal(packet.context.commits, undefined);
});

test('rollover retains history and changes the policy when its units change', async t => {
  const f = await sharedFixture(t);
  const at = Date.parse('2026-11-25T08:00:00Z'); let now = at;
  const capacity = new Capacities(f.shared.engine, () => now);
  const resetsAt = new Date(at + 1_000).toISOString();
  await capacity.run('meter', { action: 'declare', unit: 'percent', window: '1h', limit: 100, resetsAt });
  await capacity.run('meter', { action: 'policy', else: 2 });
  await capacity.run('meter', { action: 'observe', used: 50, source: 'manual', at: new Date(at - 500).toISOString() });
  await capacity.run('meter', { action: 'observe', used: 80, source: 'manual' });
  now = at - 250;
  assert.equal((await capacity.run('meter')).forecast, null);
  now = at + 1_001;
  await assert.rejects(capacity.run('meter', { action: 'observe', used: 80, source: 'manual', at: new Date(at).toISOString() }), /active window/);
  await assert.rejects(capacity.run('meter', { action: 'observe', used: 80, source: 'manual', at: resetsAt }), /active window/);
  const newWindow = await capacity.run('meter', { action: 'declare', unit: 'requests', window: '7d', limit: 100, resetsAt: new Date(now + 10_000).toISOString() });
  assert.equal(newWindow.admitted_lane_count, 0);
  const { items } = await f.shared.engine.corpus();
  const capacityId = items.find(({ tags }) => tags.includes('swarm-capacity'))!.id;
  const history = await readHistoryEntries(getHistoryPath(f.pmRoot, capacityId), capacityId);
  assert.equal(history.length, 5);
  const result = await f.client.get(capacityId, { depth: 'full' });
  const raw = JSON.parse(String(result.item[CAPACITY_FIELD])) as Record<string, unknown>;
  delete raw.policy;
  await f.client.update(capacityId, { field: [CAPACITY_FIELD + '=' + JSON.stringify(raw)] });
  assert.equal((await capacity.run('meter')).admitted_lane_count, 0);
});

test('capacity refusal quotes a receiver identity while preserving the parent and recommended fallback', async t => {
  const f = await sharedFixture(t);
  const invalid = new Capacities(new Swarm(f.repo, f.pmRoot, f.client, 'ghp_' + 'A1'.repeat(18)));
  await assert.rejects(invalid.run('runner'), /public operator identity/);
  const parent = (await f.client.create({ type: 'Epic', title: 'Public parent' })).item.id;
  const id = await f.item(['src/parent.ts']);
  await f.client.update(id, { parent });
  const quoted = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, "worker's team"));
  await assert.rejects(quoted.next(parent, true, undefined, 'missing,runner'), error => {
    const details = (error as { details: Record<string, string> }).details;
    assert.equal(details.next_command, 'pm swarm next --parent ' + parent + " --dry-run --agent 'worker'\\''s team' --capacity runner");
    return true;
  });
});

test('empty evidence and native capacity records preserve their separate command boundaries', async t => {
  const f = await sharedFixture(t);
  await enable(new Capacities(f.shared.engine), 'runner');
  const { items } = await f.shared.engine.corpus();
  const capacity = items.find(item => item.tags.includes('swarm-capacity'))!;
  await assert.rejects(f.shared.sync(capacity.id, false, ['src/public.ts']), /Capacity records require/);
  await assert.rejects(f.shared.heartbeat(capacity.id), /Capacity records require/);
  await assert.rejects(f.shared.close(capacity.id, 'Public context'), /Capacity records require/);
  const resource = (await f.client.create({ type: 'Task', title: 'Public resource', addTags: ['swarm-resource'] })).item.id;
  await assert.rejects(f.shared.start(resource), /Resource items require/);
  const task = (await f.client.create({ type: 'Task', title: 'Empty evidence lane' })).item.id;
  const claim = await f.shared.start(task);
  const packet = await f.shared.continuation(task, 'receiver', claim.token);
  assert.equal(packet.context.activity, undefined);
});
