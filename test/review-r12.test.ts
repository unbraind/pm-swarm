import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, readSettings } from '@unbrained/pm-cli/sdk';
import { heartbeatPath, leaseLocality, processStart, readRuntime, recoverLeasePin, StaleFenceError, swarmRuntime, withSwarmLease } from '../src/lease.ts';
import { recoverySnapshotMatches } from '../src/recovery.ts';
import { fixture } from './helpers.ts';
import { sharedFixture } from './shared-helpers.ts';

for (const action of ['publication and reap', 'rollback'] as const) {
  test(`Git checkout slower than the default lease permits ${action}`, { timeout: 240000 }, async t => {
    const f = await fixture(t); const id = await f.item(); f.save();
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim(); assert.ok(realGit);
    const bin = join(f.root, 'slow-bin'); mkdirSync(bin);
    const log = join(f.root, 'slow-operations');
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nimport { appendFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nif (args[0] === 'worktree' && ['add', 'remove'].includes(args[1])) {\n  const before = Date.now(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 31000);\n  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ operation: args[1], elapsed: Date.now() - before }) + '\\n');\n}\nconst result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });\nprocess.exit(result.status ?? 1);\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const root = '../lanes'; const path = join(f.repo, root, `repo-${id}`);
    if (action === 'rollback') {
      mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'keep'), 'Unrelated fixture');
      await assert.rejects(f.swarm.start(id, { root }), /git worktree failed/);
      assert.equal((await f.client.get(id)).claim_state?.claimed, false, 'failed checkout releases its claim');
      assert.equal(readFileSync(join(path, 'keep'), 'utf8'), 'Unrelated fixture');
    } else {
      const lane = await f.swarm.start(id);
      assert.equal(existsSync(lane.worktree), true);
      assert.equal((await f.client.get(id, { depth: 'full' })).item.swarm_branch, lane.branch);
      await f.client.update(id, { status: 'closed', message: 'Fixture complete' }); await f.client.claim(id, { force: true });
      const result = await f.swarm.reap(); assert.deepEqual(result.released, [id]);
      assert.equal((await f.client.get(id)).claim_state?.claimed, false);
      assert.equal(existsSync(lane.worktree), false);
    }
    const operations = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { operation: string; elapsed: number });
    assert.deepEqual(operations.map(row => row.operation), action === 'rollback' ? ['add'] : ['add', 'remove']);
    assert.ok(operations.every(row => row.elapsed >= 30000), 'real subprocess duration exceeds the unchanged default lease');
  });
}

for (const changed of ['operation', 'pin', 'missing pin'] as const) {
  test(`blocking Git policy still fences a superseded ${changed} generation`, async t => {
    const f = await sharedFixture(t);
    await withSwarmLease(f.pmRoot, 'git-worker', async lease => {
      const path = join(swarmRuntime(f.pmRoot), changed !== 'operation' ? 'operation-pin.json' : 'operation.json');
      const owner = readRuntime<Record<string, unknown>>(path)!;
      if (changed === 'missing pin') rmSync(path);
      else writeFileSync(path, JSON.stringify({ ...owner, token: 'successor' }));
      await assert.rejects(lease.write(() => f.client.create({ type: 'Task', title: 'Forbidden write' })), StaleFenceError);
    }, { allowBlocking: true });
    const retained = join(swarmRuntime(f.pmRoot), changed !== 'operation' ? 'operation-pin.json' : 'operation.json');
    assert.equal(readRuntime<{ token: string }>(retained)?.token, changed === 'missing pin' ? undefined : 'successor');
    rmSync(retained, { force: true });
  });
}

