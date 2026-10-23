import { createHash } from 'node:crypto';
import { resolveClaimPrincipal } from '@unbrained/pm-cli/sdk';
import type { GetResult, PmClient } from '@unbrained/pm-cli/sdk';

/** Versioned comment envelope; ordinary discussion never becomes a witness. */
export const PROGRESS_PREFIX = 'swarm-progress/v1 ';
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
function revisionOf(item: PlanSnapshot): string {
  const inputs = Object.fromEntries(Object.keys(item).sort().filter(key => key.startsWith('plan_') || ['id', 'title', 'description', 'body', 'acceptance_criteria', 'definition_of_ready', 'files', 'tests', 'docs', 'dependencies'].includes(key)).map(key => [key, item[key]]));
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}
/** Decode only explicit, well-formed v1 witnesses, failing closed on damaged envelopes. */
function decode(text: string): ProgressWitness | undefined {
  if (!text.startsWith(PROGRESS_PREFIX)) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(text.slice(PROGRESS_PREFIX.length)); } catch { throw new ProgressRefusal('progress_invalid', 'Inspect malformed swarm-progress/v1 comments and correct the declaration.'); }
  if (typeof raw !== 'object' || raw === null) throw new ProgressRefusal('progress_invalid', 'Use a structured swarm-progress/v1 witness.');
  const row = raw as Record<string, unknown>;
  if (typeof row.step !== 'string' || !row.step.trim() || typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/.test(row.revision) || !['claimed', 'produced', 'reviewed', 'accepted'].includes(String(row.stage)) || typeof row.evidence !== 'string' || !row.evidence.trim() || row.evidence.length > 4096) {
    throw new ProgressRefusal('progress_invalid', 'Supply step, 64-character revision, stage and nonempty evidence of at most 4096 characters.');
  }
  return row as unknown as ProgressWitness;
}
/** Compose parallel Plan progress through native SDK reads and atomic idempotent comments.
 * Author identifiers are tracker provenance, not authentication. The embedding
 * orchestrator must control the trusted identity passed on each read.
 */
export class PlanProgress {
  /** Host-bound storage client; no local filesystem or Git fallback. */
  readonly client: PmClient;
  /** Principal recorded by the SDK comment mutation. */
  readonly author: string;
  /** Reuse the host SDK, including storage-provider dispatch and extension schema. */
  constructor(client: PmClient, author: string) { this.client = client; this.author = resolveClaimPrincipal(author); }

  /** Read complete normalized core Plan metadata without agent output ceilings. */
  private async snapshot(id: string): Promise<PlanSnapshot> {
    // Unbounded SDK reads cannot produce the budget-omission union member.
    const result = await this.client.get(id, { depth: 'full', outputBudget: 'unbounded', outputLimit: 'unbounded' }) as GetResult;
    if (result.item.type !== 'Plan' || !Array.isArray(result.item.plan_steps)) throw new ProgressRefusal('progress_invalid', 'Use an existing core Plan item with steps; create or edit it with pm plan.');
    return result.item;
  }

  /** Derive all levels from the same snapshot before applying bounded pagination. */
  private project(item: PlanSnapshot, options: ProgressOptions): ProgressView {
    const revision = revisionOf(item);
    if (options.revision !== undefined && options.revision !== revision) throw new ProgressRefusal('progress_stale', 'Read progress again and re-evaluate evidence against its current revision.');
    const offset = options.offset ?? 0; const limit = options.limit ?? 20;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProgressRefusal('progress_invalid', 'Use a nonnegative integer --offset and --limit from 1 through 100.');
    const orchestrator = options.orchestrator === undefined ? null : resolveClaimPrincipal(options.orchestrator);
    const witnesses = item.comments!.flatMap(comment => {
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
  async view(id: string, options: ProgressOptions = {}): Promise<ProgressView> { return this.project(await this.snapshot(id), options); }

  /** Preview or explicitly append an attributed declaration; stale races stay stale.
   * The revision travels in the comment, so a criterion edit between the read
   * and atomic append cannot approve the new revision. Concurrent SDK writers
   * preserve one another's comments; no package-local coordination lock is used.
   */
  async witness(id: string, options: ProgressDeclaration): Promise<{ id: string; revision: string; dry_run: boolean; witness: ProgressWitness }> {
    const witness = decode(PROGRESS_PREFIX + JSON.stringify({ step: options.step, revision: options.revision, stage: options.stage, evidence: options.evidence }))!;
    const item = await this.snapshot(id);
    const step = item.plan_steps!.find(row => row.id === witness.step);
    if (step === undefined) throw new ProgressRefusal('progress_invalid', 'Use a step id from the current Plan progress view.');
    const view = this.project(item, { ...options, offset: item.plan_steps!.indexOf(step), limit: 1 });
    const selected = view.steps[0];
    if (witness.stage === 'claimed' || witness.stage === 'produced') {
      if (step.owner !== this.author) throw new ProgressRefusal('progress_role', 'Only the declared step owner can report claimed or produced evidence.');
      if (witness.stage === 'produced' && !selected.produced) throw new ProgressRefusal('progress_prerequisite', 'Complete the core Plan step with nonempty evidence before declaring production.');
    } else {
      if (step.owner === this.author || (witness.stage === 'accepted' && (view.orchestrator !== this.author || selected.reviewers.includes(this.author)))) throw new ProgressRefusal('progress_role', 'Use an independent reviewer and a distinct explicitly named --orchestrator for acceptance.');
      if (!selected.produced || (witness.stage === 'accepted' && !selected.reviewed)) throw new ProgressRefusal('progress_prerequisite', 'Production evidence and then an independent review are required before acceptance.');
    }
    if (options.apply === true) await this.client.comments(id, { add: PROGRESS_PREFIX + JSON.stringify(witness), author: this.author, ifAbsent: true });
    return { id: item.id, revision: view.revision, dry_run: options.apply !== true, witness };
  }
}
