import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import type { SpawnSyncOptions } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { branchExists } from '../src/git.ts';
import { readRuntime, StaleFenceError } from '../src/lease.ts';
import { fixture } from './helpers.ts';
import { monitorLeaseHolder, processExit } from './process-helpers.ts';

/** Supersede disposable lease evidence without substituting SDK responses. */
function supersede(pmRoot: string) {
  const path = join(pmRoot, 'runtime/swarm/operation.json');
  const owner = readRuntime<Record<string, unknown>>(path)!;
  writeFileSync(path, JSON.stringify({ ...owner, token: 'superseding-operation' }));
}

/** Observe real synchronous Git completion and supersede the operation at a selected boundary. */
function supersedeAfterGit(t: TestContext, pmRoot: string, matches: (args: string[], status: number | null) => boolean) {
  const original = childProcess.spawnSync;
  const observation = t.mock.method(childProcess, 'spawnSync', (command: string, args: string[], options: SpawnSyncOptions) => {
    const result = original(command, args, options);
    if (command === 'git' && matches(args, result.status)) supersede(pmRoot);
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { observation.mock.restore(); syncBuiltinESMExports(); });
}

for (const action of ['start', 'next'] as const) {
  test(`Git ${action} refuses a superseded lease before claiming`, async t => {
    const f = await fixture(t); const id = await f.item(['src/work']); f.save();
    const history = join(f.pmRoot, 'history', `${id}.jsonl`); const before = readFileSync(history, 'utf8');
    const get = f.client.get.bind(f.client);
    f.client.get = async (...args) => {
      const result = await get(...args);
      if (args[1]?.fields === 'id,assignee,claim_state') supersede(f.pmRoot);
      return result;
    };
    await assert.rejects(action === 'start' ? f.swarm.start(id) : f.swarm.next(), StaleFenceError);
    assert.equal(readFileSync(history, 'utf8'), before);
    assert.equal(branchExists(f.repo, `swarm/${id}`), false);
    assert.equal((await get(id)).claim_state?.claimed, false);
  });
}

for (const phase of ['publication', 'rollback'] as const) {
  test(`Git lane ${phase} never writes through a superseded lease`, async t => {
    const f = await fixture(t); const id = await f.item(); f.save();
    const root = '../lanes'; const path = join(f.repo, root, `repo-${id}`);
    if (phase === 'rollback') { mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'keep'), 'Unrelated data'); }
    supersedeAfterGit(t, f.pmRoot, (args, status) => phase === 'publication'
      ? args[0] === 'config' && args[2] === `swarm.lane.${id}` && status === 0
      : args[0] === 'worktree' && args[1] === 'add' && status !== 0);
    const history = join(f.pmRoot, 'history', `${id}.jsonl`); const before = readFileSync(history, 'utf8').trim().split('\n').length;
    await assert.rejects(f.swarm.start(id, { root }), StaleFenceError);
    const item = (await f.client.get(id, { depth: 'full' })).item;
    assert.equal(item.assignee, 'swarm-test', 'a superseded operation cannot release even its own prior claim');
    assert.equal(item.swarm_branch, undefined);
    assert.equal(readFileSync(history, 'utf8').trim().split('\n').length, before + 1, 'only the valid initial claim persisted');
    assert.equal(branchExists(f.repo, `swarm/${id}`), true, 'superseded leases preserve Git resources for the current owner');
    if (phase === 'publication') assert.equal(existsSync(path), true);
    else assert.equal(readFileSync(join(path, 'keep'), 'utf8'), 'Unrelated data');
  });
}

test('Git reap rechecks its lease after synchronous cleanup before releasing the claim', async t => {
  const f = await fixture(t); const id = await f.item();
  const history = join(f.pmRoot, 'history', `${id}.jsonl`);
  f.save(); const lane = await f.swarm.start(id);
  await f.client.update(id, { status: 'closed', message: 'Fixture complete' }); await f.client.claim(id, { force: true });
  const before = readFileSync(history, 'utf8');
  supersedeAfterGit(t, f.pmRoot, args => args[0] === 'branch' && args[1] === '-d');
  await assert.rejects(f.swarm.reap(), StaleFenceError);
  assert.equal(readFileSync(history, 'utf8'), before);
  assert.equal((await f.client.get(id)).claim_state?.assignee, 'swarm-test');
  assert.equal(branchExists(f.repo, lane.branch), false, 'completed Git cleanup is retained');
});

for (const scenario of ['early failure', 'early clean exit', 'spawn error', 'ready'] as const) {
  test(`lease-holder readiness settles on ${scenario}`, { timeout: 10000 }, async t => {
    const child = spawn(scenario === 'spawn error' ? 'swarm-test-missing-executable' : process.execPath,
      ['-e', scenario === 'ready' ? "process.stdout.write('ready'); setInterval(() => {}, 1000)" : `process.exit(${scenario === 'early failure' ? 7 : 0})`]);
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); });
    const holder = monitorLeaseHolder(child);
    if (scenario === 'ready') {
      const [data] = await holder.ready; assert.equal(String(data), 'ready');
      child.kill('SIGKILL'); assert.deepEqual(await holder.exit, [null, 'SIGKILL']);
    } else {
      await closed; await turn(); // Consume barriers late to expose unhandled spawn rejections.
      await assert.rejects(Promise.race([holder.ready, Promise.resolve('readiness remained pending')]), /child exited before lease held|ENOENT/);
      if (scenario === 'spawn error') await assert.rejects(holder.exit, { code: 'ENOENT' });
      else assert.deepEqual(await holder.exit, [scenario === 'early failure' ? 7 : 0, null]);
    }
    assert.equal(child.stdout.listenerCount('data'), 0, 'readiness listeners are removed on every outcome');
  });
}

for (const event of ['close', 'exit'] as const) {
  test(`deferred ${event} consumers retain spawn failures without unhandled rejections`, async () => {
    const child = spawn('swarm-test-missing-executable');
    const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); });
    const exit = processExit(child, event);
    await closed; await turn();
    await assert.rejects(exit, { code: 'ENOENT' });
  });
}
