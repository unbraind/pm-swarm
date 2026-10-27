import type { ItemHistoryHead } from './settings.ts';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getItemAt, readFileIfExists, readHistoryEntries, getHistoryPath, validateWorkspaceTransactionIdentity } from '@unbrained/pm-cli/sdk';
import type { ItemDocument, WorkspaceTransactionJsonValue } from '@unbrained/pm-cli/sdk';
import { documentFingerprint, SettingsRefusal, commitMutation, assertMutationReceipt } from './settings.ts';
import { historySnapshot } from './inspection.ts';

/** Fixed domain steps; the transaction id also binds actor, item, fence and note. */
export const CLOSE_STEPS = ['metadata', 'close'] as const;
/** One native history version bound to its complete canonical document. */
export interface CloseSnapshot { version: number; hash: string; document: ItemDocument; historyHead: ItemHistoryHead }
/** Journal-safe compensation receipt owned and persisted by the SDK coordinator. */
export interface CloseCheckpoint { version: number; hash: string }
/** Validated identity and semantic intent shared by preflight and locked checks. */
export interface CloseIdentity { canonicalId: string; transactionId: string; next: string; resumed: boolean }
/** The journal is SDK-owned; this adapter only reads its documented location and our own step data. */
interface CloseJournal {
  status: string;
  startedStepIds: string[];
  compensationData: Record<string, unknown>;
  results: Record<string, unknown>;
}
/** Current position of the two forward writes and their reverse-order compensations. */
export interface CloseTrace { phase: number; snapshots: CloseSnapshot[]; journal?: CloseJournal }

/** Refuse uncertain recovery without exposing storage coordinates or caller-controlled messages. */
export function closeConflict(detail = 'The item changed outside the recorded close transaction.'): never {
  throw new SettingsRefusal('swarm_document_changed', `${detail} Preserve its current document and inspect the SDK journal and history before retrying.`, 'document');
}
/** Share native receipt equality across every close preimage and write read-back. */
export function assertCloseReceipt(actual: unknown, expected: unknown, detail = 'The item changed outside the recorded close transaction.'): void {
  assertMutationReceipt(actual, expected, `${detail} Preserve its current document and inspect the SDK journal and history before retrying.`);
}
/** Distinguish journal objects from arrays and scalars without accepting prototypes as schema evidence. */
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
/** Hash only durable item content, using the same normalization as native item admission. */
export function closeDocumentHash(document: ItemDocument): string {
  return createHash('sha256').update(documentFingerprint({ ...document.metadata, body: document.body })).digest('hex');
}
/** Validate package step data; journal contents never become an alternate mutation plan. */
export function closeCheckpoint(value: unknown): CloseCheckpoint {
  if (!record(value) || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)) closeConflict('The close journal checkpoint is invalid.');
  return { version: Number(value.version), hash: value.hash };
}
/** Reconstruct a stable SDK history version; no timestamp is used as an ownership key. */
export async function closeSnapshot(pmRoot: string, id: string, version?: number): Promise<CloseSnapshot> {
  const view = await historySnapshot(pmRoot, id, version);
  return { version: view.version, hash: closeDocumentHash(view.document), document: view.document, historyHead: view.historyHead };
}
/** Read only the coordinator's journal, after validating the exact deterministic identity. */
async function closeJournal(pmRoot: string, author: string, intent: CloseIdentity): Promise<CloseJournal | undefined> {
  const identity = validateWorkspaceTransactionIdentity({ pmRoot, author, transactionId: intent.transactionId });
  try {
    const raw = await readFileIfExists(join(identity.pmRoot, 'transactions/sdk', `${identity.transactionId}.json`));
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.schemaVersion !== 1 || value.transactionId !== identity.transactionId || value.author !== identity.author
      || !Array.isArray(value.stepIds) || JSON.stringify(value.stepIds) !== JSON.stringify(CLOSE_STEPS)
      || !['applying', 'compensating', 'compensated', 'committed'].includes(String(value.status))
      || !Array.isArray(value.startedStepIds) || !value.startedStepIds.every(id => CLOSE_STEPS.includes(id))
      || !record(value.compensationData) || !record(value.results)) closeConflict('The close journal identity or plan is invalid.');
    return { status: String(value.status), startedStepIds: value.startedStepIds, compensationData: value.compensationData, results: value.results };
  } catch { return closeConflict('The close journal could not be verified.'); }
}
/** Verify one forward metadata mutation against the journal's immutable preimage. */
function metadataSuccessor(before: ItemDocument, after: ItemDocument, intent: CloseIdentity): boolean {
  const metadata: ItemDocument['metadata'] = { ...before.metadata, swarm_token: intent.next, swarm_close_transaction: intent.transactionId, updated_at: after.metadata.updated_at };
  delete metadata.assignee; delete metadata.swarm_handoff;
  return closeDocumentHash({ metadata, body: before.body }) === closeDocumentHash(after);
}
/** Bind native close read-back to its SDK preimage; completed compensation removes that step's receipt. */
function nativeCloseCheckpoint(journal: CloseJournal, before: CloseSnapshot, count: number): boolean {
  if (journal.compensationData.close === undefined) return journal.status === 'compensating' && count >= 3;
  const checkpoint = closeCheckpoint(journal.compensationData.close);
  return checkpoint.hash === before.hash && checkpoint.version === before.version;
}

