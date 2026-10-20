import { readSettings, resolveRuntimeStatusRegistry, statusIsTerminal, acquireLock } from '@unbrained/pm-cli/sdk';
import { footprintPath, itemFootprint, partition } from './planner.ts';
import { footprintOverlaps, selectNext } from './selection.ts';
import { settings } from './settings.ts';
import { Swarm } from './swarm.ts';
import type { SwarmSettings } from './types.ts';

/** Explain the Git requirement consistently in CLI and embedded shared mode. */
export const SHARED_LAND_REFUSAL = 'pm swarm land needs a git repository: landing merges git branches; in shared-tracker mode work is already on the shared tracker. Use next, sync --files, status and reap.';

/** Coordinate claims on the host-bound tracker without branches or worktrees. */
export class SharedTracker {
  /** Host-bound engine supplying certified reads and SDK operations. */
  readonly engine: Swarm;
  /** Reuse the host-bound SDK engine without invoking its Git operations. */
  constructor(engine: Swarm) { this.engine = engine; }
  /** Read claimed items from the certified corpus, retaining claim provenance. */
  async sharedLanes(corpus?: Awaited<ReturnType<Swarm['corpus']>>, withClaims = true) {
    corpus ??= await this.engine.corpus();
    const statuses = resolveRuntimeStatusRegistry((await readSettings(this.engine.pmRoot)).schema);
    const lanes = [];
    for (const item of corpus.items) {
      if (!item.assignee?.trim()) continue;
      const claim = withClaims ? (await this.engine.client.get(item.id, { fields: 'claim_state' })).claim_state : undefined;
      lanes.push({ id: item.id, agent: item.assignee, files: itemFootprint(item), terminal: statusIsTerminal(item.status, statuses), claimed_at: claim?.last_claim?.ts ?? null });
    }
    return lanes.sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Serialize selection and claim publication on this tracker across real processes. */
  private async sharedExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const release = await acquireLock(this.engine.pmRoot, 'swarm-operation', 1800, this.engine.author, false, false, 60000);
    try { return await operation(); } finally { await release(); }
  }

  /** Plan waves excluding ready work that overlaps an existing nonterminal claim. */
  async plan(parent?: string, limit?: number) {
    const config = await settings(this.engine.pmRoot, limit === undefined ? {} : { lane_limit: limit });
    const { candidates, corpus } = await this.engine.readyCandidates(parent, false);
    const active = (await this.sharedLanes(corpus, false)).filter(lane => !lane.terminal);
    const blocked = candidates.map(item => ({ id: item.id, unknown: item.files.length === 0, overlaps: footprintOverlaps(item.files, active) })).filter(row => row.overlaps.length > 0 || (active.length > 0 && row.unknown));
    return { mode: 'shared-tracker', ...partition(candidates.filter(item => !blocked.some(row => row.id === item.id)), config.lane_limit), blocked, complete_list: corpus.complete_list, read_output: corpus.read_output };
  }

  /** Claim a shared lane under the same lease as automatic selection. */
  async start(id: string, _overrides: Partial<SwarmSettings> = {}, strict = false) {
    return this.sharedExclusive(() => this.claimLane(id, strict));
  }

  /** Validate terminal status, ownership and declared overlap before claiming. */
  private async claimLane(id: string, strict: boolean, corpus?: Awaited<ReturnType<Swarm['corpus']>>) {
    const view = await this.engine.client.get(id, { depth: 'full' }); const item = view.item;
    const statuses = resolveRuntimeStatusRegistry((await readSettings(this.engine.pmRoot)).schema);
    if (statusIsTerminal(String(item.status), statuses)) throw new Error('Cannot start a terminal item');
    if (view.claim_state?.claimed && view.claim_state.assignee !== this.engine.author) throw new Error(`Item claimed by ${view.claim_state.assignee}`);
    const active = (await this.sharedLanes(corpus, false)).filter(lane => !lane.terminal && lane.id !== id);
    const overlap_warnings = footprintOverlaps(itemFootprint(item), active);
    if (strict && overlap_warnings.length > 0) throw new Error(`Overlapping start refused: ${overlap_warnings.map(row => `lane ${row.lane_id} on path ${row.path} (${row.lane_path})`).join('; ')}`);
    await this.engine.client.claim(id, { author: this.engine.author });
    return { mode: 'shared-tracker', id, agent: this.engine.author, files: itemFootprint(item), overlap_warnings };
  }

