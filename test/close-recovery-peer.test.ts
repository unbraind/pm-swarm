import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { CLOSE_INTENT, closeEpisode, withCloseObserver } from '../src/close-journal.ts';
import type { CloseJournal } from '../src/close-journal.ts';
import { CloseCompensation } from '../src/close-recovery.ts';
import { withItemMutationObserver } from '../src/settings.ts';
import { historyPeerProcess, peerBytes } from './history-aba-helpers.ts';
import { assertRefusedClosePreserves, closeBytes, closeProcess, recoveryFixture } from './close-recovery-helpers.ts';
import { blockedDependent } from './close-native-helpers.ts';

/** Keep a native dependency candidate blocked by an independent unresolved item. */
async function stillBlockedCandidate(f: Awaited<ReturnType<typeof recoveryFixture>>['f'], id: string): Promise<string> {
  const other = await f.item(); const candidate = await blockedDependent(f, id);
  await f.client.update(candidate, { dep: [`id=${other},kind=blocked_by`] }); return candidate;
}

/** Execute an independent native writer, optionally copying a public episode identifier or message. */
function copiedPeer(f: Awaited<ReturnType<typeof recoveryFixture>>['f'], id: string, episode: string) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `
import {PmClient,runWithAgentSessionContext} from '@unbrained/pm-cli/sdk';
const input=JSON.parse(process.argv[1]);const client=new PmClient({cwd:input.repo,pmRoot:input.pmRoot,author:'shared-test'});
await runWithAgentSessionContext({episode:{id:input.episode}},()=>client.update(input.id,{force:true,title:'Independent peer edit',message:'Swarm close compensation'}));
`, JSON.stringify({ repo: f.repo, pmRoot: f.pmRoot, id, episode })], { cwd: import.meta.dirname, env: f.env, encoding: 'utf8', timeout: 60000 });
}

test('an independent same-author native close cannot be adopted from a pending native-field intent', async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1);
  assert.equal(closeProcess(f, id, token, { kill: { boundary: 'before_close' } }).signal, 'SIGKILL');
  await f.client.close(id, 'Independent same-author completion');
  const before = closeBytes(f, ids);
  const retry = closeProcess(f, id, token);
  assert.equal(retry.outcome?.code, 'swarm_compensation_partial');
  assert.deepEqual(closeBytes(f, ids), before);
});

test('a copied global close episode on an untouched member cannot authorize its restoration', async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1); const unrelated = await stillBlockedCandidate(f, id);
  assert.equal(closeProcess(f, id, token, { kill: { boundary: 'before_commit' } }).signal, 'SIGKILL');
  const journal = JSON.parse(String((await f.client.get(id, { depth: 'full' })).item[CLOSE_INTENT])) as CloseJournal;
  const peer = copiedPeer(f, unrelated, closeEpisode(journal, 'close', id)); assert.equal(peer.status, 0, peer.stdout + peer.stderr);
  const bytes = closeBytes(f, [...ids, unrelated]);
  assert.equal(closeProcess(f, id, token).outcome?.code, 'swarm_compensation_partial');
  assert.deepEqual(closeBytes(f, [...ids, unrelated]), bytes);
});

for (const count of [1, 2, 3]) test(`peer ABA at every restore decision preserves foreign bytes with ${count} dependents`, { timeout: 900000 }, async t => {
  for (let target = 0; target <= count; target++) await t.test(`member ${target}`, async child => {
    const { f, id, token, ids } = await recoveryFixture(child, count);
    assert.equal(closeProcess(f, id, token, { kill: { boundary: 'before_commit' } }).signal, 'SIGKILL');
    let observed = false; let foreign: string[] = [];
    await assert.rejects(withCloseObserver((boundary, member) => {
      if (boundary !== 'before_restore' || member !== ids[target]) return;
      const peer = historyPeerProcess(f.repo, f.pmRoot, 'shared-test', member);
      assert.equal(peer.status, 0, peer.stdout + peer.stderr); foreign = peerBytes(f.pmRoot, member); observed = true;
    }, () => f.shared.close(id, 'Public native completion', token)), error => error instanceof CloseCompensation && error.code === 'swarm_compensation_partial' && error.pending.includes(ids[target]));
    assert.equal(observed, true); assert.deepEqual(peerBytes(f.pmRoot, ids[target]), foreign);
    const stable = closeBytes(f, ids);
    assert.equal(closeProcess(f, id, token).outcome?.code, 'swarm_compensation_partial');
    assert.deepEqual(closeBytes(f, ids), stable, 'a refused recovery must preserve all item and audit bytes');
  });
});

