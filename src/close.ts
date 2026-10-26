import { commitItemMutations, deriveMutationTransactionId, runWithActiveExtensions } from '@unbrained/pm-cli/sdk';
import type { CommitItemMutationsOptions } from '@unbrained/pm-cli/sdk';
import { readItem } from './inspection.ts';
import { StaleFenceError, withSwarmLease } from './lease.ts';
import { commitItemMutation, assertPrivatePathSafe, SettingsRefusal } from './settings.ts';
import { RESOURCE_TAG } from './resources.ts';
import type { Swarm } from './swarm.ts';

/** Trusted diagnostics observe the SDK's durable boundaries without replacing its mutation steps. */
export interface CloseOptions { onTransition?: CommitItemMutationsOptions['onTransition'] }

/** Finish a fenced claim through the SDK journal, including recovery after ownership was cleared. */
export async function completeClaim(engine: Swarm, id: string, note: string, token: string | undefined, tokens: Map<string, string>, options: CloseOptions): Promise<{ id: string; closed: true }> {
  assertPrivatePathSafe({ id, note, token, author: engine.author });
  if (!note.trim()) throw new Error('close requires a nonempty --note');
  if (token !== undefined && !/^\d+$/.test(token)) throw new StaleFenceError(id);
  return withSwarmLease(engine.pmRoot, engine.author, async lease => {
    const item = (await readItem(engine.client, id)).item;
    assertPrivatePathSafe(item, 'document');
    const canonicalId = String(item.id);
    const selectedToken = token ?? tokens.get(canonicalId);
    const from = selectedToken ?? '0';
    const next = (BigInt(from) + 1n).toString();
    const transactionId = deriveMutationTransactionId(JSON.stringify({ protocol: 'swarm-close/v1', id: canonicalId, author: engine.author, token: from, note }));
    if ((item.tags as string[]).includes(RESOURCE_TAG)) throw new Error('Resource items require swarm resource; close cannot change reservations.');
    const resumed = item.swarm_close_transaction === transactionId && item.swarm_token === next && item.assignee === undefined && item.swarm_handoff === undefined;
    if (!resumed && (item.assignee !== engine.author || (item.swarm_token !== undefined && selectedToken !== item.swarm_token))) throw new StaleFenceError(id);
    const mutations: CommitItemMutationsOptions['mutations'] = [
      { op: 'update', id: canonicalId, match: { key: 'assignee', value: engine.author }, options: { field: [`swarm_token=${next}`, `swarm_close_transaction=${transactionId}`], unset: ['assignee', 'swarm_handoff'] } },
      { op: 'close', id: canonicalId, reason: note },
    ];
    await runWithActiveExtensions({ cwd: engine.repo, path: engine.pmRoot }, () => lease.write(() => commitItemMutation({ id: canonicalId, item, options: { transactionId, author: engine.author, mutations } }, admitted => commitItemMutations({ ...admitted.options, pmRoot: engine.pmRoot, onTransition: options.onTransition }), { transaction: true })));
    const current = (await readItem(engine.client, canonicalId)).item;
    if (current.closed_at === undefined || current.swarm_close_transaction !== transactionId || current.swarm_token !== next || current.assignee !== undefined || current.swarm_handoff !== undefined) throw new SettingsRefusal('swarm_document_changed', 'A peer changed the completed claim; inspect its current document before retrying.', 'document');
    tokens.delete(canonicalId);
    return { id: canonicalId, closed: true };
  });
}
