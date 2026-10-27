import { commitWorkspaceTransaction, deriveMutationTransactionId, runWithActiveExtensions } from '@unbrained/pm-cli/sdk';
import type { CommitWorkspaceTransactionOptions, WorkspaceTransactionStep } from '@unbrained/pm-cli/sdk';
import { inspectItem, readItem, mutationSnapshot } from './inspection.ts';
import { StaleFenceError, withSwarmLease } from './lease.ts';
import { commitItemMutation, commitMutation, assertPrivatePathSafe, documentFingerprint, SettingsRefusal, assertClaimGeneration, assertItemHistoryHead } from './settings.ts';
import { CLOSE_STEPS, closeCheckpoint, closeConflict, closeSnapshot, closeStepResult, closeTrace, closeWarnings, closeWarningsUnavailable, closeEffects, closeDocumentHash } from './close-journal.ts';
import { requirePrimaryOnlyCompensation, CompensationPartialRefusal } from './close-compensation.ts';
import { RESOURCE_TAG } from './resources.ts';
import type { CloseEffect, CloseSnapshot } from './close-journal.ts';
import type { ItemHistoryHead } from './settings.ts';
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
export async function completeClaim(engine: Swarm, id: string, note: string, token: string | undefined, tokens: Map<string, string>, options: CloseOptions): Promise<{ id: string; closed: true; warnings?: string[]; warnings_unavailable?: true; required?: string }> {
  assertPrivatePathSafe({ id, note, token, author: engine.author });
  if (!note.trim()) throw new Error('close requires a nonempty --note');
  return withSwarmLease(engine.pmRoot, engine.author, async lease => {
    const local = await inspectItem(engine.pmRoot, engine.repo, id);
    if (local !== null) await closeTrace(engine.pmRoot, engine.author, closeIntent(engine, note, token, tokens, { ...local.item, body: local.body }), note);
    const admission = await mutationSnapshot(engine.pmRoot, String(local?.item.id ?? id), async () => (await readItem(engine.client, id)).item); const item = admission.item;
    const intent = closeIntent(engine, note, token, tokens, item);
    const entryTrace = await closeTrace(engine.pmRoot, engine.author, intent, note);
    if (entryTrace.journal?.status === 'compensating' && entryTrace.phase >= 2) await requirePrimaryOnlyCompensation(engine.pmRoot, intent.canonicalId, intent.transactionId, entryTrace.journal.results.close, entryTrace.journal.compensationData.close ?? entryTrace.journal.compensationData.metadata);
    const initialExpected = entryTrace.snapshots[0] === undefined ? item : { ...entryTrace.snapshots[0].document.metadata, body: entryTrace.snapshots[0].document.body };
    const { canonicalId, next, transactionId } = intent;
    // Core alone selects dependents; capture their admission domain before the first journal/item write.
    const relatedSnapshots = new Map<string, CloseSnapshot>();
    const related = new Map<string, { item: Record<string, unknown>; history: ItemHistoryHead }>();
    if (entryTrace.phase !== 2 || entryTrace.journal?.status === 'compensating') for (const row of (await engine.corpus()).items) if (row.id !== canonicalId) {
      try {
        const snapshot = await closeSnapshot(engine.pmRoot, row.id);
        relatedSnapshots.set(row.id, snapshot);
        related.set(row.id, { item: { ...snapshot.document.metadata, body: snapshot.document.body }, history: snapshot.historyHead });
      } catch { /* Foreign unreadable rows stay unadmitted; native close reports any affected dependent. */ }
    }
    let expectedHistory = admission.historyHead;
    let observedEffects: CloseEffect[] | undefined;
    /** Read only the exact plan and native versions owned by the SDK journal. */
    const trace = async () => {
      await assertItemHistoryHead(engine.pmRoot, canonicalId, expectedHistory);
      try { return await closeTrace(engine.pmRoot, engine.author, { ...intent, resumed: false }, note); }
      catch (error) { await assertItemHistoryHead(engine.pmRoot, canonicalId, expectedHistory); throw error; }
    };
    const steps: WorkspaceTransactionStep[] = CLOSE_STEPS.map((step, index) => ({
      id: step,
      async inspect() {
        const state = await trace();
        const applied = index === 0 ? state.phase > 0 && state.phase < 4 : state.phase === 2;
        return { state: applied ? 'applied' : 'pending', ...(applied ? { result: index === 0 ? closeStepResult(state.snapshots[1]) : closeStepResult(state.snapshots[2], closeWarnings(state.journal?.results.close), closeWarningsUnavailable(state.journal?.results.close), closeEffects(state.journal?.results.close)) } : {}) };
      },
      async prepareCompensation() {
        const state = await trace(); const snapshot = await closeSnapshot(engine.pmRoot, canonicalId);
        const expected = index === 0 ? initialExpected : { ...state.snapshots[1].document.metadata, body: state.snapshots[1].document.body };
        if (documentFingerprint({ ...snapshot.document.metadata, body: snapshot.document.body }) !== documentFingerprint(expected)) closeConflict();
        assertPrivatePathSafe(snapshot.document, 'document');
        const domain = [...relatedSnapshots].map(([id, value]) => {
          const point = { version: value.version, hash: value.hash, historyHead: value.historyHead };
          return { id, before: point, after: point };
        });
        return commitMutation(closeStepResult(snapshot, undefined, false, domain), admitted => admitted);
      },
      async apply() {
        const state = await trace();
        const checkpoint = closeCheckpoint(state.journal?.compensationData[step]);
        const before = await closeSnapshot(engine.pmRoot, canonicalId, checkpoint.version);
        const document = { ...before.document.metadata, body: before.document.body };
        let warnings: string[] = [];
        const written = new Map<string, string>();
        if (index === 0) {
          let committedHash: string | undefined;
          try {
            await lease.write(() => commitItemMutation({ id: canonicalId, item: document, options: { author: engine.author, message: 'Swarm close metadata', field: [`swarm_token=${next}`, `swarm_close_transaction=${transactionId}`], unset: ['assignee', 'swarm_handoff'] } }, admitted => engine.client.update(admitted.id, admitted.options), { transaction: true, history: expectedHistory, onCommitted: (_before, after) => { committedHash = closeDocumentHash(after); }, beforeWrite: async () => { await trace(); } }));
          } finally {
            if (committedHash !== undefined) {
              const written = await closeSnapshot(engine.pmRoot, canonicalId, checkpoint.version + 1);
              if (written.hash !== committedHash) closeConflict('The metadata read-back does not match its admitted write.');
              expectedHistory = written.historyHead;
            }
          }
        }
        else {
          try {
            const result = await lease.write(() => commitItemMutation({ id: canonicalId, item: document, note, options: { author: engine.author, message: 'Swarm close completion' } }, admitted => engine.client.close(admitted.id, admitted.note, admitted.options), { transaction: true, history: expectedHistory, related, onCommitted: (_before, after) => { written.set(after.metadata.id, closeDocumentHash(after)); }, beforeWrite: async () => { await trace(); } }));
            warnings = result.warnings;
          } finally {
            const collected: CloseEffect[] = [];
            for (const [id, hash] of written) {
              if (id === canonicalId) continue;
              const before = relatedSnapshots.get(id)!;
              const after = await closeSnapshot(engine.pmRoot, id, before.version + 1);
              if (after.hash !== hash) closeConflict('The native dependent read-back does not match its admitted write.');
              collected.push({ id, before: { version: before.version, hash: before.hash, historyHead: before.historyHead }, after: { version: after.version, hash: after.hash, historyHead: after.historyHead } });
            }
            if (written.has(canonicalId)) {
              const primary = await closeSnapshot(engine.pmRoot, canonicalId, checkpoint.version + 1);
              if (primary.hash !== written.get(canonicalId)) closeConflict('The native close read-back does not match its admitted write.');
              expectedHistory = primary.historyHead;
            }
            observedEffects = collected;
          }
        }
        const after = await closeSnapshot(engine.pmRoot, canonicalId, checkpoint.version + 1);
        expectedHistory = after.historyHead;
        return index === 0 ? closeStepResult(after) : closeStepResult(after, warnings, false, observedEffects);
      },
      async compensate(data) {
        const checkpoint = closeCheckpoint(data); const latest = await closeSnapshot(engine.pmRoot, canonicalId);
        // Both the forward generation and an already restored original can belong to this SDK journal.
        if (latest.document.metadata.swarm_token !== initialExpected.swarm_token) assertClaimGeneration(latest.document.metadata.swarm_token, next);
        const state = await trace();
        const current = state.snapshots.at(-1)!;
        if (state.phase >= 2) await requirePrimaryOnlyCompensation(engine.pmRoot, canonicalId, transactionId, state.journal?.results.close, state.journal?.compensationData.close ?? state.journal?.compensationData.metadata, observedEffects);
        await lease.write(() => commitItemMutation({ id: canonicalId, item: { ...current.document.metadata, body: current.document.body }, target: String(checkpoint.version), options: { author: engine.author, force: true, message: 'Swarm close compensation' } }, admitted => engine.client.restore(admitted.id, admitted.target, admitted.options), { transaction: true, generation: { token: current.document.metadata.swarm_token }, history: current.historyHead, beforeWrite: async () => { await trace(); } }));
        expectedHistory = (await closeSnapshot(engine.pmRoot, canonicalId, current.version + 1)).historyHead;
      },
    }));
    let warnings: string[] = []; let unavailable = false;
    try {
      const result = await runWithActiveExtensions({ cwd: engine.repo, path: engine.pmRoot }, () => commitItemMutation({ id: canonicalId, item, options: { transactionId, author: engine.author, steps } }, admitted => commitWorkspaceTransaction({ ...admitted.options, pmRoot: engine.pmRoot, onTransition: options.onTransition }), { transaction: true, history: admission.historyHead }));
      warnings = closeWarnings(result.results.close); unavailable = closeWarningsUnavailable(result.results.close);
    } catch (error) {
      if (error instanceof AggregateError) {
        const refusal = error.errors.find((failure: unknown) => failure instanceof CompensationPartialRefusal) ?? error.errors.find((failure: unknown) => failure instanceof SettingsRefusal);
        if (refusal !== undefined) throw refusal;
      }
      throw error;
    }
    const current = (await readItem(engine.client, canonicalId)).item;
    if (current.closed_at === undefined || current.swarm_close_transaction !== transactionId || current.swarm_token !== next || current.assignee !== undefined || current.swarm_handoff !== undefined) throw new SettingsRefusal('swarm_document_changed', 'A peer changed the completed claim; inspect its current document before retrying.', 'document');
    tokens.delete(canonicalId);
    return { id: canonicalId, closed: true, ...(warnings.length > 0 ? { warnings } : {}), ...(unavailable ? { warnings_unavailable: true as const, required: 'Inspect dependent items: close completed before its dependency warnings were saved.' } : {}) };
  });
}