/** Validate journal-bound native versions and complete snapshots; free-text history messages are never inspected. */
export async function closeTrace(pmRoot: string, author: string, intent: CloseIdentity, _note: string): Promise<CloseTrace> {
  const journal = await closeJournal(pmRoot, author, intent);
  if (journal === undefined) { if (intent.resumed) closeConflict('The interrupted close has no SDK journal.'); return { phase: 0, snapshots: [] }; }
  if (journal.compensationData.metadata === undefined) {
    if (intent.resumed || journal.status === 'committed') closeConflict('The close journal has no ownership checkpoint.');
    return { phase: 0, snapshots: [], journal };
  }
  const checkpoint = closeCheckpoint(journal.compensationData.metadata);
  const before = await closeSnapshot(pmRoot, intent.canonicalId, checkpoint.version);
  const latest = await closeSnapshot(pmRoot, intent.canonicalId);
  const count = latest.version - before.version;
  if (before.hash !== checkpoint.hash || count < 0 || count > 4) closeConflict();
  const snapshots = [before];
  const history = await readHistoryEntries(getHistoryPath(pmRoot, intent.canonicalId), intent.canonicalId);
  let phase = 0;
  for (let offset = 1; offset <= count; offset++) {
    const current = offset === count ? latest : await closeSnapshot(pmRoot, intent.canonicalId, before.version + offset);
    const view = await getItemAt(intent.canonicalId, String(current.version), { pmRoot });
    const entry = history[view.target.historyIndex];
    if (entry.author !== author) closeConflict();
    if (offset === 1 && entry.op === 'update' && metadataSuccessor(before.document, current.document, intent)) phase = 1;
    else if (offset === 2 && entry.op === 'close' && (journal.startedStepIds.includes('close') || journal.status === 'compensating' && count >= 3) && nativeCloseCheckpoint(journal, snapshots[1], count)) phase = 2;
    else if (offset === 2 && entry.op === 'restore' && current.hash === before.hash && journal.status === 'compensating') phase = 4;
    else if (offset === 3 && phase === 2 && entry.op === 'restore' && current.hash === snapshots[1].hash && journal.status === 'compensating') phase = 3;
    else if (offset === 4 && phase === 3 && entry.op === 'restore' && current.hash === before.hash && journal.status === 'compensating') phase = 4;
    else closeConflict();
    snapshots.push(current);
  }
  for (const [step, value] of Object.entries(journal.results)) {
    const index = CLOSE_STEPS.indexOf(step as typeof CLOSE_STEPS[number]);
    const receipt = closeCheckpoint(value);
    if (index < 0 || snapshots[index + 1]?.version !== receipt.version || snapshots[index + 1]?.hash !== receipt.hash) closeConflict('The close journal result does not match its native version.');
  }
  if (journal.status === 'committed' && phase !== 2) closeConflict();
  return { phase, snapshots, journal };
}

/** Compact SDK-journal result proving the exact native version written by one step. */
export function closeStepResult(snapshot: CloseSnapshot, warnings?: string[], unavailable = false, effects?: CloseEffect[]): WorkspaceTransactionJsonValue { return commitMutation({ version: snapshot.version, hash: snapshot.hash, ...(warnings === undefined ? {} : { warnings }), ...(unavailable ? { warnings_unavailable: true } : {}), ...(effects === undefined ? {} : { effects: effects.map(effect => ({ ...effect, before: { ...effect.before, historyHead: { ...effect.before.historyHead } }, after: { ...effect.after, historyHead: { ...effect.after.historyHead } } })) }) }, admitted => admitted); }

/** Retain the native lifecycle receipts without translating, rebuilding or silently dropping them. */
export function closeWarnings(result: unknown): string[] {
  if (!record(result) || result.warnings === undefined) return [];
  if (!Array.isArray(result.warnings) || !result.warnings.every(value => typeof value === 'string')) closeConflict('The native close warning receipt is invalid.');
  return result.warnings;
}

/** Native warnings cannot be inferred from item history when the SDK interrupted before saving its result. */
export function closeWarningsUnavailable(result: unknown): boolean { return !record(result) || !Array.isArray(result.warnings) || result.warnings_unavailable === true; }

/** Exact native secondary mutations observed by this admitted SDK call, persisted only in its journal result. */
export interface CloseEffect { id: string; before: CloseCheckpoint & { historyHead: ItemHistoryHead }; after: CloseCheckpoint & { historyHead: ItemHistoryHead } }
/** Preserve opaque journal receipts across inspect/replay without rebuilding native lifecycle policy. */
export function closeEffects(result: unknown): CloseEffect[] | undefined {
  if (!record(result) || result.effects === undefined) return undefined;
  if (!Array.isArray(result.effects)) closeConflict('The native close effect receipt is invalid.');
  return result.effects.map(value => {
    if (!record(value) || typeof value.id !== 'string') closeConflict('The native close effect identity is invalid.');
    const point = (raw: unknown) => {
      const checkpoint = closeCheckpoint(raw);
      if (!record(raw) || !record(raw.historyHead) || !Number.isSafeInteger(raw.historyHead.length) || typeof raw.historyHead.hash !== 'string') closeConflict('The native close effect history is invalid.');
      return { ...checkpoint, historyHead: { length: Number(raw.historyHead.length), hash: raw.historyHead.hash } };
    };
    return { id: value.id, before: point(value.before), after: point(value.after) };
  });
}
