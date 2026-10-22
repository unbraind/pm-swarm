import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { StaleFenceError, withSwarmLease } from '../src/lease.ts';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { fixture, swarmCli } from './helpers.ts';
import { sharedFixture } from './shared-helpers.ts';

/** Publish a real Git lane with an existing linked footprint. */
async function gitLaneFixture(t: TestContext) {
  const f = await fixture(t); const id = await f.item(['existing']); f.save(); await f.swarm.start(id);
  return { ...f, id };
}

test('Git sync fences round-trip ownership, missing tokens, explicit no-ops and terminal writes', async t => {
  const f = await gitLaneFixture(t); const { id } = f;
  const shared = new SharedTracker(f.swarm); const first = await shared.start(id);
  await shared.handoff(id, 'receiver', 'Continue');
  const receiver = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'receiver'));
  await receiver.next(); const back = await receiver.handoff(id, 'swarm-test', 'Return');
  const history = join(f.pmRoot, 'history', `${id}.jsonl`); const before = readFileSync(history, 'utf8');
  for (const token of [first.token, undefined]) await assert.rejects(f.swarm.sync(id, true, ['bad'], token), StaleFenceError);
  await assert.rejects(f.swarm.sync(id, true, ['existing'], first.token), StaleFenceError);
  const refused = swarmCli(f, ['sync', id, '--apply', '--files', 'bad', '--token', first.token]);
  assert.equal(refused.status, 2); assert.match(refused.stdout + refused.stderr, /swarm_stale_fence/);
  assert.equal(readFileSync(history, 'utf8'), before);
  assert.deepEqual((await f.swarm.sync(id, false, ['preview'], first.token)).add, ['preview']);
  assert.deepEqual((await f.swarm.sync(id, true, ['new'], back.token)).add, ['new']);
  assert.deepEqual((await f.swarm.sync(id, true, ['new'], back.token)).add, []);
  await f.client.update(id, { status: 'closed', message: 'Fixture complete' });
  await f.client.claim(id, { force: true });
  const closed = readFileSync(history, 'utf8');
  await assert.rejects(f.swarm.sync(id, true, ['after-close'], back.token), /No active lane/);
  assert.equal(readFileSync(history, 'utf8'), closed);
});

for (const assignee of ['foreign-worker', '']) {
  test(`Git sync checks fresh ownership after lane discovery: ${assignee || 'unassigned'}`, async t => {
    const f = await gitLaneFixture(t); const { id } = f;
    const lanes = f.swarm.lanes.bind(f.swarm); let before = '';
    const history = join(f.pmRoot, 'history', `${id}.jsonl`);
    // Change real storage after the corpus snapshot; never replace SDK responses.
    f.swarm.lanes = async () => {
      const rows = await lanes();
      await f.client.update(id, assignee ? { assignee } : { unset: ['assignee'] });
      before = readFileSync(history, 'utf8'); return rows;
    };
    await assert.rejects(f.swarm.sync(id, true, ['bad']), assignee ? /Item claimed by foreign-worker/ : /Lane is unclaimed/);
    assert.equal(readFileSync(history, 'utf8'), before);
  });
}

test('Git sync pins discovery and the real SDK file write against handoff', async t => {
  const f = await gitLaneFixture(t); const { id } = f;
  const lanes = f.swarm.lanes.bind(f.swarm); const files = f.client.files.bind(f.client); let checks = 0;
  /** Probe the coordination boundary without substituting tracker data. */
  const pinned = async () => {
    await assert.rejects(withSwarmLease(f.pmRoot, 'rival', async () => {}, { waitMs: 0 }), /swarm_busy/); checks++;
  };
  f.swarm.lanes = async () => { await pinned(); return lanes(); };
  f.client.files = async (...args) => { await pinned(); return files(...args); };
  assert.deepEqual((await f.swarm.sync(id, true, ['new'])).add, ['new']);
  assert.equal(checks, 2);
  await withSwarmLease(f.pmRoot, 'rival', async lease => { lease.assert(); });
});

test('Git sync refuses a superseded operation before the SDK file mutation', async t => {
  const f = await gitLaneFixture(t); const { id } = f;
  const get = f.client.get.bind(f.client); const history = join(f.pmRoot, 'history', `${id}.jsonl`);
  const before = readFileSync(history, 'utf8');
  f.client.get = async (...args) => {
    const result = await get(...args);
    if (args[1]?.depth === 'full') {
      const path = join(f.pmRoot, 'runtime/swarm/operation.json');
      const owner = JSON.parse(readFileSync(path, 'utf8')) as { token: string };
      owner.token = 'superseding-operation'; writeFileSync(path, JSON.stringify(owner));
    }
    return result;
  };
  await assert.rejects(f.swarm.sync(id, true, ['bad']), StaleFenceError);
  assert.equal(readFileSync(history, 'utf8'), before);
});

for (const mode of ['shared', 'Git'] as const) {
  test(`${mode} CLI helper bounds a stalled subprocess`, async t => {
    const f = mode === 'shared' ? await sharedFixture(t) : await fixture(t);
    const spawnSync = childProcess.spawnSync;
    // Keep a real stalled subprocess, scaling only its timeout to avoid a five-minute test.
    const intercepted = t.mock.method(childProcess, 'spawnSync', (file: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => {
      assert.equal(file, process.execPath); assert.ok(args.includes(join(import.meta.dirname, '../node_modules/.bin/pm')));
      assert.equal(options.timeout, 300000);
      return spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...options, timeout: 25 });
    });
    syncBuiltinESMExports();
    try {
      const result = 'cli' in f ? f.cli('--version') : swarmCli(f, ['status']);
      assert.equal(result.status, null); assert.ok(result.error && 'code' in result.error); assert.equal(result.error.code, 'ETIMEDOUT');
      if ('run' in f) assert.throws(() => f.run('--version'), /ETIMEDOUT/);
    } finally { intercepted.mock.restore(); syncBuiltinESMExports(); }
  });
}

test('latency summary distinguishes the earlier pass from the later local timeout', () => {
  const item = readFileSync(new URL('../.agents/pm/chores/pm-swarm-packed-latency.toon', import.meta.url), 'utf8');
  const description = item.split('\n').find(line => line.startsWith('description:'))!;
  assert.match(description, /earlier.*passed.*599323 ms/i);
  assert.match(description, /later local review-round run exited 1.*packed Git test timed out/i);
  assert.match(description, /CI Node 22 and Node 26 pass/);
  assert.match(description, /Preserve all command assertions and coverage thresholds/);
  assert.match(description, /pm-swarm-packed-cleanup/);
});
