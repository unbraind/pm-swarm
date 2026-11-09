import { relative, sep } from 'node:path';
import { readSettings, resolveRuntimeStatusRegistry, statusIsTerminal, validateWorkspaceTransactionIdentity, getHistoryPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { inspectItem } from './inspection.ts';
import { CLOSE_INTENT, captureCloseMember, discoverCloseJournal, parseCloseJournal, retiredCloseGeneration } from './close-journal.ts';
import { applyClose, prepareClose, compensateClose, replayCommittedClose, replayCompensatedClose } from './close-recovery.ts';
import { StaleFenceError, withSwarmLease } from './lease.ts';
import { assertPrivatePathSafe, rawDocument, SettingsRefusal } from './settings.ts';
import { admitCloseProofSettings } from './close-proofs.ts';
import { RESOURCE_TAG } from './resources.ts';
import type { CloseJournal } from './close-journal.ts';
import type { Swarm } from './swarm.ts';

/** Unowned or mismatched close history remains ineligible for automatic recovery. */
export class CloseRecoveryUnsupported extends SettingsRefusal {
  /** Canonical native item identity requiring inspection. */
  readonly item_id: string;
  /** Tracker-relative native history or legacy transaction entry requiring inspection. */
  readonly journal_entry: string;
  /** Present only when this invocation observed the primary native commit. */
  readonly committed: true | undefined;
  /** Refuse recovery without echoing local coordinates or document content. */
  constructor(id: string, entry: string, committed = false) {
    assertPrivatePathSafe({ id, entry });
    super('swarm_close_recovery_unsupported', `${committed ? 'The native close committed. Retry its exact original author, note and token to verify the saved receipt. ' : 'The supplied request has no matching recoverable close intent. '}Inspect item ${id} and journal entry ${entry} with native pm commands; preserve their bytes and reconcile explicitly when the original request cannot be recovered.`, 'close');
    this.name = 'CloseRecoveryUnsupported'; this.item_id = id; this.journal_entry = entry;
    this.committed = committed ? true : undefined;
  }
}
/** Refuse an ownership change that would strand a pending or malformed close episode.
 * A transferred nonterminal intent can neither be compensated by its original author (the transfer
 * is foreign history) nor retried by the new owner (the plan is author-bound), so every ownership
 * change refuses until the episode is reconciled; a committed receipt stays transferable because
 * a newer fencing generation retires it at fresh admission. */
export function assertCloseIntentSettled(engine: Swarm, item: Record<string, unknown>): void {
  if (item[CLOSE_INTENT] === undefined) return;
  const id = String(item.id);
  let journal: CloseJournal;
  try { journal = parseCloseJournal(engine, item[CLOSE_INTENT]); }
  catch { throw new SettingsRefusal('swarm_close_transfer_refused', `Item ${id} has a malformed close intent. Preserve native history and reconcile the close explicitly before changing ownership.`, 'close'); }
  if (journal.phase !== 'committed') throw new SettingsRefusal('swarm_close_transfer_refused', `Item ${id} has an interrupted close episode. Retry the original close request with its author, token and note to reconcile it before changing ownership.`, 'close');
}
/** Legacy markers identify entries to inspect; they never select an automatic restore target. */
function refuseLegacyMarker(engine: Swarm, item: Record<string, unknown>): void {
  if (item.swarm_close_transaction === undefined) return;
  let entry = 'item.swarm_close_transaction';
  try {
    const identity = validateWorkspaceTransactionIdentity({ pmRoot: engine.pmRoot, author: engine.author, transactionId: String(item.swarm_close_transaction) });
    entry = `transactions/sdk/${identity.transactionId}.json`;
  } catch { /* Preserve malformed foreign markers without interpreting them as filesystem paths. */ }
  throw new CloseRecoveryUnsupported(String(item.id), entry);
}
/** Reuse pure local refusal checks before SDK read bookkeeping and authoritative admission. */
function admitCloseDocument(engine: Swarm, item: Record<string, unknown>, token: string | undefined, tokens: Map<string, string>, statuses: ReturnType<typeof resolveRuntimeStatusRegistry>): { canonicalId: string; journal: string } {
  assertPrivatePathSafe(item, 'document'); refuseLegacyMarker(engine, item);
  const canonicalId = String(item.id); const journal = relative(engine.pmRoot, getHistoryPath(engine.pmRoot, canonicalId)).split(sep).join('/');
  if (statusIsTerminal(String(item.status), statuses)) throw new CloseRecoveryUnsupported(canonicalId, journal);
  if ((item.tags as string[]).includes(RESOURCE_TAG)) throw new Error('Resource items require swarm resource; close cannot change reservations.');
  if (item.swarm_token !== undefined && !/^\d+$/.test(String(item.swarm_token))) throw new Error(`Item ${canonicalId} has a malformed swarm_token; repair it before changing ownership`);
  const selected = token ?? tokens.get(canonicalId);
  if (selected !== undefined && !/^\d+$/.test(selected)) throw new StaleFenceError(canonicalId);
  if (item.assignee !== engine.author || item.swarm_token !== undefined && selected !== item.swarm_token) throw new StaleFenceError(canonicalId);
  return { canonicalId, journal };
}
/** Validate both initial and lease-held state through the same request admission path. */
async function admitCloseRequest(engine: Swarm, item: Record<string, unknown>, note: string, selected: string | undefined, tokens: Map<string, string>): Promise<CloseJournal | undefined> {
  const canonicalId = String(item.id);
  refuseLegacyMarker(engine, item);
  const discovered = await discoverCloseJournal(engine, canonicalId, item[CLOSE_INTENT]);
  if (discovered !== undefined && discovered.id !== canonicalId) throw new CloseRecoveryUnsupported(canonicalId, `history/${canonicalId}.jsonl`);
  const retired = discovered !== undefined && await retiredCloseGeneration(engine, discovered, item);
  const journal = retired ? undefined : discovered;
  if (journal !== undefined && (journal.author !== engine.author || journal.note.trim() !== note || journal.token !== (selected ?? null))) throw new CloseRecoveryUnsupported(canonicalId, `history/${canonicalId}.jsonl`);
  if (journal === undefined) {
    admitCloseProofSettings(await rawDocument(engine.pmRoot));
    admitCloseDocument(engine, item, selected, tokens, resolveRuntimeStatusRegistry((await readSettings(engine.pmRoot)).schema));
    const history = await readHistoryEntries(getHistoryPath(engine.pmRoot, canonicalId), canonicalId);
    const closedAt = history.findIndex(record => record.op === 'close');
    if (!retired && closedAt !== -1) throw new CloseRecoveryUnsupported(canonicalId, `history/${canonicalId}.jsonl#entry=${closedAt + 1}`);
  }
  return journal;
}
/** Replay terminal native receipts before waiting, and again after acquiring the operation lease. */
function replayCloseRequest(engine: Swarm, journal: CloseJournal | undefined, item: Record<string, unknown>) {
  if (journal?.phase === 'committed') return replayCommittedClose(engine, journal);
  if (journal !== undefined && (item[CLOSE_INTENT] === undefined || parseCloseJournal(engine, item[CLOSE_INTENT]).compensation_id !== journal.compensation_id)) return replayCompensatedClose(engine, journal);
  return undefined;
}
/** Persist a native-field intent before close; resume or compensate only history-certified own work. */
export async function completeClaim(engine: Swarm, id: string, note: string, token: string | undefined, tokens: Map<string, string>): Promise<{ id: string; closed: true; warnings?: string[] }> {
  assertPrivatePathSafe({ id, note, token, author: engine.author });
  note = note.trim();
  if (!note.trim()) throw new Error('close requires a nonempty --note');
  const statuses = resolveRuntimeStatusRegistry((await readSettings(engine.pmRoot)).schema);
  const local = await inspectItem(engine.pmRoot, engine.repo, id);
  if (local !== null && local.item[CLOSE_INTENT] === undefined) admitCloseDocument(engine, { ...local.item, body: local.body }, token, tokens, statuses);
  const admission = await captureCloseMember(engine, id); const item = admission.item;
  const canonicalId = String(item.id); const selected = token ?? tokens.get(canonicalId);
  const journal = await admitCloseRequest(engine, item, note, selected, tokens);
  const replay = replayCloseRequest(engine, journal, item);
  if (replay !== undefined) return replay;
  let committed = false;
  try {
    return await withSwarmLease(engine.pmRoot, engine.author, async lease => {
      const current = await captureCloseMember(engine, canonicalId);
      const refreshed = await admitCloseRequest(engine, current.item, note, selected, tokens);
      const replay = replayCloseRequest(engine, refreshed, current.item);
      if (replay !== undefined) return replay;
      if (refreshed !== undefined) return compensateClose(engine, lease, refreshed);
      const result = await applyClose(engine, lease, await prepareClose(engine, canonicalId, note, current.item.swarm_token, current));
      committed = true;
      tokens.delete(canonicalId);
      return result;
    });
  } catch (error) {
    if (committed) throw new CloseRecoveryUnsupported(canonicalId, `history/${canonicalId}.jsonl`, true);
    if (error instanceof SettingsRefusal || error instanceof StaleFenceError) throw error;
    throw new SettingsRefusal('swarm_close_not_committed', `The close result for item ${canonicalId} is unavailable. Preserve native history/${canonicalId}.jsonl and retry the original close request to reconcile its durable intent.`, 'close');
  }
}
