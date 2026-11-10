import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { deriveMutationTransactionId, getHistoryPath, getItemAt, hashHistoryStream, locateItem, readHistoryEntries, readSettings, replayHistoryToTarget, replayToCanonicalItemDocument, resolveItemTypeRegistry, validateWorkspaceTransactionIdentity, verifyHistoryEntries } from '@unbrained/pm-cli/sdk';
import type { Swarm } from './swarm.ts';
import type { ItemHistoryHead } from './settings.ts';
import { assertItemHistoryHead, assertPrivatePathSafe, documentFingerprint, SettingsRefusal, syncNativeArtifacts } from './settings.ts';
import { clientMutationSnapshot, readItemIdentity } from './inspection.ts';
import { loadCloseProposals, validCloseResult } from './close-proofs.ts';
import type { SignedCloseProposal } from './close-proofs.ts';

/** Registered native field; every revision is retained by the SDK's item history. */
export const CLOSE_INTENT = 'swarm_close_intent';
/** Immutable native restore target captured before any close-related write. */
export interface CloseMember { id: string; version: number; head: ItemHistoryHead; digest: string; document_hash: string }
/** Per-member post-close receipt, frozen before the first compensation. */
export interface ClosePost { id: string; head: ItemHistoryHead }
/** One native-field coordinator, with no package-owned journal files. */
export interface CloseJournal {
  protocol: 'swarm-close/v3'; compensation_id: string; id: string; author: string; token: string | null; note: string;
  members: CloseMember[]; phase: 'applying' | 'compensating' | 'committed'; post: ClosePost[]; restored: string[]; warnings?: string[];
  public_key: string; proofs: SignedCloseProposal[]; result_signature?: string;
}
/** Synchronous diagnostics may kill a worker at a real durable boundary, without replacing an SDK method. */
type CloseObserver = (boundary: string, id: string) => void;
const OBSERVERS_KEY = Symbol.for('pm-swarm.close-observers/v3');
const OBSERVERS = (Reflect.get(globalThis, OBSERVERS_KEY) as AsyncLocalStorage<CloseObserver> | undefined) ?? new AsyncLocalStorage<CloseObserver>();
Object.defineProperty(globalThis, OBSERVERS_KEY, { value: OBSERVERS });
/** Scope diagnostic observations to one close, across source and installed module copies. */
export function withCloseObserver<Result>(observer: CloseObserver, operation: () => Result): Result { return OBSERVERS.run(observer, operation); }
/** Emit a boundary only after the corresponding native call or durable sync. */
export function closeBoundary(boundary: string, id: string): void { OBSERVERS.getStore()?.(boundary, id); }
/** Bind a native episode to the validated compensation identity and exact operation payload. */
export function closeEpisode(journal: CloseJournal, phase: string, payload: unknown): string {
  return deriveMutationTransactionId(JSON.stringify({ compensation_id: journal.compensation_id, phase, payload }));
}
/** Compare immutable plans independently of changing progress and final warning receipts. */
export function closePlanIdentity(journal: CloseJournal): string {
  return JSON.stringify([journal.protocol, journal.compensation_id, journal.id, journal.author, journal.token, journal.note, journal.members, journal.public_key]);
}
/** Reject malformed or foreign field content before it can authorize restoration. */
export function parseCloseJournal(engine: Swarm, value: unknown): CloseJournal {
  try {
    if (typeof value !== 'string') throw new Error('Missing intent');
    const journal = JSON.parse(value) as CloseJournal;
    assertPrivatePathSafe(journal, 'close_intent');
    validateWorkspaceTransactionIdentity({ pmRoot: engine.pmRoot, author: journal.author, transactionId: journal.compensation_id });
    if (journal.protocol !== 'swarm-close/v3' || typeof journal.id !== 'string' || typeof journal.note !== 'string' || !(journal.token === null || typeof journal.token === 'string' && /^\d+$/.test(journal.token))
      || !['applying', 'compensating', 'committed'].includes(journal.phase) || !Array.isArray(journal.members) || journal.members.length === 0 || !Array.isArray(journal.post) || !Array.isArray(journal.restored) || !/^[a-f0-9]{88}$/.test(journal.public_key) || !Array.isArray(journal.proofs)
      || new Set(journal.members.map(member => member.id)).size !== journal.members.length || journal.members[0].id !== journal.id
      || journal.members.some(member => typeof member.id !== 'string' || !Number.isSafeInteger(member.version) || member.version < 1 || !Number.isSafeInteger(member.head.length) || member.head.length < 1 || !/^[a-f0-9]{64}$/.test(member.head.hash) || !/^[a-f0-9]{64}$/.test(member.digest) || !/^[a-f0-9]{64}$/.test(member.document_hash))) throw new Error('Invalid intent');
    const ids = new Set(journal.members.map(member => member.id));
    if (new Set(journal.post.map(member => member.id)).size !== journal.post.length || journal.post.some(member => !ids.has(member.id) || !Number.isSafeInteger(member.head.length) || member.head.length < 1 || !/^[a-f0-9]{64}$/.test(member.head.hash))
      || journal.result_signature !== undefined && (typeof journal.result_signature !== 'string' || !/^[a-f0-9]{128}$/.test(journal.result_signature))
      || new Set(journal.restored).size !== journal.restored.length || journal.restored.some(id => !ids.has(id) || id === journal.id)
      || journal.phase === 'committed' && (!Array.isArray(journal.warnings) || journal.warnings.some(value => typeof value !== 'string'))) throw new Error('Invalid progress');
    return journal;
  } catch { throw new SettingsRefusal('swarm_close_recovery_unsupported', 'The close intent is malformed or unsupported. Preserve native history and inspect the registered close field before retrying.', 'close'); }
}
/** Resolve storage only through the SDK's current type registry, including custom item types. */
async function memberPath(engine: Swarm, id: string): Promise<string> {
  const settings = await readSettings(engine.pmRoot);
  const located = await locateItem(engine.pmRoot, id, settings.id_prefix, settings.item_format, resolveItemTypeRegistry(settings).type_to_folder);
  if (located === null) throw new SettingsRefusal('swarm_compensation_partial', 'A lifecycle member is unavailable. Preserve all remaining members and inspect native history.', 'close');
  return located.itemPath;
}
/** Hash the actual native item bytes; restore acceptance never ignores native timestamps. */
export async function memberDigest(engine: Swarm, id: string): Promise<string> { return createHash('sha256').update(await readFile(await memberPath(engine, id))).digest('hex'); }
/** Flush native artifacts and supported parent-directory barriers without rewriting a journal file. */
export async function syncCloseMember(engine: Swarm, id: string): Promise<void> {
  const item = await memberPath(engine, id); const history = getHistoryPath(engine.pmRoot, id);
  await syncNativeArtifacts([item, history]);
}
/** Capture canonical identity, history-before-document admission and an exact byte restore target. */
export async function captureCloseMember(engine: Swarm, id: string, admit = true) {
  const snapshot = await clientMutationSnapshot(engine.pmRoot, engine.client, id);
  const history = await readHistoryEntries(getHistoryPath(engine.pmRoot, String(snapshot.item.id)), String(snapshot.item.id));
  const view = await getItemAt(String(snapshot.item.id), history.at(-1)!.ts, { pmRoot: engine.pmRoot });
  if (view.as_of_version === null) throw new SettingsRefusal('swarm_close_recovery_unsupported', 'The native close history has no stable version mapping. Preserve it for explicit inspection.', 'close');
  const member: CloseMember = { id: String(snapshot.item.id), version: view.as_of_version, head: snapshot.historyHead, digest: await memberDigest(engine, String(snapshot.item.id)), document_hash: history.at(-1)!.after_hash };
  // The native identity read proved ordinal mapping; retaining the same head also retains that mapping.
  await assertItemHistoryHead(engine.pmRoot, member.id, member.head);
  if (documentFingerprint(snapshot.item) !== documentFingerprint({ ...view.document.metadata, body: view.document.body })) throw new SettingsRefusal('swarm_document_changed', 'Refresh the complete native lifecycle snapshot before closing.', 'document');
  if (admit) assertPrivatePathSafe(snapshot.item, 'document');
  return { ...snapshot, member };
}
/** Find the latest intent even when the final primary restore has removed its field. */
export async function discoverCloseJournal(engine: Swarm, id: string, current: unknown): Promise<CloseJournal | undefined> {
  const present = current === undefined ? undefined : parseCloseJournal(engine, current);
  const history = await readHistoryEntries(getHistoryPath(engine.pmRoot, id), id);
  let latestVersion: number | undefined;
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index];
    if (entry.op === 'restore' || !entry.patch.some(patch => patch.path.endsWith(`/${CLOSE_INTENT}`))) continue;
    latestVersion ??= (await getItemAt(id, history.at(-1)!.ts, { pmRoot: engine.pmRoot })).as_of_version ?? undefined;
    if (latestVersion === undefined) throw new SettingsRefusal('swarm_close_recovery_unsupported', 'The native close history has no stable version mapping. Preserve it for explicit inspection.', 'close');
    const view = await getItemAt(id, String(latestVersion - history.length + index + 1), { pmRoot: engine.pmRoot });
    const value = view.document.metadata[CLOSE_INTENT];
    if (value !== undefined) return parseCloseJournal(engine, value);
  }
  return present;
}
/** Checked current member, including independently certified completed restoration. */
export interface CloseInspection { item: Record<string, unknown>; history: ItemHistoryHead; changed: boolean; restored: boolean; forwarded: boolean }
/** Verify an uninterrupted native receipt chain; copied prose, author equality and ABA never suffice. */
async function inspectMember(engine: Swarm, journal: CloseJournal, member: CloseMember, proofs: readonly SignedCloseProposal[], through?: number): Promise<CloseInspection> {
  const current = through === undefined ? await clientMutationSnapshot(engine.pmRoot, engine.client, member.id) : undefined;
  const canonical = current?.item.id ?? (await readItemIdentity(engine.client, member.id)).item.id;
  if (canonical !== member.id) throw new SettingsRefusal('swarm_compensation_partial', 'The recovery member identity is not canonical. Preserve its native history and inspect the close intent.', 'close');
  const complete = await readHistoryEntries(getHistoryPath(engine.pmRoot, member.id), member.id);
  const entries = through === undefined ? complete : complete.slice(0, through);
  const historical = through === undefined ? undefined : await getItemAt(member.id, String(member.version + entries.length - member.head.length), { pmRoot: engine.pmRoot });
  const snapshot = historical === undefined ? current! : { item: { ...historical.document.metadata, body: historical.document.body }, historyHead: { length: entries.length, hash: hashHistoryStream(entries) } };
  const foreign = () => new SettingsRefusal('swarm_compensation_partial', `Native history for lifecycle member ${member.id} was superseded. Preserve peer edits; inspect restored and pending members before retrying.`, 'close');
  if (!verifyHistoryEntries(entries).ok || hashHistoryStream(entries.slice(0, member.head.length)) !== member.head.hash || entries.length !== snapshot.historyHead.length || entries[member.head.length - 1]?.after_hash !== member.document_hash) throw foreign();
  const { schema } = await readSettings(engine.pmRoot);
  let changed = false; let restored = false; let forwarded = false; let previous: CloseJournal | undefined; let forwardEnd = member.head.length;
  for (const [offset, entry] of entries.slice(member.head.length).entries()) {
    // Use core's verified replay and canonicalizer on this exact captured stream, without reopening history.
    const view = { document: replayToCanonicalItemDocument(replayHistoryToTarget(entries, member.head.length + offset), { schema }) };
    if (restored) throw foreign();
    if (member.id === journal.id && entry.op === 'update' && typeof view.document.metadata[CLOSE_INTENT] === 'string') {
      const recorded = parseCloseJournal(engine, view.document.metadata[CLOSE_INTENT]);
      const allowedFields = new Set([`/metadata/${CLOSE_INTENT}`, '/metadata/updated_at']);
      if (recorded.phase === 'committed') {
        if (!forwarded || !validCloseResult(recorded)) throw foreign();
        if (recorded.token !== null) allowedFields.add('/metadata/swarm_token');
        for (const field of ['swarm_handoff', 'swarm_claimed_at']) allowedFields.add(`/metadata/${field}`);
        if (view.document.metadata.swarm_handoff !== undefined || view.document.metadata.swarm_claimed_at !== undefined || recorded.token !== null && view.document.metadata.swarm_token !== String(BigInt(recorded.token) + 1n)) throw foreign();
      }
      if (closePlanIdentity(recorded) !== closePlanIdentity(journal) || entry.agent_episode?.id !== closeEpisode(recorded, 'journal', recorded) || entry.patch.some(patch => !allowedFields.has(patch.path))) throw foreign();
      if (previous === undefined ? offset !== 0 || recorded.phase !== 'applying' || recorded.post.length !== 0 || recorded.restored.length !== 0 || recorded.proofs.length !== 0
        : previous.phase !== 'applying' && (recorded.phase !== 'compensating' || previous.phase !== 'compensating' || JSON.stringify(recorded.post) !== JSON.stringify(previous.post) || recorded.restored.length !== previous.restored.length + 1 || previous.restored.some((id, index) => recorded.restored[index] !== id))
          || previous.phase === 'applying' && (recorded.phase === 'applying' || recorded.restored.length !== 0)) throw foreign();
      previous = recorded;
      if (recorded.phase === 'applying') forwardEnd = member.head.length + offset + 1;
    } else if (entry.op === (member.id === journal.id ? 'close' : 'update') && !forwarded && entry.agent_episode?.id === closeEpisode(journal, 'close', journal.id)) {
      const exact = proofs.some(({ proposal }) => proposal.id === member.id && proposal.operation === entry.op && proposal.before.length === member.head.length + offset && proposal.before.hash === hashHistoryStream(entries.slice(0, member.head.length + offset)) && proposal.before_hash === entry.before_hash && proposal.after_hash === entry.after_hash);
      if (!exact) throw foreign();
      forwarded = true; forwardEnd = member.head.length + offset + 1;
    } else if (entry.op === 'restore' && entry.agent_episode?.id === closeEpisode(journal, 'restore', member) && entry.after_hash === member.document_hash) {
      if (journal.phase !== 'compensating') throw foreign();
      const post = journal.post.find(row => row.id === member.id);
      if (post === undefined || hashHistoryStream(entries.slice(0, post.head.length)) !== post.head.hash || member.id !== journal.id && member.head.length + offset !== post.head.length) throw foreign();
      restored = true;
    } else {
      throw foreign();
    }
    changed = true;
  }
  if (journal.phase !== 'applying') {
    const post = journal.post.find(row => row.id === member.id);
    if (changed ? post === undefined || post.head.length !== forwardEnd || post.head.hash !== hashHistoryStream(entries.slice(0, forwardEnd)) : post !== undefined) throw foreign();
  }
  const view = historical ?? { document: replayToCanonicalItemDocument(replayHistoryToTarget(entries, entries.length - 1), { schema }) };
  if (documentFingerprint(snapshot.item) !== documentFingerprint({ ...view.document.metadata, body: view.document.body }) || through === undefined && (restored || !changed) && await memberDigest(engine, member.id) !== member.digest) throw foreign();
  return { item: snapshot.item, history: snapshot.historyHead, changed, restored, forwarded };
}
/** Verify one member with a freshly authenticated native proposal snapshot. */
export async function inspectCloseMember(engine: Swarm, journal: CloseJournal, member: CloseMember, through?: number): Promise<CloseInspection> {
  return inspectMember(engine, journal, member, await loadCloseProposals(engine, journal), through);
}
/** Authenticate proposals once per complete domain read, retaining every member-level refusal. */
export async function inspectCloseMembers(engine: Swarm, journal: CloseJournal): Promise<{ states: Map<string, CloseInspection>; pending: string[]; failures: unknown[] }> {
  const proofs = await loadCloseProposals(engine, journal); const states = new Map<string, CloseInspection>(); const pending: string[] = []; const failures: unknown[] = [];
  for (const member of journal.members) {
    try { states.set(member.id, await inspectMember(engine, journal, member, proofs)); }
    catch (failure) { pending.push(member.id); failures.push(failure); }
  }
  if (!states.get(journal.id)?.forwarded) for (const [id, state] of states) if (id !== journal.id && state.forwarded) pending.push(id);
  return { states, pending, failures };
}
/** A newer claim retires only a historically certified committed close or final primary restore. */

export async function retiredCloseGeneration(engine: Swarm, journal: CloseJournal, item: Record<string, unknown>): Promise<boolean> {
  const previous = journal.token ?? '0';
  if (!/^\d+$/.test(String(item.swarm_token)) || !/^\d+$/.test(previous) || BigInt(String(item.swarm_token)) <= BigInt(previous)) return false;
  const member = journal.members[0];
  const entries = await readHistoryEntries(getHistoryPath(engine.pmRoot, member.id), member.id);
  if (journal.phase === 'committed' && typeof item.assignee === 'string') {
    if (!validCloseResult(journal)) return false;
    const committed = entries.findIndex(entry => entry.op === 'update' && entry.agent_episode?.id === closeEpisode(journal, 'journal', journal));
    return committed >= 0 && (await inspectCloseMember(engine, journal, member, committed + 1)).changed;
  }
  const index = entries.findIndex((entry, index) => index >= member.head.length && entry.op === 'restore' && entry.agent_episode?.id === closeEpisode(journal, 'restore', member));
  return index >= 0 && (await inspectCloseMember(engine, journal, member, index + 1)).restored;
}
