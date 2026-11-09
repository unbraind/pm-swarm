import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CLOSE_INTENT } from '../src/close-journal.ts';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { assertCompensated, closeBytes, closeOutcomeRow, closeProcess } from './close-recovery-helpers.ts';
import { sharedFixture } from './shared-helpers.ts';

for (const transfer of ['handoff', 'reclaim']) test(`real processes close received ${transfer} work with a durable receipt and reject the prior owner`, async t => {
  const f = await sharedFixture(t); const id = await f.item(['src/public.ts']);
  const initial = f.run('swarm', 'start', id);
  let token: string;
  if (transfer === 'handoff') token = String(f.run('swarm', 'handoff', id, '--token', String(initial.token), '--to', 'receiver', '--note', 'Public handoff').token);
  else {
    const old = new Date(Date.now() - 120000).toISOString();
    // A legacy claim has no heartbeat. Native writes age only disposable claim evidence.
    await f.client.release(id); await f.client.claim(id, { author: 'legacy-worker' });
    await f.client.update(id, { field: [`swarm_claimed_at=${old}`] });
    const moved = f.run('swarm', 'reclaim', '--stale-after', '60', '--to', 'receiver').recovered as { id: string; token: string }[];
    token = moved.find(row => row.id === id)!.token;
  }
  const stale = closeProcess(f, id, String(initial.token)); assert.notEqual(stale.status, 0); assert.equal(stale.outcome?.code, 'swarm_stale_fence', stale.stdout + stale.stderr);
  const received = closeProcess(f, id, token, { author: 'receiver' }); assert.equal(received.status, 0, received.stdout + received.stderr);
  const item = (await f.client.get(id, { depth: 'full' })).item;
  assert.deepEqual({ status: item.status, owner: item.assignee, generation: item.swarm_token }, { status: 'closed', owner: undefined, generation: String(BigInt(token) + 1n) });
  assert.equal(item.swarm_handoff, undefined); assert.equal(item.swarm_claimed_at, undefined);
  const journal = JSON.parse(String(item[CLOSE_INTENT])) as { phase: string; token: string };
  assert.equal(journal.phase, 'committed'); assert.equal(journal.token, token);
  assert.deepEqual(closeProcess(f, id, token, { author: 'receiver' }).outcome?.result, received.outcome?.result);
});

