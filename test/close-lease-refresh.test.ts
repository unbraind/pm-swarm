import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { getHistoryPath, readHistoryEntries, runWithAgentSessionContext } from '@unbrained/pm-cli/sdk';
import { CLOSE_INTENT, closeEpisode } from '../src/close-journal.ts';
import { withSwarmLease } from '../src/lease.ts';
import type { Lease } from '../src/lease.ts';
import { compensateClose } from '../src/close-recovery.ts';
import { sharedFixture } from './shared-helpers.ts';
import { appendCopiedClosePhase, closeBytes, pendingClose, signedNativeCompletion } from './close-recovery-helpers.ts';

/** Wait for admission to finish and the requested number of real operation waiters to queue. */
async function queued(pmRoot: string, count = 1): Promise<void> {
  const until = Date.now() + 30000;
  while (readdirSync(join(pmRoot, 'runtime/swarm')).filter(name => name.startsWith('request-')).length !== count) {
    assert.ok(Date.now() < until, 'close calls must reach the held operation lease');
    await delay(10);
  }
}

test('a waiting applying-journal retry replays a peer committed receipt without compensation', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const { token } = await f.shared.start(id);
  const completed = await signedNativeCompletion(f, id, token, [id]);
  let retry: ReturnType<typeof f.shared.close> | undefined; let saved: ReturnType<typeof closeBytes> | undefined;
  await withSwarmLease(f.pmRoot, 'shared-test', async () => {
    retry = f.shared.close(id, completed.note, token); retry.catch(() => undefined);
    await queued(f.pmRoot);
    await appendCopiedClosePhase(f, completed, { field: [`swarm_token=${BigInt(token) + 1n}`], unset: ['swarm_handoff', 'swarm_claimed_at'] });
    saved = closeBytes(f, [id]);
  });
  assert.deepEqual(await retry, { id, closed: true });
  assert.deepEqual(closeBytes(f, [id]), saved, 'replay must append no compensation or duplicate close');
});

test('two fresh queued closes replay the first completion instead of using a stale admission', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const { token } = await f.shared.start(id);
  const attempts: ReturnType<typeof f.shared.close>[] = [];
  await withSwarmLease(f.pmRoot, 'shared-test', async () => {
    attempts.push(f.shared.close(id, 'Queued completion', token)); attempts[0].catch(() => undefined);
    await queued(f.pmRoot);
    attempts.push(f.shared.close(id, 'Queued completion', token)); attempts[1].catch(() => undefined);
    await queued(f.pmRoot, 2);
  });
  assert.deepEqual(await Promise.all(attempts), [{ id, closed: true }, { id, closed: true }]);
  const saved = closeBytes(f, [id]);
  assert.equal((await readHistoryEntries(getHistoryPath(f.pmRoot, id), id)).filter(entry => entry.op === 'close').length, 1);
  assert.deepEqual(await f.shared.close(id, 'Queued completion', token), { id, closed: true });
  assert.deepEqual(closeBytes(f, [id]), saved);
});

/** Advance a peer while admission waits, then require the exact refusal and unchanged peer bytes. */
async function refuseAfterPeer(f: Awaited<ReturnType<typeof sharedFixture>>, id: string, note: string, token: string, code: string, advance: (lease: Lease) => Promise<void>, ids = [id]): Promise<void> {
  let retry: Promise<unknown> | undefined; let saved: ReturnType<typeof closeBytes> | undefined;
  await withSwarmLease(f.pmRoot, 'shared-test', async lease => {
    retry = assert.rejects(f.shared.close(id, note, token), { code }); retry.catch(() => undefined);
    await queued(f.pmRoot); await advance(lease); saved = closeBytes(f, ids);
  });
  await retry;
  assert.deepEqual(closeBytes(f, ids), saved, 'replay or refusal must append no writes after peer progress');
}

test('a waiting retry replays completed compensation without appending recovery history', async t => {
  const { f, id, token, journal, ids } = await pendingClose(t);
  await refuseAfterPeer(f, id, journal.note, token, 'swarm_close_compensated', async lease => {
    await assert.rejects(compensateClose(f.shared.engine, lease, journal), { code: 'swarm_close_compensated' });
  }, ids);
});

for (const field of ['id', 'author', 'note', 'token'] as const) test(`a waiting retry revalidates the journal ${field}`, async t => {
  const { f, id, token, journal } = await pendingClose(t, 0);
  await refuseAfterPeer(f, id, journal.note, token, 'swarm_close_recovery_unsupported', async () => {
    const changed = field === 'id' ? { ...journal, id: 'shared-test-foreign', members: [{ ...journal.members[0], id: 'shared-test-foreign' }] } : { ...journal, [field]: field === 'token' ? String(BigInt(token) + 1n) : 'Independent peer request' };
    await runWithAgentSessionContext({ episode: { id: closeEpisode(changed, 'journal', changed) } }, () => f.client.update(id, { force: true, field: [`${CLOSE_INTENT}=${JSON.stringify(changed)}`] }));
  });
});

test('a fresh waiting close rechecks the current fencing generation', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const { token } = await f.shared.start(id);
  await refuseAfterPeer(f, id, 'Queued completion', token, 'swarm_stale_fence', async () => {
    await f.client.update(id, { field: [`swarm_token=${BigInt(token) + 1n}`] });
  });
});
