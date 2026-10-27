import { relative, sep } from 'node:path';
import { readSettings, resolveRuntimeStatusRegistry, statusIsTerminal, validateWorkspaceTransactionIdentity, getHistoryPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { clientMutationSnapshot } from './inspection.ts';
import { StaleFenceError, withSwarmLease } from './lease.ts';
import { commitItemMutation, assertPrivatePathSafe, SettingsRefusal } from './settings.ts';
import { RESOURCE_TAG } from './resources.ts';
import type { ItemHistoryHead } from './settings.ts';
import type { Swarm } from './swarm.ts';

/** A close journal is evidence for manual inspection, never permission to replay a mutation. */
export class CloseRecoveryUnsupported extends SettingsRefusal {
  /** Canonical native item identity requiring inspection. */
  readonly item_id: string;
  /** Tracker-relative native history or legacy transaction entry requiring inspection. */
  readonly journal_entry: string;
  /** Refuse recovery without echoing local coordinates or document content. */
  constructor(id: string, entry: string) {
    assertPrivatePathSafe({ id, entry });
    super('swarm_close_recovery_unsupported', `Inspect item ${id} and journal entry ${entry} with native pm commands. Preserve their bytes and reconcile explicitly; swarm never resumes, restores or rewrites an interrupted close.`, 'close');
    this.name = 'CloseRecoveryUnsupported'; this.item_id = id; this.journal_entry = entry;
  }
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
/** Delegate one fresh fenced close to native core; there is no swarm transaction, replay or compensation. */
export async function completeClaim(engine: Swarm, id: string, note: string, token: string | undefined, tokens: Map<string, string>): Promise<{ id: string; closed: true; warnings?: string[] }> {
  assertPrivatePathSafe({ id, note, token, author: engine.author });
  if (!note.trim()) throw new Error('close requires a nonempty --note');
  const admission = await clientMutationSnapshot(engine.pmRoot, engine.client, id); const item = admission.item; const canonicalId = String(item.id);
  assertPrivatePathSafe(item, 'document'); refuseLegacyMarker(engine, item);
  const journal = relative(engine.pmRoot, getHistoryPath(engine.pmRoot, canonicalId)).split(sep).join('/');
  const history = await readHistoryEntries(getHistoryPath(engine.pmRoot, canonicalId), canonicalId);
  const closedAt = history.findIndex(record => record.op === 'close');
  if (closedAt !== -1) throw new CloseRecoveryUnsupported(canonicalId, `${journal}#entry=${closedAt + 1}`);
  const entry = `${journal}#entry=${admission.historyHead.length}`;
  const statuses = resolveRuntimeStatusRegistry((await readSettings(engine.pmRoot)).schema);
  if (statusIsTerminal(String(item.status), statuses)) throw new CloseRecoveryUnsupported(canonicalId, entry);
  if ((item.tags as string[]).includes(RESOURCE_TAG)) throw new Error('Resource items require swarm resource; close cannot change reservations.');
  if (item.swarm_token !== undefined && !/^\d+$/.test(String(item.swarm_token))) throw new Error(`Item ${canonicalId} has a malformed swarm_token; repair it before changing ownership`);
  const selected = token ?? tokens.get(canonicalId);
  if (selected !== undefined && !/^\d+$/.test(selected)) throw new StaleFenceError(canonicalId);
  if (item.assignee !== engine.author || item.swarm_token !== undefined && selected !== item.swarm_token) throw new StaleFenceError(canonicalId);
  const related = new Map<string, { item: Record<string, unknown>; history: ItemHistoryHead }>();
  for (const row of (await engine.corpus()).items) if (row.id !== canonicalId) {
    try { const snapshot = await clientMutationSnapshot(engine.pmRoot, engine.client, row.id); related.set(String(snapshot.item.id), { item: snapshot.item, history: snapshot.historyHead }); }
    catch { /* Unreadable foreign rows stay unadmitted; core reports affected dependent failures unchanged. */ }
  }
  return withSwarmLease(engine.pmRoot, engine.author, async lease => {
    let result: Awaited<ReturnType<typeof engine.client.close>>; let written = false;
    try { result = await lease.write(() => commitItemMutation({ id: canonicalId, item, note, options: { author: engine.author, message: 'Swarm native close' } }, admitted => engine.client.close(admitted.id, admitted.note, admitted.options), { history: admission.historyHead, related, onCommitted: () => { written = true; } })); }
    catch (error) {
      if (error instanceof SettingsRefusal && !written) throw error;
      throw new CloseRecoveryUnsupported(canonicalId, `${journal}#after=${admission.historyHead.length}`);
    }
    assertPrivatePathSafe(result.warnings, 'warnings'); tokens.delete(canonicalId);
    return { id: canonicalId, closed: true as const, ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}) };
  });
}