test('an interrupted close intent refuses reclaim, handoff and new claims until the original request reconciles it', { timeout: 180000 }, async t => {
  const f = await sharedFixture(t); const id = await f.item(['src/public.ts']);
  /** Invoke the real CLI as one named principal, exactly like the shared fixture runner. */
  const as = (author: string, ...args: string[]) => spawnSync(process.execPath, [f.host, ...args, '--json'], { cwd: f.repo, env: { ...f.env, PM_AUTHOR: author }, encoding: 'utf8', timeout: 300000 });
  const started = as('crash-worker', 'swarm', 'start', id, '--author', 'crash-worker');
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const token = String(JSON.parse(started.stdout).token);
  const before = closeBytes(f, [id]);
  // A real worker dies after the durable intent write and before native close, leaving a pending episode.
  const killed = closeProcess(f, id, token, { author: 'crash-worker', kill: { boundary: 'intent' } });
  assert.equal(killed.signal, 'SIGKILL', killed.stdout + killed.stderr);
  const pending = JSON.parse(String((await f.client.get(id, { depth: 'full' })).item[CLOSE_INTENT])) as { phase: string; author: string };
  assert.equal(pending.phase, 'applying'); assert.equal(pending.author, 'crash-worker');
  const stranded = closeBytes(f, [id]);
  await delay(1500);
  // Every ownership path refuses instead of transferring the stranded episode, in preview and in apply.
  for (const dry of [true, false]) {
    const preview = f.run('swarm', 'reclaim', '--stale-after', '1', '--to', 'receiver', ...(dry ? ['--dry-run'] : []));
    const refusal = (preview.refused as { id: string; code?: string; reason: string }[]).find(row => row.id === id);
    assert.ok(refusal, JSON.stringify(preview)); assert.equal(refusal.code, 'swarm_close_transfer_refused');
    assert.match(refusal.reason, /close intent/i);
  }
  const handoff = as('crash-worker', 'swarm', 'handoff', id, '--author', 'crash-worker', '--token', token, '--to', 'receiver', '--note', 'Public handoff');
  assert.notEqual(handoff.status, 0); assert.match(handoff.stdout + handoff.stderr, /swarm_close_transfer_refused/);
  await assert.rejects(f.shared.start(id), { code: 'swarm_close_transfer_refused' });
  // Refusals preserve every native byte; the item stays neither transferred nor compensated.
  assert.deepEqual(closeBytes(f, [id]), stranded);
  const stillPending = (await f.client.get(id, { depth: 'full' })).item;
  assert.equal(stillPending.assignee, 'crash-worker'); assert.equal(JSON.parse(String(stillPending[CLOSE_INTENT])).phase, 'applying');
  // The exact original request reconciles the episode: compensation restores the pre-close bytes.
  const reconciled = closeProcess(f, id, token, { author: 'crash-worker' });
  assert.equal(reconciled.outcome?.code, 'swarm_close_compensated', reconciled.stdout + reconciled.stderr);
  assertCompensated(f, [id], before);
  // With the episode settled, the same transfer succeeds and the new owner closes normally.
  const moved = f.run('swarm', 'reclaim', '--stale-after', '1', '--to', 'receiver').recovered as { id: string; token: string }[];
  const received = moved.find(row => row.id === id); assert.ok(received, JSON.stringify(moved));
  const closed = closeProcess(f, id, received.token, { author: 'receiver' });
  assert.equal(closed.status, 0, closed.stdout + closed.stderr);
  assert.equal((await f.client.get(id, { depth: 'full' })).item.status, 'closed');
});

test('the typed worker outcome is located by its code row, never by trailing output order', () => {
  const noise = [{ boundary: 'intent', id: 'public-item' }, { id: 'diagnostic-row' }];
  for (const lead of [0, 1, 2]) {
    const rows = [...noise.slice(0, lead), { code: 'swarm_stale_fence' }, ...noise];
    assert.equal(closeOutcomeRow(rows)?.code, 'swarm_stale_fence', JSON.stringify(rows));
  }
  assert.equal(closeOutcomeRow([{ id: 'lead' }, { code: 'first' }, { boundary: 'mid', id: 'public-item' }, { code: 'second' }])?.code, 'second');
  assert.deepEqual(closeOutcomeRow([{ result: { closed: true } }, { boundary: 'trailing', id: 'public-item' }])?.result, { closed: true });
  assert.equal(closeOutcomeRow([{ boundary: 'intent', id: 'public-item' }])?.boundary, 'intent');
  assert.equal(closeOutcomeRow([]), undefined);
});

test('a malformed close intent refuses ownership changes with the typed transfer refusal', async t => {
  const f = await sharedFixture(t); const id = await f.item();
  const peer = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'peer-worker'));
  const claim = await peer.start(id);
  await f.client.update(id, { force: true, field: [`${CLOSE_INTENT}=not a journal`] });
  const original = closeBytes(f, [id]);
  await assert.rejects(f.shared.start(id), { code: 'swarm_close_transfer_refused' });
  await assert.rejects(peer.handoff(id, 'receiver', 'Public handoff', claim.token), { code: 'swarm_close_transfer_refused' });
  await delay(1200);
  const refused = f.run('swarm', 'reclaim', '--stale-after', '1', '--to', 'receiver');
  const refusal = (refused.refused as { id: string; code?: string; reason: string }[]).find(row => row.id === id);
  assert.ok(refusal, JSON.stringify(refused)); assert.equal(refusal.code, 'swarm_close_transfer_refused');
  assert.deepEqual(closeBytes(f, [id]), original);
});
