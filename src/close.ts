import { commitItemMutations, deriveMutationTransactionId, getHistoryPath, readHistoryEntries, runWithActiveExtensions } from '@unbrained/pm-cli/sdk';
import type { CommitItemMutationsOptions } from '@unbrained/pm-cli/sdk';
import { inspectItem, readItem } from './inspection.ts';
import { StaleFenceError, withSwarmLease } from './lease.ts';
import { commitItemMutation, assertPrivatePathSafe, SettingsRefusal } from './settings.ts';
import { RESOURCE_TAG } from './resources.ts';
import type { Swarm } from './swarm.ts';

/** Trusted diagnostics observe the SDK's durable boundaries without replacing its mutation steps. */
export interface CloseOptions { onTransition?: CommitItemMutationsOptions['onTransition'] }

/** Decide identical local-preflight and fresh native snapshots without recording SDK usage or a journal. */
function closeIntent(engine: Swarm, note: string, token: string | undefined, tokens: ReadonlyMap<string, string>, item: Record<string, unknown>) {
  assertPrivatePathSafe(item, 'document');
  const canonicalId = String(item.id);
  if ((item.tags as string[]).includes(RESOURCE_TAG)) throw new Error('Resource items require swarm resource; close cannot change reservations.');
  if (item.swarm_token !== undefined && !/^\d+$/.test(String(item.swarm_token))) throw new Error(`Item ${canonicalId} has a malformed swarm_token; repair it before changing ownership`);
  const selectedToken = token ?? tokens.get(canonicalId);
  if (selectedToken !== undefined && !/^\d+$/.test(selectedToken)) throw new StaleFenceError(canonicalId);
  const from = selectedToken ?? '0';
  const next = (BigInt(from) + 1n).toString();
  const transactionId = deriveMutationTransactionId(JSON.stringify({ protocol: 'swarm-close/v1', id: canonicalId, author: engine.author, token: from, note }));
  const resumed = item.swarm_close_transaction === transactionId && item.swarm_token === next && item.assignee === undefined && item.swarm_handoff === undefined;
  if (!resumed && (item.assignee !== engine.author || (item.swarm_token !== undefined && selectedToken !== item.swarm_token))) throw new StaleFenceError(canonicalId);
  return { canonicalId, next, transactionId, resumed };
}

/** Adopt only the coordinator's latest owned history receipt, never a peer-edited compensation baseline. */
async function checkCloseReceipt(engine: Swarm, intent: ReturnType<typeof closeIntent>): Promise<void> {
  if (!intent.resumed) return;
  let history: Awaited<ReturnType<typeof readHistoryEntries>>;
  try { history = await readHistoryEntries(getHistoryPath(engine.pmRoot, intent.canonicalId), intent.canonicalId); }
  catch { throw new SettingsRefusal('swarm_document_changed', 'The close history could not be verified; preserve the item and inspect its history before retrying.', 'document'); }
  const owned = history.slice(-1).some(entry => entry.author === engine.author
    && entry.message?.startsWith(`bulk-item-transaction ${intent.transactionId} `) === true
    && ['update', 'close', 'restore'].includes(entry.op));
  if (!owned) throw new SettingsRefusal('swarm_document_changed', 'A peer changed the interrupted close; preserve its current document and reconcile the ownership explicitly before starting another close.', 'document');
}

/** Finish a fenced claim through the SDK journal, including recovery after ownership was cleared. */
export async function completeClaim(engine: Swarm, id: string, note: string, token: string | undefined, tokens: Map<string, string>, options: CloseOptions): Promise<{ id: string; closed: true }> {
  assertPrivatePathSafe({ id, note, token, author: engine.author });
  if (!note.trim()) throw new Error('close requires a nonempty --note');
  return withSwarmLease(engine.pmRoot, engine.author, async lease => {
    const local = await inspectItem(engine.pmRoot, engine.repo, id);
    if (local !== null) await checkCloseReceipt(engine, closeIntent(engine, note, token, tokens, { ...local.item, body: local.body }));
    const item = (await readItem(engine.client, id)).item;
    const intent = closeIntent(engine, note, token, tokens, item);
    await checkCloseReceipt(engine, intent);
    const { canonicalId, next, transactionId } = intent;
    const mutations: CommitItemMutationsOptions['mutations'] = [
      { op: 'update', id: canonicalId, match: { key: 'assignee', value: engine.author }, options: { field: [`swarm_token=${next}`, `swarm_close_transaction=${transactionId}`], unset: ['assignee', 'swarm_handoff'] } },
      { op: 'close', id: canonicalId, reason: note },
    ];
    await runWithActiveExtensions({ cwd: engine.repo, path: engine.pmRoot }, () => lease.write(() => commitItemMutation({ id: canonicalId, item, options: { transactionId, author: engine.author, mutations } }, admitted => commitItemMutations({ ...admitted.options, pmRoot: engine.pmRoot, onTransition: options.onTransition }), { transaction: true, beforeWrite: () => checkCloseReceipt(engine, intent) })));
    const current = (await readItem(engine.client, canonicalId)).item;
    if (current.closed_at === undefined || current.swarm_close_transaction !== transactionId || current.swarm_token !== next || current.assignee !== undefined || current.swarm_handoff !== undefined) throw new SettingsRefusal('swarm_document_changed', 'A peer changed the completed claim; inspect its current document before retrying.', 'document');
    tokens.delete(canonicalId);
    return { id: canonicalId, closed: true };
  });
}
