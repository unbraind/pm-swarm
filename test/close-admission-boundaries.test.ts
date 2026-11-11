import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLOSE_INTENT, inspectCloseMember } from '../src/close-journal.ts';
import type { CloseJournal } from '../src/close-journal.ts';
import { loadCloseProposals } from '../src/close-proofs.ts';
import { readItemHistoryHead } from '../src/settings.ts';
import { appendCopiedClosePhase, assertRefusedClosePreserves, closeBytes, closeProcess, recoveryFixture, signedNativeCompletion } from './close-recovery-helpers.ts';
import { blockedDependent } from './close-native-helpers.ts';

test('a valid journal copied from another native target cannot return its saved success', async t => {
  for (const generation of ['same', 'newer']) await t.test(generation, async child => {
    const { f, id, token } = await recoveryFixture(child, 0); const other = await f.item(); const held = await f.shared.start(other);
    await f.shared.close(other, 'Same public completion', held.token);
    const foreign = String((await f.client.get(other)).item[CLOSE_INTENT]);
    const selected = generation === 'newer' ? String(BigInt(token) + 1n) : token;
    await f.client.update(id, { field: [`${CLOSE_INTENT}=${foreign}`, `swarm_token=${selected}`] }); const before = closeBytes(f, [id, other]);
    await assert.rejects(f.shared.close(id, 'Same public completion', selected), { code: 'swarm_close_recovery_unsupported' });
    assert.deepEqual(closeBytes(f, [id, other]), before);
  });
});

test('a frozen affected list cannot invent an untouched related member', async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1); const blocker = await f.item(); const candidate = await blockedDependent(f, id);
  await f.client.update(candidate, { dep: [`id=${blocker},kind=blocked_by`] });
  assert.equal(closeProcess(f, id, token, { kill: { boundary: 'before_commit' } }).signal, 'SIGKILL');
  const journal = JSON.parse(String((await f.client.get(id)).item[CLOSE_INTENT])) as CloseJournal;
  const post = await Promise.all(ids.map(async member => ({ id: member, head: await readItemHistoryHead(f.pmRoot, member) })));
  const frozen: CloseJournal = { ...journal, phase: 'compensating', proofs: await loadCloseProposals(f.shared.engine, journal), post };
  const member = journal.members.find(member => member.id === candidate)!;
  assert.equal((await inspectCloseMember(f.shared.engine, frozen, member)).changed, false);
  const forged = { ...frozen, post: [...post, { id: candidate, head: member.head }] };
  await appendCopiedClosePhase(f, forged);
  assertRefusedClosePreserves(f, id, token, [...ids, candidate]);
});

test('a signed native completion still requires exact ownership cleanup and generation advance', async t => {
  for (const kind of ['handoff', 'claim timestamp', 'token']) await t.test(kind, async child => {
    const { f, id, token, ids } = await recoveryFixture(child, 1);
    const completed = await signedNativeCompletion(f, id, token, ids);
    const field = [`swarm_token=${kind === 'token' ? token : BigInt(token) + 1n}`, ...(kind === 'handoff' ? ['swarm_handoff=Retained public transfer'] : [])];
    const unset = ['swarm_handoff', 'swarm_claimed_at'].filter(name => !(kind === 'handoff' && name === 'swarm_handoff' || kind === 'claim timestamp' && name === 'swarm_claimed_at'));
    await appendCopiedClosePhase(f, completed, { field, unset }); const before = closeBytes(f, ids);
    assert.equal(closeProcess(f, id, token).outcome?.code, 'swarm_compensation_partial');
    assert.deepEqual(closeBytes(f, ids), before);
  });
});
