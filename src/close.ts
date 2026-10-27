import { commitWorkspaceTransaction, deriveMutationTransactionId, runWithActiveExtensions } from '@unbrained/pm-cli/sdk';
import type { CommitWorkspaceTransactionOptions, WorkspaceTransactionStep } from '@unbrained/pm-cli/sdk';
import { inspectItem, readItem } from './inspection.ts';
import { StaleFenceError, withSwarmLease } from './lease.ts';
import { commitItemMutation, commitMutation, assertPrivatePathSafe, documentFingerprint, SettingsRefusal } from './settings.ts';
import { CLOSE_STEPS, closeCheckpoint, closeConflict, closeSnapshot, closeStepResult, closeTrace } from './close-journal.ts';
import { RESOURCE_TAG } from './resources.ts';
import type { Swarm } from './swarm.ts';

/** Trusted diagnostics observe the SDK's durable boundaries without replacing its mutation steps. */
export interface CloseOptions { onTransition?: CommitWorkspaceTransactionOptions['onTransition'] }

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
  const transactionId = deriveMutationTransactionId(JSON.stringify({ protocol: 'swarm-close/v2', id: canonicalId, author: engine.author, token: from, note }));
  const resumed = item.swarm_close_transaction === transactionId && item.swarm_token === next && item.assignee === undefined && item.swarm_handoff === undefined;
  if (!resumed && (item.assignee !== engine.author || (item.swarm_token !== undefined && selectedToken !== item.swarm_token))) throw new StaleFenceError(canonicalId);
  return { canonicalId, next, transactionId, resumed };
}

/** Finish a fenced claim through the SDK journal, including recovery after ownership was cleared. */
export async function completeClaim(engine: Swarm, id: string, note: string, token: string | undefined, tokens: Map<string, string>, options: CloseOptions): Promise<{ id: string; closed: true }> {
  assertPrivatePathSafe({ id, note, token, author: engine.author });
  if (!note.trim()) throw new Error('close requires a nonempty --note');
  return withSwarmLease(engine.pmRoot, engine.author, async lease => {
    const local = await inspectItem(engine.pmRoot, engine.repo, id);
    if (local !== null) await closeTrace(engine.pmRoot, engine.author, closeIntent(engine, note, token, tokens, { ...local.item, body: local.body }), note);
    const item = (await readItem(engine.client, id)).item;
    const intent = closeIntent(engine, note, token, tokens, item);
    const entryTrace = await closeTrace(engine.pmRoot, engine.author, intent, note);
    const initialExpected = entryTrace.snapshots[0] === undefined ? item : { ...entryTrace.snapshots[0].document.metadata, body: entryTrace.snapshots[0].document.body };
    const { canonicalId, next, transactionId } = intent;
    /** Read only the exact plan and native versions owned by the SDK journal. */
    const trace = () => closeTrace(engine.pmRoot, engine.author, { ...intent, resumed: false }, note);
    const steps: WorkspaceTransactionStep[] = CLOSE_STEPS.map((step, index) => ({
      id: step,
      async inspect() {
        const state = await trace();
        const applied = index === 0 ? state.phase > 0 && state.phase < 4 : state.phase === 2;
        return { state: applied ? 'applied' : 'pending', ...(applied ? { result: closeStepResult(state.snapshots[index + 1]) } : {}) };
      },
      async prepareCompensation() {
        const state = await trace(); const snapshot = await closeSnapshot(engine.pmRoot, canonicalId);
        const expected = index === 0 ? initialExpected : { ...state.snapshots[1].document.metadata, body: state.snapshots[1].document.body };
        if (documentFingerprint({ ...snapshot.document.metadata, body: snapshot.document.body }) !== documentFingerprint(expected)) closeConflict();
        assertPrivatePathSafe(snapshot.document, 'document');
        return commitMutation(closeStepResult(snapshot), admitted => admitted);
      },
      async apply() {
        const state = await trace();
        const checkpoint = closeCheckpoint(state.journal?.compensationData[step]);
        const before = await closeSnapshot(engine.pmRoot, canonicalId, checkpoint.version);
        const document = { ...before.document.metadata, body: before.document.body };
        if (index === 0) await lease.write(() => commitItemMutation({ id: canonicalId, item: document, options: { author: engine.author, message: 'Swarm close metadata', field: [`swarm_token=${next}`, `swarm_close_transaction=${transactionId}`], unset: ['assignee', 'swarm_handoff'] } }, admitted => engine.client.update(admitted.id, admitted.options), { beforeWrite: async () => { await trace(); } }));
        else await lease.write(() => commitItemMutation({ id: canonicalId, item: document, note, options: { author: engine.author, message: 'Swarm close completion' } }, admitted => engine.client.close(admitted.id, admitted.note, admitted.options), { beforeWrite: async () => { await trace(); } }));
        const after = await closeSnapshot(engine.pmRoot, canonicalId, checkpoint.version + 1);
        return closeStepResult(after);
      },
      async compensate(data) {
        const checkpoint = closeCheckpoint(data); const state = await trace();
        const current = state.snapshots.at(-1)!;
        await lease.write(() => commitItemMutation({ id: canonicalId, item: { ...current.document.metadata, body: current.document.body }, target: String(checkpoint.version), options: { author: engine.author, force: true, message: 'Swarm close compensation' } }, admitted => engine.client.restore(admitted.id, admitted.target, admitted.options), { beforeWrite: async () => { await trace(); } }));
      },
    }));
    try {
      await runWithActiveExtensions({ cwd: engine.repo, path: engine.pmRoot }, () => commitItemMutation({ id: canonicalId, item, options: { transactionId, author: engine.author, steps } }, admitted => commitWorkspaceTransaction({ ...admitted.options, pmRoot: engine.pmRoot, onTransition: options.onTransition }), { transaction: true }));
    } catch (error) {
      if (error instanceof AggregateError) {
        const refusal = error.errors.find((failure: unknown) => failure instanceof SettingsRefusal);
        if (refusal !== undefined) throw refusal;
      }
      throw error;
    }
    const current = (await readItem(engine.client, canonicalId)).item;
    if (current.closed_at === undefined || current.swarm_close_transaction !== transactionId || current.swarm_token !== next || current.assignee !== undefined || current.swarm_handoff !== undefined) throw new SettingsRefusal('swarm_document_changed', 'A peer changed the completed claim; inspect its current document before retrying.', 'document');
    tokens.delete(canonicalId);
    return { id: canonicalId, closed: true };
  });
}
