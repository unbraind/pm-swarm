import { createHash } from 'node:crypto';
import { PmClient, readSettings, resolveAuthor, resolvePmRoot } from '@unbrained/pm-cli/sdk';
import type { GetResult, PmClientOptions } from '@unbrained/pm-cli/sdk';
import { inspectItem, readItem, mutationSnapshot } from './inspection.ts';
import { commitItemMutation, assertPrivatePathSafe, assertSdkInstance, SettingsRefusal, settings } from './settings.ts';

/** Versioned recorded-author comment envelope; ordinary discussion never becomes a witness. */
export const PROGRESS_PREFIX = 'swarm-progress/v2 ';
/** Stable refusal categories for progress consumers. */
export type ProgressRefusalCode = 'progress_invalid' | 'progress_stale' | 'progress_role' | 'progress_prerequisite';
/** A failed progress operation includes the action required to recover. */
export class ProgressRefusal extends Error {
  /** Stable machine-readable refusal reason code. */
  readonly code: ProgressRefusalCode;
  /** Concrete recovery instruction for callers. */
  readonly remedy: string;
  /** Keep diagnostics independent of local storage coordinates. */
  constructor(code: ProgressRefusalCode, remedy: string) {
    super(`${code}: ${remedy}`); this.name = 'ProgressRefusal'; this.code = code; this.remedy = remedy;
  }
}
/** Declared evidence levels; none imply actual execution of linked artifacts. */
export type ProgressStage = 'claimed' | 'produced' | 'reviewed' | 'accepted';
/** One revision-bound declaration stored through the core comment operation. */
export interface ProgressWitness {
  step: string;
  revision: string;
  stage: ProgressStage;
  evidence: string;
}
/** Bounded step projection without raw comments or evidence bodies. */
export interface ProgressStep {
  id: string;
  owner: string | null;
  status: string;
  claimed: boolean;
  produced: boolean;
  reviewed: boolean;
  accepted: boolean;
  reviewers: string[];
}
/** One coherent Plan snapshot, with exact aggregate counts even when rows are paged. */
export interface ProgressView {
  id: string;
  revision: string;
  orchestrator: string | null;
  total: number;
  counts: Record<ProgressStage, number>;
  stale_witnesses: number;
  steps: ProgressStep[];
  offset: number;
  omitted: number;
  next_offset: number | null;
}
/** Optional bounded projection, preserving a stable revision on subsequent pages. */
export interface ProgressOptions {
  agent?: string;
  orchestrator?: string;
  revision?: string;
  offset?: number;
  limit?: number;
}
/** A declaration is a preview unless apply is explicitly true. */
export interface ProgressDeclaration extends ProgressWitness, Omit<ProgressOptions, 'revision'> {
  apply?: boolean;
}
/** Full SDK metadata and body from one item snapshot. */
type PlanSnapshot = GetResult['item'];

/** Hash all substantive Plan inputs while excluding append-only witness discussion. */
function revisionOf(item: PlanSnapshot, orchestrator: string | null): string {
  const inputs = Object.fromEntries(Object.keys(item).sort().filter(key => key.startsWith('plan_') || ['id', 'title', 'description', 'body', 'acceptance_criteria', 'definition_of_ready', 'files', 'tests', 'docs', 'dependencies'].includes(key)).map(key => [key, item[key]]));
  return createHash('sha256').update(JSON.stringify({ inputs, orchestrator })).digest('hex');
}
/** Decode only explicit, well-formed v2 witnesses, failing closed on damaged envelopes. */
function decode(text: string): ProgressWitness | undefined {
  if (!text.startsWith(PROGRESS_PREFIX)) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(text.slice(PROGRESS_PREFIX.length)); } catch { throw new ProgressRefusal('progress_invalid', 'Inspect malformed swarm-progress/v2 comments and correct the declaration.'); }
  if (typeof raw !== 'object' || raw === null) throw new ProgressRefusal('progress_invalid', 'Use a structured swarm-progress/v2 witness.');
  const row = raw as Record<string, unknown>;
  if (typeof row.step !== 'string' || !row.step.trim() || typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/.test(row.revision) || !['claimed', 'produced', 'reviewed', 'accepted'].includes(String(row.stage)) || typeof row.evidence !== 'string' || !row.evidence.trim() || row.evidence.length > 4096) {
    throw new ProgressRefusal('progress_invalid', 'Supply step, 64-character revision, stage and nonempty evidence of at most 4096 characters.');
  }
  return row as unknown as ProgressWitness;
}
/** Validate a proposed witness before any settings read or backend access. */
export function validateProgressWitness(options: ProgressDeclaration): ProgressWitness {
  assertPrivatePathSafe(options);
  return decode(PROGRESS_PREFIX + JSON.stringify({ step: options.step, revision: options.revision, stage: options.stage, evidence: options.evidence }))!;
}
/** Compose parallel Plan progress through native SDK reads and atomic idempotent comments.
 * Actors use the same author resolution as SDK mutations; flags are assertions.
 * Tracker configuration supplies approval authority. Asserted identities need
 * signed provenance to resist adversarial identity or settings changes.
 */
