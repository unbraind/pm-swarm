import { createPublicKey, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createExtensionCommandSdk, deriveMutationTransactionId, getHistoryPath, getSettingsPath, hashDocument } from '@unbrained/pm-cli/sdk';
import type { ItemDocument } from '@unbrained/pm-cli/sdk';
import type { Swarm } from './swarm.ts';
import type { CloseJournal } from './close-journal.ts';
import type { ItemHistoryHead } from './settings.ts';
import { assertPrivatePathSafe, commitMutation, rawDocument, sectionOf, SettingsRefusal, syncNativeArtifacts } from './settings.ts';

/** Exact native proposal observed under its item writer lock, before persistence. */
export interface CloseProposal { compensation_id: string; id: string; operation: string; before: ItemHistoryHead; before_hash: string; after_hash: string }
/** Publicly verifiable own-write proof; the signing key exists only during the fresh forward call. */
export interface SignedCloseProposal { proposal: CloseProposal; signature: string }
/** Bind each signature to the protocol, target, native revision and exact proposed document. */
function proposalBytes(proposal: CloseProposal): Buffer { return Buffer.from(JSON.stringify(['swarm-native-proposal/v1', proposal.compensation_id, proposal.id, proposal.operation, proposal.before.length, proposal.before.hash, proposal.before_hash, proposal.after_hash])); }
/** Verify one domain-separated signed payload against the immutable original public key. */
function verifiedPayload(journal: CloseJournal, bytes: Buffer, signature: unknown): boolean {
  try {
    return typeof signature === 'string' && /^[a-f0-9]{128}$/.test(signature)
      && verify(null, bytes, createPublicKey({ key: Buffer.from(journal.public_key, 'hex'), format: 'der', type: 'spki' }), Buffer.from(signature, 'hex'));
  } catch { return false; }
}
/** A caller-declared episode cannot manufacture an Ed25519 proof for a different native mutation. */
export function validCloseProposal(journal: CloseJournal, proof: SignedCloseProposal): boolean {
  try { return proof.proposal.compensation_id === journal.compensation_id && verifiedPayload(journal, proposalBytes(proof.proposal), proof.signature); }
  catch { return false; }
}
/** Bind the terminal result to every immutable plan, actual post-head, proposal and returned warning. */
function resultBytes(journal: CloseJournal): Buffer {
  const { result_signature: _signature, ...record } = journal;
  return Buffer.from(JSON.stringify(['swarm-close-result/v1', record]));
}
/** Only the fresh invocation that observed the complete native return can certify successful completion. */
export function signCloseResult(journal: CloseJournal, key: KeyObject): string { return sign(null, resultBytes(journal), key).toString('hex'); }
/** Copied phases and caller episodes never substitute for the original invocation's result signature. */
export function validCloseResult(journal: CloseJournal): boolean { return journal.phase === 'committed' && verifiedPayload(journal, resultBytes(journal), journal.result_signature); }
/** Read only the owned audited ledger, preserving all other settings and concurrent close identities. */
function proofStore(raw: Record<string, unknown>): { section: Record<string, unknown>; records: Map<string, SignedCloseProposal[]> } {
  const section = sectionOf(raw);
  const values = section.close_proofs === undefined ? {} : section.close_proofs;
  if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new SettingsRefusal('swarm_settings_invalid', 'Preserve and inspect the native close proof ledger before retrying.');
  return { section, records: new Map(Object.entries(values)) as Map<string, SignedCloseProposal[]> };
}
/** Reuse the locked writer's admission before preparing a fresh durable close intent. */
export function admitCloseProofSettings(raw: Record<string, unknown>): void { proofStore(raw); assertPrivatePathSafe(raw, 'settings'); }
/** Apply one audited native settings mutation through the exact bound host client. */
async function mutateProofStore(engine: Swarm, journal: CloseJournal, proof?: SignedCloseProposal): Promise<void> {
  const sdk = createExtensionCommandSdk(engine.pmRoot, engine.client, engine.author, 'swarm close');
  const operationId = deriveMutationTransactionId(JSON.stringify([journal.compensation_id, proof?.signature ?? 'retire-proposals']));
  await commitMutation({ operationId, proof }, admitted => sdk.mutateWorkspaceSettings({ operationId: admitted.operationId, replaceSubtrees: ['swarm'], mutate: async current => {
    const raw = await rawDocument(engine.pmRoot); admitCloseProofSettings(raw); const store = proofStore(raw);
    const previous = store.records.get(journal.compensation_id) ?? [];
    if (!Array.isArray(previous) || previous.some(value => !validCloseProposal(journal, value))) throw new SettingsRefusal('swarm_compensation_partial', 'The native close proof ledger was superseded; preserve it for explicit inspection.', 'close');
    if (admitted.proof === undefined) store.records.delete(journal.compensation_id);
    else store.records.set(journal.compensation_id, [...previous, admitted.proof]);
    const { close_proofs: _retired, ...section } = store.section;
    const swarm = { ...section, ...(store.records.size > 0 ? { close_proofs: Object.fromEntries(store.records) } : {}) };
    const patch = { ...current, swarm }; assertPrivatePathSafe({ ...raw, swarm }, 'settings');
    return commitMutation(patch, admitted => admitted);
  } }));
  await syncNativeArtifacts([getSettingsPath(engine.pmRoot), getHistoryPath(engine.pmRoot, '_workspace')]);
}
/** Persist the exact SDK proposal before its item commit; no document or history is predicted or replaced. */
export async function recordCloseProposal(engine: Swarm, journal: CloseJournal, key: KeyObject, before: ItemDocument, after: ItemDocument, operation: string, history: ItemHistoryHead): Promise<void> {
  const proposal: CloseProposal = { compensation_id: journal.compensation_id, id: String(before.metadata.id), operation, before: history, before_hash: hashDocument(before), after_hash: hashDocument(after) };
  await mutateProofStore(engine, journal, { proposal, signature: sign(null, proposalBytes(proposal), key).toString('hex') });
}
/** Pending forward work loads signed proposals from native workspace history-backed settings. */
export async function loadCloseProposals(engine: Swarm, journal: CloseJournal): Promise<SignedCloseProposal[]> {
  const pending = journal.phase === 'applying' ? proofStore(await rawDocument(engine.pmRoot)).records.get(journal.compensation_id) ?? [] : [];
  if (!Array.isArray(pending)) throw new SettingsRefusal('swarm_compensation_partial', 'The native close proposal ledger is malformed; preserve its workspace audit history.', 'close');
  const proofs = Array.isArray(journal.proofs) ? [...journal.proofs, ...pending] : journal.proofs;
  if (!Array.isArray(proofs) || proofs.some(proof => !validCloseProposal(journal, proof))) throw new SettingsRefusal('swarm_compensation_partial', 'Native close proposals cannot be verified; preserve their item and workspace audit history.', 'close');
  return [...new Map(proofs.map(proof => [proof.signature, proof])).values()];
}
/** Retire only this run's valid signed cache after its complete proposals are retained by native item history. */
export async function retireCloseProposals(engine: Swarm, journal: CloseJournal): Promise<void> {
  if (!proofStore(await rawDocument(engine.pmRoot)).records.has(journal.compensation_id)) return;
  await mutateProofStore(engine, journal);
}