  /** Pick by shared readiness and rank while holding the tracker coordination lease. */
  async next(parent?: string, dryRun = false) {
    /** Keep the read/claim decision inside a single bounded operation. */
    const choose = async () => {
      const { candidates, corpus } = await this.engine.readyCandidates(parent, false);
      const active = (await this.sharedLanes(corpus, false)).filter(lane => !lane.terminal);
      const { chosen, unknown, warnings, skipped, reason } = selectNext(candidates, active);
      const lane = chosen !== undefined && !dryRun ? await this.claimLane(chosen.item.id, !unknown, corpus) : undefined;
      return { mode: 'shared-tracker', ...lane, selected: chosen?.item.id ?? null, dry_run: dryRun, reason, warnings, skipped };
    };
    return dryRun ? choose() : this.sharedExclusive(choose);
  }

  /** Report ownership, claim age and declared overlaps without inventing Git measurements. */
  async status(_full = false) {
    const active = (await this.sharedLanes()).filter(lane => !lane.terminal);
    const lanes = active.map(({ terminal: _terminal, ...lane }) => ({ ...lane, claim_age_seconds: lane.claimed_at === null ? null : Math.max(0, Math.floor((Date.now() - Date.parse(lane.claimed_at)) / 1000)) }));
    const overlaps = [];
    for (const [i, left] of active.entries()) for (const right of active.slice(i + 1)) {
      const paths = footprintOverlaps(left.files, [right]);
      if (paths.length > 0 || left.files.length === 0) overlaps.push({ left_id: left.id, right_id: right.id, paths, unknown: left.files.length === 0 || right.files.length === 0 });
    }
    return { mode: 'shared-tracker', lanes, overlaps, note: 'Git ahead/behind and merge predictions are unavailable in shared-tracker mode.' };
  }

  /** Require explicit portable changed paths and retain the normal preview/apply contract. */
  async sync(id: string, apply = false, explicitFiles?: string[]) {
    if (explicitFiles === undefined || explicitFiles.length === 0 || explicitFiles.some(path => path.trim() === '')) throw new Error('Without git, sync requires --files a,b; add --apply to link them.');
    const lane = (await this.sharedLanes(undefined, false)).find(row => row.id === id && !row.terminal);
    if (lane === undefined) throw new Error('No active lane for item');
    const add = [...new Set(explicitFiles.map(footprintPath))].filter(path => !lane.files.includes(path));
    if (apply && add.length > 0 && lane.agent !== this.engine.author) throw new Error(`Item claimed by ${lane.agent}`);
    if (apply && add.length > 0) await this.engine.client.files(id, { add, author: this.engine.author });
    return { mode: 'shared-tracker', id, dry_run: !apply, add };
  }

  /** Explain why branch landing is unnecessary for work already on the shared tracker. */
  async land(_execute = false): Promise<never> {
    throw new Error(SHARED_LAND_REFUSAL);
  }

  /** Release this principal's terminal claims; preserve active and foreign ownership. */
  async reap(dryRun = false) {
    return this.sharedExclusive(async () => {
      const released: string[] = []; const refused: { id: string; reason: string }[] = [];
      for (const lane of await this.sharedLanes(undefined, false)) {
        if (!lane.terminal) continue;
        if (lane.agent !== this.engine.author) { refused.push({ id: lane.id, reason: 'Terminal claim belongs to another agent; use reap --agent with its principal' }); continue; }
        if (!dryRun) await this.engine.client.release(lane.id, { author: this.engine.author });
        released.push(lane.id);
      }
      return { mode: 'shared-tracker', dry_run: dryRun, released, removed: [], cleanup: [], refused };
    });
  }
}