export class PlanProgress {
  /** Host-bound storage client; no local filesystem or Git fallback. */
  readonly client: PmClient;
  /** Tracker root resolved through the same SDK path contract as the client. */
  readonly pmRoot: string;
  /** Explicit SDK author option, never an agent or orchestrator flag. */
  private readonly sdkAuthor: string | undefined;
  /** Reuse the exact host client; legacy boolean hints use normal native activation, never an assumed host scope. */
  constructor(options: PmClientOptions = {}, activeHost: boolean | PmClient = false) {
    this.pmRoot = resolvePmRoot(options.cwd ?? process.cwd(), options.pmRoot);
    this.sdkAuthor = options.author;
    const bound = { ...options, pmRoot: this.pmRoot };
    this.client = typeof activeHost !== 'boolean' ? activeHost : new PmClient(bound);
    assertSdkInstance(this.client);
  }

  /** Resolve the actor exactly as the SDK records mutation history and load tracker authority. */
  private async authority(options: ProgressOptions) {
    const prefs = await readSettings(this.pmRoot);
    const actor = resolveAuthor(this.sdkAuthor, prefs.author_default);
    let config: Awaited<ReturnType<typeof settings>>;
    try { config = await settings(this.pmRoot); } catch { throw new ProgressRefusal('progress_invalid', 'Repair swarm settings and configure progress_orchestrator as one nonempty author identity using swarm settings.'); }
    const orchestrator = config.progress_orchestrator?.trim() ?? null;
    assertPrivatePathSafe({ actor, orchestrator });
    if ((options.agent !== undefined && options.agent !== actor) || (options.orchestrator !== undefined && options.orchestrator !== orchestrator)) throw new ProgressRefusal('progress_role', 'Match --agent to the SDK-recorded author (PM_AUTHOR or SDK author option), and --orchestrator to tracker swarm.progress_orchestrator; flags cannot select either identity.');
    return { actor, orchestrator };
  }

  /** Read complete normalized core Plan metadata without agent output ceilings. */
  private async snapshot(id: string, admit = false) {
    const local = await inspectItem(this.pmRoot, this.pmRoot, id);
    const read = async () => {
      const fresh = await inspectItem(this.pmRoot, this.pmRoot, id);
      return fresh === null ? (await readItem(this.client, id)).item : { ...fresh.item, body: fresh.body };
    };
    const snapshot = admit ? await mutationSnapshot(this.pmRoot, String(local?.item.id ?? id), read) : { item: await read(), historyHead: undefined };
    const item = snapshot.item as PlanSnapshot;
    if (item.type !== 'Plan' || !Array.isArray(item.plan_steps)) throw new ProgressRefusal('progress_invalid', 'Use an existing core Plan item with steps; create or edit it with pm plan.');
    return { ...snapshot, item };
  }

