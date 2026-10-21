import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { locateItem, readLocatedItem } from '@unbrained/pm-cli/sdk';
import { heartbeatPath } from '../src/lease.ts';
import { sharedFixture } from './shared-helpers.ts';
import { monitorScaleWorker, verifyScaleHistories } from './scale-helpers.ts';

for (const action of ['handoff', 'reclaim'] as const) {
  test(`${action} transfers legacy claims with absent comments`, async t => {
    const f = await sharedFixture(t); const id = await f.item(['legacy']);
    await f.client.claim(id, { author: action === 'handoff' ? 'shared-test' : 'legacy-worker' });
    const located = await locateItem(f.pmRoot, id); assert.ok(located);
    assert.equal((await readLocatedItem(located)).document.metadata.comments, undefined, 'the durable record omits comments');
    assert.deepEqual((await f.client.get(id, { depth: 'full' })).item.comments, [], 'full SDK reads establish the comments-array invariant');
    const old = new Date(Date.now() - 120000).toISOString();
    await f.client.update(id, { field: [`swarm_claimed_at=${old}`] });
    const before = readFileSync(join(f.pmRoot, 'history', `${id}.jsonl`), 'utf8').trim().split('\n').length;
    const result = action === 'handoff' ? await f.shared.handoff(id, 'receiver', 'Continue legacy work') : (await f.shared.reclaim(60, 'receiver')).recovered[0];
    assert.equal(result.id, id); assert.equal(result.token, '1'); assert.deepEqual(result.context.comments, []);
    const item = (await f.client.get(id, { depth: 'full' })).item;
    assert.equal(item.assignee, 'receiver'); assert.equal(item.swarm_token, '1');
    assert.equal(item.comments?.at(-1)?.text, result.context.note);
    assert.equal(readFileSync(join(f.pmRoot, 'history', `${id}.jsonl`), 'utf8').trim().split('\n').length, before + 1);
  });
}

test('reclaim selects the newest parseable liveness evidence and reports unusable evidence without writes', async t => {
  const f = await sharedFixture(t); const old = new Date(Date.now() - 120000).toISOString(); const fresh = new Date().toISOString();
  const cases = [
    { recorded: 'invalid', observed: fresh, recover: false },
    { recorded: 'invalid', observed: old, recover: true },
    { recorded: 'invalid', observed: undefined, recover: false },
    { recorded: 'invalid', observed: 'invalid', recover: false },
    { recorded: old, observed: 'invalid', recover: true },
    { recorded: fresh, observed: old, recover: false },
    { recorded: old, observed: fresh, recover: false },
  ];
  const rows = [];
  for (const [index, scenario] of cases.entries()) {
    const id = await f.item([`case-${index}`]); const author = `worker-${index}`;
    await f.client.claim(id, { author });
    await f.client.update(id, { field: [`swarm_claimed_at=${scenario.recorded}`] });
    if (scenario.observed !== undefined) writeFileSync(heartbeatPath(f.pmRoot, author), JSON.stringify({ heartbeat: scenario.observed }));
    rows.push({ ...scenario, id, history: readFileSync(join(f.pmRoot, 'history', `${id}.jsonl`), 'utf8') });
  }
  const result = await f.shared.reclaim(60);
  assert.deepEqual(result.recovered.map(row => row.id).sort(), rows.filter(row => row.recover).map(row => row.id).sort());
  assert.deepEqual(result.refused.map(row => row.id).sort(), [rows[2].id, rows[3].id].sort());
  assert.ok(result.refused.every(row => /No valid claim or heartbeat timestamp/.test(row.reason)));
  for (const row of rows.filter(row => !row.recover)) assert.equal(readFileSync(join(f.pmRoot, 'history', `${row.id}.jsonl`), 'utf8'), row.history);
  const cli = f.run('swarm', 'reclaim', '--stale-after', '60') as { refused: { id: string }[] };
  assert.deepEqual(cli.refused.map(row => row.id).sort(), result.refused.map(row => row.id).sort());
});

test('status reports an unknown age for malformed claim timestamps', async t => {
  const f = await sharedFixture(t); const id = await f.item(['status']); await f.shared.start(id);
  await f.client.update(id, { field: ['swarm_claimed_at=invalid'] });
  assert.equal((await f.shared.status()).lanes[0].claim_age_seconds, null);
});

/** Require the barrier's own rejection before an exited worker can leave it pending. */
async function refusesBeforeExit(barrier: Promise<unknown>, exit: Promise<unknown>) {
  await assert.rejects(Promise.race([barrier, exit.catch(() => undefined)]), /exited unexpectedly|ENOENT|worker refused/);
}

for (const scenario of ['early failure', 'early clean exit', 'after ready', 'spawn error', 'reported failure', 'done before ready', 'completed', 'intentional kill'] as const) {
  test(`scale worker settles barriers on ${scenario}`, { timeout: 10000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'swarm-worker-regression-')); t.after(() => rmSync(root, { recursive: true, force: true }));
    const script = join(root, 'worker.mjs');
    const scripts = {
      'early failure': 'process.exit(7)',
      'early clean exit': 'process.exit(0)',
      'after ready': "process.send({event:'ready', id:'task', agent:'worker'}); process.exit(9)",
      'spawn error': '',
      'reported failure': "process.send({event:'failed', message:'worker refused'}); process.disconnect()",
      'done before ready': "process.send({event:'done', agent:'worker', completed:[]}); process.disconnect()",
      'completed': "process.send({event:'phase', agent:'worker', phase:'sync'}); process.send({event:'ready', id:'task', agent:'worker'}); process.send({event:'done', agent:'worker', completed:[]}); process.disconnect()",
      'intentional kill': "process.send({event:'ready', id:'task', agent:'worker'}); setInterval(()=>{}, 1000)",
    };
    writeFileSync(script, scripts[scenario]);
    const child = fork(script, [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], ...(scenario === 'spawn error' ? { execPath: join(root, 'missing-node') } : {}) });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const phases: string[] = []; const worker = monitorScaleWorker(child, (agent, phase) => phases.push(`${agent}:${phase}`));
    if (scenario === 'completed' || scenario === 'intentional kill') {
      assert.equal((await worker.ready).id, 'task');
      if (scenario === 'intentional kill') worker.killAfterReady();
      assert.deepEqual(await worker.done, []);
      const [code, signal] = await worker.exit;
      assert.deepEqual([code, signal], scenario === 'completed' ? [0, null] : [null, 'SIGKILL']);
      if (scenario === 'completed') assert.deepEqual(phases, ['worker:sync', 'worker:done']);
    } else if (scenario === 'done before ready') {
      await assert.rejects(worker.ready, /completed before barrier/); assert.deepEqual(await worker.done, []); await worker.exit;
    } else {
      if (scenario === 'after ready') await worker.ready;
      else await refusesBeforeExit(worker.ready, worker.exit);
      await refusesBeforeExit(worker.done, worker.exit);
      if (scenario === 'reported failure') await assert.rejects(worker.exit, /exited unexpectedly/);
      else await assert.rejects(worker.exit, /exited unexpectedly|ENOENT/);
    }
  });
}

test('scale history proof refuses a missing history in a real non-git tracker', async t => {
  const f = await sharedFixture(t); const id = await f.item();
  assert.equal(verifyScaleHistories(f.pmRoot, 2), 2);
  unlinkSync(join(f.pmRoot, 'history', `${id}.jsonl`));
  assert.throws(() => verifyScaleHistories(f.pmRoot, 2), /every task and the project must retain a history/);
});