test('reclaim defaults to swarm work, scopes direct parents, previews without writes and preserves workflow states', async t => {
  const f = await sharedFixture(t); const old = '2000-01-01T00:00:00.000Z';
  const parent = (await f.client.create({ type: 'Feature', title: 'Scope' })).item.id;
  const other = (await f.client.create({ type: 'Feature', title: 'Other scope' })).item.id;
  const prefs = await readSettings(f.pmRoot);
  writeFileSync(join(f.pmRoot, 'schema/statuses.json'), JSON.stringify([...prefs.schema.statuses, { id: 'in_review', roles: ['active'] }]));
  const rows = [];
  for (const kind of ['eligible', 'other parent', 'human', 'blocked', 'draft', 'in_review'] as const) {
    const id = await f.item([kind]);
    await f.client.update(id, { parent: kind === 'other parent' ? other : parent, assignee: 'absent-worker',
      ...(kind === 'blocked' || kind === 'draft' || kind === 'in_review' ? { status: kind } : {}),
      ...(kind === 'human' ? {} : { field: [`swarm_claimed_at=${old}`, 'swarm_token=1'] }) });
    // A real SDK assignment without swarm markers can also have old liveness evidence.
    writeFileSync(heartbeatPath(f.pmRoot, 'absent-worker'), JSON.stringify({ heartbeat: old }));
    rows.push({ kind, id, history: readFileSync(join(f.pmRoot, 'history', `${id}.jsonl`), 'utf8') });
  }
  const heartbeat = heartbeatPath(f.pmRoot, 'shared-test'); rmSync(heartbeat, { force: true });
  const preview = f.run('swarm', 'reclaim', '--stale-after', '0.001', '--parent', parent, '--dry-run') as { dry_run: boolean; recovered: { id: string }[]; refused: { id: string }[] };
  assert.equal(preview.dry_run, true); assert.deepEqual(preview.recovered.map(row => row.id), [rows[0].id]);
  assert.deepEqual(preview.refused.map(row => row.id).sort(), [rows[3].id, rows[4].id, rows[5].id].sort());
  assert.equal(existsSync(heartbeat), false, 'preview cannot create or refresh the invoking heartbeat');
  for (const row of rows) assert.equal(readFileSync(join(f.pmRoot, 'history', `${row.id}.jsonl`), 'utf8'), row.history);
  const applied = f.run('swarm', 'reclaim', '--stale-after', '0.001', '--parent', parent) as { dry_run: boolean; recovered: { id: string }[] };
  assert.equal(applied.dry_run, false); assert.deepEqual(applied.recovered.map(row => row.id), [rows[0].id]);
  for (const row of rows.slice(1)) assert.equal(readFileSync(join(f.pmRoot, 'history', `${row.id}.jsonl`), 'utf8'), row.history);
});

for (const successor of ['new generation', 'different dead generation', 'same generation now live', 'already removed'] as const) {
  test(`two recovery contenders preserve a pin that is ${successor}`, async t => {
    const f = await sharedFixture(t); const root = swarmRuntime(f.pmRoot); const pin = join(root, 'operation-pin.json');
    const locality = leaseLocality(); assert.ok(locality, 'recovery regression needs verified Linux locality');
    const abandoned = { pid: 2147483647, locality, token: 'dead-generation', heartbeat: 0 };
    writeFileSync(pin, JSON.stringify(abandoned));
    const candidate = join(f.repo, 'successor.json');
    const current = { pid: successor === 'different dead generation' ? 2147483647 : process.pid, process_start: processStart(process.pid), locality, token: successor === 'same generation now live' ? abandoned.token : 'live-successor', heartbeat: Date.now() };
    writeFileSync(candidate, JSON.stringify(current));
    const release = await acquireLock(f.pmRoot, 'swarm-recovery', 30, 'barrier');
    const unlink = fs.unlinkSync; let removals = 0;
    const observation = t.mock.method(fs, 'unlinkSync', (path: fs.PathLike) => {
      unlink(path);
      if (String(path) === pin && ++removals === 1 && successor !== 'already removed') linkSync(candidate, pin);
    });
    syncBuiltinESMExports(); t.after(() => { observation.mock.restore(); syncBuiltinESMExports(); });
    // Both rescuers retain the same old observation while a real SDK lock blocks recovery.
    const contenders = [recoverLeasePin(f.pmRoot, 'rescuer-one', locality, abandoned), recoverLeasePin(f.pmRoot, 'rescuer-two', locality, abandoned)];
    await release(); await Promise.all(contenders);
    assert.equal(removals, 1, 'only one rescuer can unlink the observed abandoned generation');
    assert.deepEqual(readRuntime(pin), successor === 'already removed' ? undefined : current);
  });
}

test('README distinguishes blocking Git pins and scoped reclaim previews', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /Synchronous Git subprocesses block those timers/);
  assert.match(readme, /Shared-tracker mode also enforces the heartbeat expiry check/);
  assert.match(readme, /--parent project-id --dry-run/);
  assert.match(readme, /ordinary human and SDK assignments are preserved/);
});

test('recovery snapshot rejects a changed parent even at an identical item revision', () => {
  const item = { parent: 'scope-one', updated_at: 'same-revision', assignee: 'worker', status: 'open' };
  assert.equal(recoverySnapshotMatches(item, { ...item }), true);
  assert.equal(recoverySnapshotMatches(item, { ...item, parent: 'scope-two' }), false);
});

test('reclaim recognizes branch-only legacy swarm ownership without adopting ordinary SDK claims', async t => {
  const f = await sharedFixture(t); const id = await f.item();
  await f.client.update(id, { assignee: 'idle-lane-owner', field: ['swarm_branch=swarm/legacy'] });
  await delay(5);
  const result = await f.shared.reclaim(0.001, 'receiver');
  assert.deepEqual(result.recovered.map(row => row.id), [id]);
  assert.equal(result.recovered[0].token, '1');
  const item = (await f.client.get(id, { depth: 'full' })).item;
  assert.equal(item.assignee, 'receiver'); assert.equal(item.swarm_branch, 'swarm/legacy');
});