for (const gap of ['restored', 'recorded']) test(`a peer between restores at ${gap} is preserved even with copied identity and message`, async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 2);
  const baseline = closeProcess(f, id, token, { kill: { boundary: 'before_commit' } }); assert.equal(baseline.signal, 'SIGKILL');
  const journal = JSON.parse(String((await f.client.get(id, { depth: 'full' })).item[CLOSE_INTENT])) as CloseJournal;
  let foreign: string[] = []; let injected = false;
  await assert.rejects(withCloseObserver((boundary, member) => {
    if (injected || boundary !== gap || member === id) return;
    injected = true;
    // The native close episode is public audit data. Copying it cannot certify a later update.
    const native = JSON.parse(peerBytes(f.pmRoot, ids[1])[1].trim().split('\n').at(-1)!) as { agent_episode: { id: string } };
    const peer = copiedPeer(f, ids[1], native.agent_episode.id);
    assert.equal(peer.status, 0, peer.stdout + peer.stderr); foreign = peerBytes(f.pmRoot, ids[1]);
  }, () => f.shared.close(id, journal.note, token)), error => error instanceof CloseCompensation && error.code === 'swarm_compensation_partial' && error.pending.includes(ids[1]));
  assert.equal(injected, true); assert.deepEqual(peerBytes(f.pmRoot, ids[1]), foreign);
  assert.equal((await f.client.get(id)).item.status, 'closed', 'the blocker remains closed when dependency restoration is incomplete');
});

test('the final blocker restore excludes native peer writes to every restored dependent', async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 2);
  assert.equal(closeProcess(f, id, token, { kill: { boundary: 'before_commit' } }).signal, 'SIGKILL');
  let primary = false; let checked = false;
  const probes: { status: number | null; diagnostic: string; before: string[]; after: string[] }[] = [];
  const [attempt] = await Promise.allSettled([withCloseObserver((boundary, member) => { if (boundary === 'before_restore' && member === id) primary = true; }, () => withItemMutationObserver(boundary => {
    if (!primary || checked || boundary !== 'before_commit') return; checked = true;
    for (const dependent of ids.slice(1)) {
      const before = peerBytes(f.pmRoot, dependent);
      const peer = spawnSync(process.execPath, [f.host, 'update', dependent, '--description', 'Must wait for dependency fence', '--json'], { cwd: f.repo, env: { ...f.env, PM_LOCK_WAIT_MS: '0' }, encoding: 'utf8', timeout: 30000 });
      probes.push({ status: peer.status, diagnostic: peer.stdout + peer.stderr, before, after: peerBytes(f.pmRoot, dependent) });
    }
  }, () => f.shared.close(id, 'Public native completion', token)))]);
  assert.equal(checked, true);
  for (const probe of probes) { assert.equal(probe.status, 4, probe.diagnostic); assert.match(probe.diagnostic, /lock_conflict/); assert.deepEqual(probe.after, probe.before); }
  assert.equal(attempt.status, 'rejected'); if (attempt.status === 'rejected') assert.equal(Reflect.get(Object(attempt.reason), 'code'), 'swarm_close_compensated');
});


test('a peer edit to an untouched related candidate halts compensation without adopting its history', async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1); const candidate = await stillBlockedCandidate(f, id);
  assert.equal(closeProcess(f, id, token, { kill: { boundary: 'before_commit' } }).signal, 'SIGKILL');
  const peer = f.cli('update', candidate, '--description', 'Independent candidate progress', '--json'); assert.equal(peer.status, 0, peer.stdout + peer.stderr);
  assertRefusedClosePreserves(f, id, token, [...ids, candidate]);
});