  /** Derive all levels from the same snapshot before applying bounded pagination. */
  private project(item: PlanSnapshot, options: ProgressOptions, orchestrator: string | null): ProgressView {
    const revision = revisionOf(item, orchestrator);
    if (options.revision !== undefined && options.revision !== revision) throw new ProgressRefusal('progress_stale', 'Read progress again and re-evaluate evidence against its current revision.');
    const offset = options.offset ?? 0; const limit = options.limit ?? 20;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProgressRefusal('progress_invalid', 'Use a nonnegative integer --offset and --limit from 1 through 100.');
    const witnesses = (item.comments ?? []).flatMap(comment => {
      const witness = decode(comment.text); return witness === undefined ? [] : [{ ...witness, author: comment.author }];
    });
    const steps = item.plan_steps!.map(step => {
      const current = witnesses.filter(row => row.step === step.id && row.revision === revision);
      const owner = step.owner?.trim() || null;
      const claimed = owner !== null;
      const produced = claimed && Boolean(step.evidence?.trim()) && step.status === 'completed';
      const reviewers = [...new Set(current.filter(row => row.stage === 'reviewed' && row.author !== owner && row.author.trim()).map(row => row.author))].sort();
      const reviewed = produced && reviewers.length > 0;
      const accepted = reviewed && orchestrator !== null && orchestrator !== owner && current.some((row, index) => row.stage === 'accepted' && row.author === orchestrator && !reviewers.includes(orchestrator) && current.slice(0, index).some(prior => prior.stage === 'reviewed' && prior.author !== owner && prior.author.trim()));
      return { id: step.id, owner, status: step.status, claimed, produced, reviewed, accepted, reviewers };
    });
    const counts = { claimed: 0, produced: 0, reviewed: 0, accepted: 0 };
    for (const step of steps) for (const stage of ['claimed', 'produced', 'reviewed', 'accepted'] as const) if (step[stage]) counts[stage]++;
    const next = Math.min(steps.length, offset + limit);
    return { id: item.id, revision, orchestrator, total: steps.length, counts, stale_witnesses: witnesses.filter(row => row.revision !== revision || !steps.some(step => step.id === row.step)).length, steps: steps.slice(offset, next), offset, omitted: steps.length - Math.min(offset, steps.length) - Math.max(0, next - offset), next_offset: next < steps.length ? next : null };
  }

  /** Inspect progress without acquiring writer leases or changing item history. */
  async view(id: string, options: ProgressOptions = {}): Promise<ProgressView> {
    const { orchestrator } = await this.authority(options);
    return this.project((await this.snapshot(id)).item, options, orchestrator);
  }

  /** Preview or explicitly append an attributed declaration; stale races stay stale.
   * The revision travels in the comment, so a criterion edit between the read
   * and atomic append cannot approve the new revision. Concurrent SDK writers
   * preserve one another's comments; no package-local coordination lock is used.
   */
  async witness(id: string, options: ProgressDeclaration): Promise<{ id: string; revision: string; dry_run: boolean; actor: string; witness: ProgressWitness }> {
    return this.witnessRetried(id, options);
  }

  /** Bound native conflict retries while preserving the final typed refusal and all peer evidence. */
  private async witnessRetried(id: string, options: ProgressDeclaration, attempt = 0): ReturnType<PlanProgress['witness']> {
    try { return await this.witnessAttempt(id, options); }
    catch (error) {
      if (error instanceof SettingsRefusal && ['swarm_document_changed', 'swarm_superseded'].includes(error.code) && attempt < 7) return this.witnessRetried(id, options, attempt + 1);
      throw error;
    }
  }

  /** Refresh every role/revision prerequisite after a benign append race; stale evidence and privacy never retry. */
  private async witnessAttempt(id: string, options: ProgressDeclaration): Promise<{ id: string; revision: string; dry_run: boolean; actor: string; witness: ProgressWitness }> {
    assertPrivatePathSafe({ id, options, author: this.sdkAuthor });
    const witness = validateProgressWitness(options);
    const { actor, orchestrator } = await this.authority(options);
    const { item, historyHead } = await this.snapshot(id, options.apply === true);
    const step = item.plan_steps!.find(row => row.id === witness.step);
    if (step === undefined) throw new ProgressRefusal('progress_invalid', 'Use a step id from the current Plan progress view.');
    const view = this.project(item, { ...options, offset: item.plan_steps!.indexOf(step), limit: 1 }, orchestrator);
    const selected = view.steps[0];
    if (witness.stage === 'claimed' || witness.stage === 'produced') {
      if (step.owner !== actor) throw new ProgressRefusal('progress_role', 'Only the declared step owner can report claimed or produced evidence.');
      if (witness.stage === 'produced' && !selected.produced) throw new ProgressRefusal('progress_prerequisite', 'Complete the core Plan step with nonempty evidence before declaring production.');
    } else {
      if (step.owner === actor || (witness.stage === 'accepted' && (view.orchestrator !== actor || selected.reviewers.includes(actor)))) throw new ProgressRefusal('progress_role', 'Use an independent reviewer and the tracker-configured orchestrator for acceptance.');
      if (!selected.produced || (witness.stage === 'accepted' && !selected.reviewed)) throw new ProgressRefusal('progress_prerequisite', 'Production evidence and then an independent review are required before acceptance.');
    }
    if (options.apply === true) await commitItemMutation({ id, options: { add: PROGRESS_PREFIX + JSON.stringify(witness), author: actor, ifAbsent: true }, item }, admitted => this.client.comments(admitted.id, admitted.options), { history: historyHead! });
    return { id: item.id, revision: view.revision, dry_run: options.apply !== true, actor, witness };
  }
}
