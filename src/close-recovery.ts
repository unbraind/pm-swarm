import { retainFailureCause } from './failure-cause.ts';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { acquireLockLease, indexBlockedByIds, deriveMutationTransactionId, runWithAgentSessionContext, validateWorkspaceTransactionIdentity } from '@unbrained/pm-cli/sdk';
import type { Swarm } from './swarm.ts';
import type { Lease } from './lease.ts';
import { commitItemMutation, commitMutation, SettingsRefusal } from './settings.ts';
import type { CloseInspection, CloseJournal, CloseMember } from './close-journal.ts';
import { CLOSE_INTENT, captureCloseMember, closeBoundary, closeEpisode, closePlanIdentity, discoverCloseJournal, inspectCloseMember, inspectCloseMembers, parseCloseJournal, syncCloseMember } from './close-journal.ts';
import { loadCloseProposals, recordCloseProposal, retireCloseProposals, signCloseResult, validCloseResult } from './close-proofs.ts';

/** Typed recovery outcome retains member-level progress without exposing documents or storage coordinates. */
export class CloseCompensation extends SettingsRefusal {
  /** Members whose exact original state has a certified native restore receipt. */
  readonly restored: string[];
  /** Members still needing restoration or explicit peer reconciliation. */
  readonly pending: string[];
  /** Distinguish complete rollback from a peer-preserving partial compensation. */
  constructor(restored: string[], pending: string[]) {
    super(pending.length === 0 ? 'swarm_close_compensated' : 'swarm_compensation_partial', pending.length === 0
      ? `The interrupted close was compensated. Restored members: ${restored.join(', ')}. Native audit history is retained; start a new claim generation before closing again.`
      : `Compensation stopped to preserve peer edits. Restored members: ${restored.join(', ') || 'none'}. Pending members: ${pending.join(', ')}. Inspect native history and reconcile the conflicting member before retrying.`, 'close');
    this.restored = restored; this.pending = pending;
  }
}
/** Persist progress through the bound SDK, guarded by the exact checked native revision. */
async function saveJournal(engine: Swarm, lease: Lease, journal: CloseJournal, primary: CloseInspection): Promise<void> {
  const completed = journal.phase === 'committed';
  const options = { author: engine.author, force: true, field: [`${CLOSE_INTENT}=${JSON.stringify(journal)}`, ...(completed && journal.token !== null ? [`swarm_token=${BigInt(journal.token) + 1n}`] : [])], ...(completed ? { unset: ['swarm_handoff', 'swarm_claimed_at'] } : {}), message: 'Swarm close recovery progress' };
  const boundary = journal.phase === 'applying' ? 'intent_native' : journal.phase === 'committed' ? 'commit_native' : journal.restored.length > 0 ? 'progress_native' : 'compensation_native';
  await lease.write(() => runWithAgentSessionContext({ episode: { id: closeEpisode(journal, 'journal', journal) } }, () => commitItemMutation({ id: journal.id, item: primary.item, options }, admitted => engine.client.update(admitted.id, admitted.options), { history: primary.history, onCommitted: () => closeBoundary(boundary, journal.id) })), { announce: false });
  await syncCloseMember(engine, journal.id);
}
/** Check every member before a recovery write; retain exact certified heads for the actual native lock. */
async function inspectDomain(engine: Swarm, journal: CloseJournal): Promise<Map<string, CloseInspection>> {
  const { states, pending, failures } = await inspectCloseMembers(engine, journal);
  if (pending.length > 0) {
    const outcome = new CloseCompensation([...states].filter(([, state]) => state.restored).map(([id]) => id), journal.members.filter(member => pending.includes(member.id) || states.get(member.id)?.changed && !states.get(member.id)?.restored).map(member => member.id));
    throw failures.length > 0 ? retainFailureCause(outcome, failures[0]) : outcome;
  }
  return states;
}
/** Sync every certified restoration before reporting a complete compensation receipt. */
async function completedCompensation(engine: Swarm, states: ReadonlyMap<string, CloseInspection>): Promise<never> {
  const restored = [...states].filter(([, state]) => state.restored).map(([id]) => id); const pending: string[] = [];
  for (const id of restored) { try { await syncCloseMember(engine, id); } catch { pending.push(id); } }
  throw new CloseCompensation(restored, pending);
}
/** A durable completion is irreversible even when confirming its return or current domain fails. */
function assertUncommittedClose(journal: CloseJournal): void {
  if (journal.phase === 'committed') throw new SettingsRefusal('swarm_partial_commit', `The close committed for item ${journal.id}, but its response or durability confirmation was unavailable. Retry the original request to verify and replay its native receipt.`, 'close');
}
/** Restore dependents first and the primary last; native restore receipts survive a lost progress write. */
async function restoreClose(engine: Swarm, lease: Lease, journal: CloseJournal): Promise<never> {
  // Uncommitted success warnings may have failed privacy admission; compensation never republishes them.
  const { warnings: _uncommittedWarnings, result_signature: _uncommittedSignature, ...recoverable } = journal; journal = recoverable;
  const recoveredProofs = await loadCloseProposals(engine, journal);
  journal = { ...journal, proofs: recoveredProofs };
  let states = await inspectDomain(engine, journal);
  const primary = states.get(journal.id)!;
  // The checked native head also fences a completion appended after discovery but before inspection.
  if (primary.item[CLOSE_INTENT] !== undefined) assertUncommittedClose(parseCloseJournal(engine, primary.item[CLOSE_INTENT]));
  if (primary.restored) return completedCompensation(engine, states);
  if (journal.phase !== 'compensating') {
    journal = { ...journal, phase: 'compensating', post: [...states].filter(([, state]) => state.changed).map(([id, state]) => ({ id, head: state.history })), restored: [] };
    await saveJournal(engine, lease, journal, primary);
  }
  await retireCloseProposals(engine, journal); closeBoundary('proofs_retired', journal.id);
  closeBoundary('compensating', journal.id);
  const affected = new Set(journal.post.map(member => member.id));
  const ordered = [...journal.members.slice(1).filter(member => affected.has(member.id)).reverse(), journal.members[0]];
  for (const member of ordered) {
    states = await inspectDomain(engine, journal);
    const state = states.get(member.id)!;
    if (state.restored) {
      await syncCloseMember(engine, member.id);
      if (member.id !== journal.id && !journal.restored.includes(member.id)) {
        journal = { ...journal, restored: [...journal.restored, member.id] };
        await saveJournal(engine, lease, journal, states.get(journal.id)!);
        closeBoundary('recorded', member.id);
      }
      continue;
    }
    closeBoundary('before_restore', member.id);
    const held: Awaited<ReturnType<typeof acquireLockLease>>[] = []; const failures: unknown[] = [];
    try {
      if (member.id === journal.id) {
        for (const target of journal.post.filter(row => row.id !== journal.id).sort((left, right) => left.id.localeCompare(right.id))) held.push(await commitMutation({ id: target.id, author: engine.author }, admitted => acquireLockLease(engine.pmRoot, admitted.id, 1800, admitted.author, false, false, 0)));
      }
      let commit = async () => {
        if (member.id === journal.id) await inspectDomain(engine, journal);
        await lease.write(() => runWithAgentSessionContext({ episode: { id: closeEpisode(journal, 'restore', member) } }, () => commitItemMutation({ id: member.id, item: state.item, target: String(member.version), options: { force: true, author: engine.author, message: 'Swarm close compensation' } }, admitted => engine.client.restore(admitted.id, admitted.target, admitted.options), { history: state.history, onCommitted: () => closeBoundary('restore_native', member.id) })), { announce: false });
      };
      for (const lock of held) { const next = commit; commit = () => lock.fence(next); }
      await commit();
    } catch (error) { failures.push(error); }
    for (const lock of held.reverse()) { try { await lock.release(); } catch (error) { failures.push(error); } }
    if (failures.length > 0) throw new AggregateError(failures, 'Native compensation or lock cleanup failed');
    await syncCloseMember(engine, member.id);
    closeBoundary('restored', member.id);
    // The primary restore removes the field. Its immutable native receipt is the final completion record.
    if (member.id !== journal.id) {
      journal = { ...journal, restored: [...journal.restored, member.id] };
      const checked = await inspectCloseMember(engine, journal, journal.members[0]);
      await saveJournal(engine, lease, journal, checked);
      closeBoundary('recorded', member.id);
    }
  }
  states = await inspectDomain(engine, journal);
  closeBoundary('compensated', journal.id);
  throw new CloseCompensation([...states].filter(([, state]) => state.restored).map(([id]) => id), []);
}
/** Convert storage and locked-CAS failures to truthful partial member receipts, retaining recoverable intent. */
export async function compensateClose(engine: Swarm, lease: Lease, journal: CloseJournal): Promise<never> {
  try {
    // A stale in-memory phase or unavailable read must never authorize rollback over native completion.
    const latest = await discoverCloseJournal(engine, journal.id, undefined);
    if (latest === undefined || closePlanIdentity(latest) !== closePlanIdentity(journal)) throw new CloseCompensation([], journal.members.map(member => member.id));
    journal = latest; assertUncommittedClose(journal);
    closeBoundary('recovery_intent', journal.id);
    return await restoreClose(engine, lease, journal);
  }
  catch (error) {
    if (error instanceof SettingsRefusal && error.code === 'swarm_partial_commit') throw error;
    if (error instanceof CloseCompensation) throw error;
    let latest: CloseJournal | undefined;
    try { latest = await discoverCloseJournal(engine, journal.id, undefined); } catch { /* Preserve the original immutable plan when history is unavailable. */ }
    if (latest !== undefined && closePlanIdentity(latest) === closePlanIdentity(journal)) { journal = latest; assertUncommittedClose(journal); }
    const restored: string[] = []; const pending: string[] = [];
    for (const member of journal.members) {
      try { const state = await inspectCloseMember(engine, journal, member); if (state.restored) restored.push(member.id); else if (state.changed) pending.push(member.id); }
      catch { pending.push(member.id); }
    }
    throw retainFailureCause(new CloseCompensation(restored, pending.length > 0 ? pending : restored), error);
  }
}
/** Immutable plan captured through native reads; native close alone decides which dependents to mutate. */
export async function prepareClose(engine: Swarm, id: string, note: string, token: unknown, primary: Awaited<ReturnType<typeof captureCloseMember>>): Promise<{ journal: CloseJournal; snapshots: Map<string, Awaited<ReturnType<typeof captureCloseMember>>>; signer: KeyObject }> {
  const snapshots = new Map([[id, primary]]);
  const corpus = (await engine.corpus()).items; const blockers = indexBlockedByIds(corpus);
  for (const row of corpus) if (row.id !== id && blockers.get(row.id.trim().toLowerCase())?.includes(id.trim().toLowerCase())) {
    try { snapshots.set(row.id, await captureCloseMember(engine, row.id, false)); }
    catch { /* Native close retains its own warning semantics for unadmitted foreign rows. */ }
  }
  const compensation_id = deriveMutationTransactionId(randomUUID());
  validateWorkspaceTransactionIdentity({ pmRoot: engine.pmRoot, author: engine.author, transactionId: compensation_id });
  const members: CloseMember[] = [...snapshots.values()].map(snapshot => snapshot.member);
  await syncCloseMember(engine, id);
  const keys = generateKeyPairSync('ed25519');
  return { journal: { protocol: 'swarm-close/v3', compensation_id, id, author: engine.author, token: token === undefined ? null : String(token), note, members, phase: 'applying', post: [], restored: [], public_key: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('hex'), proofs: [] }, snapshots, signer: keys.privateKey };
}
/** Replay certified completion before abandoned pins, retiring only its remaining native proof cache. */
export async function replayCommittedClose(engine: Swarm, journal: CloseJournal): Promise<{ id: string; closed: true; warnings?: string[] }> {
  try {
    if (!validCloseResult(journal)) throw new SettingsRefusal('swarm_compensation_partial', 'The committed close receipt cannot be authenticated. Preserve native history and inspect its saved result.', 'close');
    await inspectDomain(engine, journal);
    // Dependents were synced before this receipt committed. Their current files now belong to later work.
    await syncCloseMember(engine, journal.id);
    await retireCloseProposals(engine, journal);
    return { id: journal.id, closed: true, ...(journal.warnings!.length > 0 ? { warnings: journal.warnings } : {}) };
  } catch (error) {
    if (error instanceof SettingsRefusal) throw error;
    throw retainFailureCause(new SettingsRefusal('swarm_partial_commit', `The close committed for item ${journal.id}. Durability confirmation is unavailable; preserve native history and retry the original request after storage recovers.`, 'close'), error);
  }
}
/** The final native primary restore is authoritative even when lease cleanup or its return was lost. */
export async function replayCompensatedClose(engine: Swarm, journal: CloseJournal): Promise<never> {
  const states = await inspectDomain(engine, journal);
  if (!states.get(journal.id)!.restored) throw new CloseCompensation([], journal.members.map(member => member.id));
  return completedCompensation(engine, states);
}
/** Execute one native lifecycle and durably certify its result; ordinary failures compensate its entire domain. */
export async function applyClose(engine: Swarm, lease: Lease, prepared: Awaited<ReturnType<typeof prepareClose>>): Promise<{ id: string; closed: true; warnings?: string[] }> {
  let journal = prepared.journal;
  const original = prepared.snapshots.get(journal.id)!;
  await saveJournal(engine, lease, journal, { item: original.item, history: original.historyHead, changed: false, restored: false, forwarded: false });
  try {
    closeBoundary('intent', journal.id);
    const primary = await inspectCloseMember(engine, journal, journal.members[0]);
    const related = new Map([...prepared.snapshots].filter(([id]) => id !== journal.id).map(([id, snapshot]) => [id, { item: snapshot.item, history: snapshot.historyHead }]));
    closeBoundary('before_close', journal.id);
    const result = await lease.write(() => runWithAgentSessionContext({ episode: { id: closeEpisode(journal, 'close', journal.id) } }, () => commitItemMutation({ id: journal.id, item: primary.item, note: journal.note, options: { author: engine.author, message: 'Swarm native close' } }, admitted => engine.client.close(admitted.id, admitted.note, admitted.options), { history: primary.history, related,
      onPrepared: async (before, after, operation, history) => { closeBoundary('before_proposal', String(after.metadata.id)); await syncCloseMember(engine, String(after.metadata.id)); await recordCloseProposal(engine, journal, prepared.signer, before, after, operation, history); closeBoundary('proposal', String(after.metadata.id)); },
      onCommitted: (_before, after) => closeBoundary('native', String(after.metadata.id)) })), { announce: false });
    closeBoundary('closed', journal.id);
    const committedProofs = await loadCloseProposals(engine, journal);
    journal = { ...journal, proofs: committedProofs };
    const states = await inspectDomain(engine, journal);
    for (const [id, state] of states) if (state.changed) await syncCloseMember(engine, id);
    closeBoundary('close_synced', journal.id);
    journal = { ...journal, phase: 'committed', warnings: result.warnings, post: [...states].filter(([, state]) => state.changed).map(([id, state]) => ({ id, head: state.history })) };
    journal = { ...journal, result_signature: signCloseResult(journal, prepared.signer) };
    closeBoundary('before_commit', journal.id);
    await saveJournal(engine, lease, journal, states.get(journal.id)!);
    await retireCloseProposals(engine, journal); closeBoundary('proofs_retired', journal.id);
    closeBoundary('committed', journal.id);
    return { id: journal.id, closed: true, ...(journal.warnings!.length > 0 ? { warnings: journal.warnings } : {}) };
  } catch (failure) {
    return compensateClose(engine, lease, journal).catch((outcome: unknown) => { throw retainFailureCause(outcome, failure); });
  }
}
