import { assertPrivatePathSafe } from './settings.ts';
import { discoverExtensions, readSettings } from '@unbrained/pm-cli/sdk';
import { selectNext } from './selection.ts';
import type { ActiveFootprint, RankedCandidate } from './selection.ts';

/** Stable policy failures shared by SDK and CLI callers. */
export type SchedulingRefusalCode = 'schedule_invalid' | 'schedule_skills' | 'schedule_backend_refused';

/** Actionable refusal; never silently weakens skills or coordination. */
export class SchedulingRefusal extends Error {
  /** Stable machine-readable category. */
  readonly code: SchedulingRefusalCode;
  /** Concrete instruction for recovering from this refusal. */
  readonly remedy: string;
  /** Retain only the bounded public diagnostic. */
  constructor(code: SchedulingRefusalCode, remedy: string) {
    super(`${code}: ${remedy}`); this.name = 'SchedulingRefusal'; this.code = code; this.remedy = remedy;
  }
}

/** Opt-in assignment policy, with an injectable clock for repeatable decisions. */
export interface ScheduleOptions {
  skills: readonly string[];
  maxWaitSeconds?: number;
  now?: string;
  limit?: number;
  parent?: string;
  dryRun?: boolean;
}

/** Minimal item metadata; readiness and ownership remain SDK responsibilities. */
export interface SchedulingItem {
  id: string;
  tags: readonly string[];
  swarm_preferred_agent?: unknown;
  swarm_handoff_cost?: unknown;
}

/** Bounded explanation of one ready candidate's policy evaluation. */
export interface SchedulingDecision {
  id: string;
  state: 'selected' | 'skills' | 'conflict' | 'rank' | 'unknown';
  age_seconds: number;
  starved: boolean;
  handoff_cost: number;
  missing_skills: string[];
}

/** Compact assignment receipt, identical for TOON and JSON. */
export interface ScheduleReceipt {
  selected: string | null;
  agent: string;
  dry_run: boolean;
  reason: string;
  now: string;
  max_wait_seconds: number;
  counts: { ready: number; qualified: number; conflicts: number; starved: number };
  decisions: SchedulingDecision[];
  omitted: number;
  warnings: string[];
  token?: string;
  context?: Record<string, unknown>;
  mode?: string;
  worktree?: string;
  branch?: string;
}

/** Common projection of the existing next engines; no second claim implementation. */
interface NextReceipt {
  selected: string | null;
  reason: string;
  warnings: string[];
  token?: string;
  context?: Record<string, unknown>;
  mode?: string;
  worktree?: string;
  branch?: string;
}

/** Keep accepted skill declarations small and portable. */
function validSkill(value: string): boolean { return /^[a-zA-Z0-9_.-]{1,64}$/.test(value); }

/** Validate and rank inside the existing next operation's claim lease. */
export class FairPolicy {
  /** Canonical caller skills. */
  readonly skills: Set<string>;
  /** Frozen clock shared by every candidate in this invocation. */
  readonly now: string;
  /** Starvation promotion threshold in seconds. */
  readonly maxWait: number;
  /** Maximum returned decision rows. */
  readonly limit: number;
  /** Caller whose continuity discount is evaluated. */
  readonly author: string;
  /** Full policy evaluation retained only until bounded projection. */
  private decisions: SchedulingDecision[] = [];
  /** Exact counts, independent of output truncation. */
  private counts = { ready: 0, qualified: 0, conflicts: 0, starved: 0 };

  /** Freeze and validate policy inputs before reading or claiming work. */
  constructor(author: string, options: ScheduleOptions) {
    if (!Array.isArray(options.skills) || options.skills.length > 64 || options.skills.some(skill => typeof skill !== 'string' || !validSkill(skill))) {
      throw new SchedulingRefusal('schedule_invalid', 'Supply at most 64 skills using letters, digits, underscore, dot or dash; use an empty list for unskilled work.');
    }
    this.skills = new Set(options.skills); this.author = author;
    this.maxWait = options.maxWaitSeconds ?? 86400; this.limit = options.limit ?? 20;
    if (!Number.isInteger(this.maxWait) || this.maxWait < 1 || this.maxWait > 31536000 || !Number.isInteger(this.limit) || this.limit < 1 || this.limit > 100) {
      throw new SchedulingRefusal('schedule_invalid', 'Set max-wait to integer seconds from 1 through 31536000 and limit to 1 through 100.');
    }
    const time = options.now ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(time))) throw new SchedulingRefusal('schedule_invalid', 'Supply a valid scheduling timestamp or omit now to use the current clock.');
    this.now = new Date(time).toISOString();
  }

  /** Check hard requirements and calculate a soft transfer cost. */
  private metadata(item: SchedulingItem) {
    const required = item.tags.filter(tag => tag.startsWith('skill:')).map(tag => tag.slice(6));
    const preferred = item.swarm_preferred_agent;
    const raw = item.swarm_handoff_cost;
    const cost = raw === undefined ? 1 : Number(raw);
    if (required.length > 64 || required.some(skill => !validSkill(skill)) || (preferred !== undefined && (typeof preferred !== 'string' || !preferred.trim() || preferred.length > 128)) || (raw !== undefined && (typeof raw !== 'string' || !/^\d+$/.test(raw))) || !Number.isSafeInteger(cost) || cost < 0 || cost > 1000000) {
      throw new SchedulingRefusal('schedule_invalid', `Repair skill tags or swarm_preferred_agent/swarm_handoff_cost on ${item.id}; cost must be an integer from 0 through 1000000.`);
    }
    return { missing_skills: [...new Set(required.filter(skill => !this.skills.has(skill)))].sort(), handoff_cost: preferred === undefined || preferred === this.author ? 0 : cost };
  }

  /** Preserve explicit receiver handoffs while checking their hard skill declarations. */
  handoff(item: SchedulingItem): void {
    if (this.metadata(item).missing_skills.length > 0) throw new SchedulingRefusal('schedule_skills', `Declare the required skill tags on ${item.id} in --skills, or ask its owner to hand off to a qualified agent.`);
  }

  /** Reuse next's footprint safety and unknown fallback with policy ordering only. */
  select(candidates: RankedCandidate[], active: ActiveFootprint[], items: readonly SchedulingItem[]) {
    const byId = new Map(items.map(item => [item.id, item]));
    const rows = candidates.map(candidate => {
      const created = Date.parse(candidate.created_at);
      if (!Number.isFinite(created)) throw new SchedulingRefusal('schedule_invalid', `Repair the creation timestamp on ${candidate.id} before scheduling.`);
      const age = Math.max(0, Math.floor((Date.parse(this.now) - created) / 1000));
      return { id: candidate.id, state: 'rank' as SchedulingDecision['state'], age_seconds: age, starved: age >= this.maxWait, ...this.metadata(byId.get(candidate.id)!) };
    });
    const scores = new Map(rows.map(row => [row.id, row]));
    const qualified = candidates.filter(candidate => scores.get(candidate.id)!.missing_skills.length === 0);
    const result = selectNext(qualified, active, (left, right) => {
      const a = scores.get(left.id)!; const b = scores.get(right.id)!;
      if (a.starved !== b.starved) return a.starved ? -1 : 1;
      if (a.starved) return Date.parse(left.created_at) - Date.parse(right.created_at) || left.id.localeCompare(right.id);
      return left.priority - right.priority || a.handoff_cost - b.handoff_cost || Date.parse(left.created_at) - Date.parse(right.created_at) || left.id.localeCompare(right.id);
    }, true);
    const skipped = new Map(result.skipped.map(row => [row.id, row]));
    for (const row of rows) {
      const skip = skipped.get(row.id);
      row.state = row.missing_skills.length > 0 ? 'skills' : row.id === result.chosen?.item.id ? 'selected' : skip!.overlaps.length > 0 ? 'conflict' : skip!.reasons[0] === 'Unknown footprint deferred' ? 'unknown' : 'rank';
    }
    this.decisions = rows.sort((a, b) => Number(b.state === 'selected') - Number(a.state === 'selected') || a.id.localeCompare(b.id));
    this.counts = { ready: rows.length, qualified: qualified.length, conflicts: rows.filter(row => row.state === 'conflict').length, starved: rows.filter(row => row.starved && row.missing_skills.length === 0).length };
    const chosen = result.chosen === undefined ? undefined : scores.get(result.chosen.item.id)!;
    const reason = chosen === undefined ? 'No qualified ready candidate can start safely' : `${result.unknown ? 'Unknown footprint scheduled alone; ' : ''}${chosen.starved ? 'Starvation promotion: oldest qualified work' : 'Qualified work: priority, handoff cost, creation time, id'}; age ${chosen.age_seconds}s; handoff cost ${chosen.handoff_cost}`;
    return { ...result, reason, warnings: result.unknown ? ['Unknown footprint: scheduled with no active lanes; inspect before editing.'] : result.warnings };
  }

  /** Bound explanations while preserving exact totals and the existing assignment context. */
  receipt(result: NextReceipt, dryRun: boolean): ScheduleReceipt {
    return { selected: result.selected, agent: this.author, dry_run: dryRun, reason: result.reason, now: this.now, max_wait_seconds: this.maxWait, counts: this.counts, decisions: this.decisions.slice(0, this.limit), omitted: Math.max(0, this.decisions.length - this.limit), warnings: result.warnings, ...(result.token === undefined ? {} : { token: result.token }), ...(result.context === undefined ? {} : { context: result.context }), ...(result.mode === undefined ? {} : { mode: result.mode }), ...(result.worktree === undefined ? {} : { worktree: result.worktree }), ...(result.branch === undefined ? {} : { branch: result.branch }) };
  }
}

/** Bind fair ranking to either existing next engine, never a separate ownership path. */
export async function scheduleNext(engine: { author: string; repo: string; pmRoot: string }, options: ScheduleOptions, invoke: (policy: FairPolicy) => Promise<NextReceipt>): Promise<ScheduleReceipt> {
  assertPrivatePathSafe({ author: engine.author, options });
  const policy = new FairPolicy(engine.author, options);
  const discovered = await discoverExtensions({ pmRoot: engine.pmRoot, cwd: engine.repo, settings: await readSettings(engine.pmRoot) });
  if (!discovered.effective.every(extension => extension.capabilities !== undefined && extension.capabilities.length > 0 && !extension.capabilities.includes('services'))) {
    throw new SchedulingRefusal('schedule_backend_refused', 'Use a local tracker with shared swarm coordination; service-backed storage needs a tracker-wide scheduler adapter. No local fallback was attempted.');
  }
  return policy.receipt(await invoke(policy), options.dryRun === true);
}
