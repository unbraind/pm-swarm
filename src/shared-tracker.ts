import { readSettings, resolveRuntimeStatusRegistry, statusIsTerminal } from '@unbrained/pm-cli/sdk';
import { footprintPath, itemFootprint, partition } from './planner.ts';
import { footprintOverlaps, selectNext } from './selection.ts';
import { settings } from './settings.ts';
import { Swarm } from './swarm.ts';
import { heartbeatPath, readRuntime, StaleFenceError, touchHeartbeat, withSwarmLease } from './lease.ts';
import type { Lease } from './lease.ts';
import type { SwarmSettings } from './types.ts';

/** Explain the Git requirement consistently in CLI and embedded shared mode. */
export const SHARED_LAND_REFUSAL = 'pm swarm land needs a git repository: landing merges git branches; in shared-tracker mode work is already on the shared tracker. Use next, sync --files, status and reap.';

/** Coordinate claims on the host-bound tracker without branches or worktrees. */
export class SharedTracker {
  /** Host-bound engine supplying certified reads and SDK operations. */
  readonly engine: Swarm;
  /** Reuse the host-bound SDK engine without invoking its Git operations. */
  constructor(engine: Swarm) { this.engine = engine; }
  /** Tokens issued to this embedded worker; CLI workers pass --token explicitly. */
  private readonly tokens = new Map<string, string>();
  /** Read assigned items from the certified corpus, retaining available claim provenance. */
  async sharedLanes(corpus?: Awaited<ReturnType<Swarm['corpus']>>, withClaims = true) {
    corpus ??= await this.engine.corpus();
    const statuses = resolveRuntimeStatusRegistry((await readSettings(this.engine.pmRoot)).schema);
    const lanes = [];
    for (const item of corpus.items) {
      if (!item.assignee?.trim()) continue;
      const terminal = statusIsTerminal(item.status, statuses);
      const claim = withClaims && !terminal ? (await this.engine.client.get(item.id, { fields: 'claim_state' })).claim_state : undefined;
      lanes.push({ id: item.id, agent: item.assignee, files: itemFootprint(item), terminal, claimed_at: typeof item.swarm_claimed_at === 'string' ? item.swarm_claimed_at : claim?.last_claim?.ts ?? null });
    }
    return lanes.sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Plan waves excluding ready work that overlaps a nonterminal assigned item. */
  async plan(parent?: string, limit?: number) {
    const config = await settings(this.engine.pmRoot, limit === undefined ? {} : { lane_limit: limit });
    const { candidates, corpus } = await this.engine.readyCandidates(parent, false);
    const active = (await this.sharedLanes(corpus, false)).filter(lane => !lane.terminal);
    const blocked = candidates.map(item => ({ id: item.id, unknown: item.files.length === 0, overlaps: footprintOverlaps(item.files, active) })).filter(row => row.overlaps.length > 0 || (active.length > 0 && row.unknown));
    return { mode: 'shared-tracker', ...partition(candidates.filter(item => !blocked.some(row => row.id === item.id)), config.lane_limit), blocked, complete_list: corpus.complete_list, read_output: corpus.read_output };
  }

  /** Claim a shared lane under the same lease as automatic selection. */
  async start(id: string, _overrides: Partial<SwarmSettings> = {}, strict = false) {
    return withSwarmLease(this.engine.pmRoot, this.engine.author, lease => this.claimLane(id, strict, lease));
  }

  /** Validate terminal status, ownership and declared overlap before claiming. */
  private async claimLane(id: string, strict: boolean, lease: Lease, corpus?: Awaited<ReturnType<Swarm['corpus']>>) {
    const view = await this.engine.client.get(id, { depth: 'full' }); const item = view.item;
    const statuses = resolveRuntimeStatusRegistry((await readSettings(this.engine.pmRoot)).schema);
    if (statusIsTerminal(String(item.status), statuses)) throw new Error('Cannot start a terminal item');
    if (view.claim_state?.claimed && view.claim_state.assignee !== this.engine.author) throw new Error(`Item claimed by ${view.claim_state.assignee}`);
    const active = (await this.sharedLanes(corpus, false)).filter(lane => !lane.terminal && lane.id !== id);
    const overlap_warnings = footprintOverlaps(itemFootprint(item), active);
    if (strict && overlap_warnings.length > 0) throw new Error(`Overlapping start refused: ${overlap_warnings.map(row => `lane ${row.lane_id} on path ${row.path} (${row.lane_path})`).join('; ')}`);
    const token = this.nextToken(item); const heartbeat = new Date().toISOString();
    await lease.write(() => this.engine.client.update(id, { author: this.engine.author, assignee: this.engine.author, field: [`swarm_token=${token}`, `swarm_claimed_at=${heartbeat}`], unset: ['swarm_handoff'], comment: [`Swarm claim token ${token}`] }));
    this.tokens.set(id, token);
    return { mode: 'shared-tracker', id, agent: this.engine.author, token, files: itemFootprint(item), overlap_warnings };
  }

  /** Pick by shared readiness and rank while holding the tracker coordination lease. */
  async next(parent?: string, dryRun = false) {
    /** Keep the read/claim decision inside a single bounded operation. */
    const choose = async (lease?: Lease) => {
      const { candidates, corpus } = await this.engine.readyCandidates(parent, false);
      const statuses = resolveRuntimeStatusRegistry((await readSettings(this.engine.pmRoot)).schema);
      const incoming = corpus.items.find(item => item.assignee === this.engine.author && !statusIsTerminal(item.status, statuses) && (parent === undefined || item.parent === parent) && typeof item.swarm_handoff === 'string');
      if (incoming !== undefined) {
        const context = JSON.parse(String(incoming.swarm_handoff)) as Record<string, unknown>;
        if (context.token !== incoming.swarm_token) throw new StaleFenceError(incoming.id);
        if (!dryRun) this.tokens.set(incoming.id, String(incoming.swarm_token));
        return { mode: 'shared-tracker', selected: incoming.id, id: incoming.id, agent: this.engine.author, token: String(incoming.swarm_token), context, dry_run: dryRun, reason: 'Assigned handoff', warnings: [], skipped: [] };
      }
      const active = (await this.sharedLanes(corpus, false)).filter(lane => !lane.terminal);
      const { chosen, unknown, warnings, skipped, reason } = selectNext(candidates, active);
      const lane = chosen !== undefined && !dryRun ? await this.claimLane(chosen.item.id, !unknown, lease!, corpus) : undefined;
      return { mode: 'shared-tracker', ...lane, selected: chosen?.item.id ?? null, dry_run: dryRun, reason, warnings, skipped };
    };
    return dryRun ? choose() : withSwarmLease(this.engine.pmRoot, this.engine.author, choose);
  }

  /** Report ownership, claim age and declared overlaps without inventing Git measurements. */
  async status(_full = false) {
    const active = (await this.sharedLanes()).filter(lane => !lane.terminal);
    const lanes = active.map(({ terminal: _terminal, ...lane }) => {
      const claimed = lane.claimed_at === null ? NaN : Date.parse(lane.claimed_at);
      return { ...lane, claim_age_seconds: Number.isFinite(claimed) ? Math.max(0, Math.floor((Date.now() - claimed) / 1000)) : null };
    });
    const overlaps = [];
    for (const [i, left] of active.entries()) for (const right of active.slice(i + 1)) {
      const paths = footprintOverlaps(left.files, [right]);
      if (paths.length > 0 || left.files.length === 0) overlaps.push({ left_id: left.id, right_id: right.id, paths, unknown: left.files.length === 0 || right.files.length === 0 });
    }
    return { mode: 'shared-tracker', lanes, overlaps, note: 'Git ahead/behind and merge predictions are unavailable in shared-tracker mode.' };
  }

  /** Link explicit paths from one fresh item read, under the fenced write pin. */
  async sync(id: string, apply = false, explicitFiles?: string[], token?: string): Promise<{ mode: string; id: string; dry_run: boolean; add: string[] }> {
    if (explicitFiles === undefined || explicitFiles.length === 0 || explicitFiles.some(path => path.trim() === '')) throw new Error('Without git, sync requires --files a,b; add --apply to link them.');
    const files = [...new Set(explicitFiles.map(footprintPath))];
    /** Preserve preview and legacy no-op behavior while fencing every actual mutation. */
    const evaluate = async (lease?: Lease) => {
      const item = (await this.engine.client.get(id, { depth: 'full' })).item;
      if (apply && token !== undefined) this.assertFence(item, token);
      const statuses = resolveRuntimeStatusRegistry((await readSettings(this.engine.pmRoot)).schema);
      if (!String(item.assignee ?? '').trim() || statusIsTerminal(String(item.status), statuses)) throw new Error('No active lane for item');
      const linked = itemFootprint(item); const add = files.filter(path => !linked.includes(path));
      if (apply && add.length > 0) {
        if (token === undefined) this.assertFence(item);
        await lease!.write(() => this.engine.client.files(id, { add, author: this.engine.author }));
      }
      return { mode: 'shared-tracker', id, dry_run: !apply, add };
    };
    return apply ? withSwarmLease(this.engine.pmRoot, this.engine.author, evaluate) : evaluate();
  }

  /** Explain why branch landing is unnecessary for work already on the shared tracker. */
  async land(_execute = false): Promise<never> {
    throw new Error(SHARED_LAND_REFUSAL);
  }

  /** Release this principal's terminal claims; preserve active and foreign ownership. */
  async reap(dryRun = false) {
    return withSwarmLease(this.engine.pmRoot, this.engine.author, async lease => {
      const released: string[] = []; const refused: { id: string; reason: string }[] = [];
      for (const lane of await this.sharedLanes(undefined, false)) {
        if (!lane.terminal) continue;
        if (lane.agent !== this.engine.author) { refused.push({ id: lane.id, reason: 'Terminal claim belongs to another agent; use reap --agent with its principal' }); continue; }
        if (!dryRun) await lease.write(() => this.engine.client.release(lane.id, { author: this.engine.author }));
        released.push(lane.id);
      }
      return { mode: 'shared-tracker', dry_run: dryRun, released, removed: [], cleanup: [], refused };
    });
  }

  /** Increment the durable item generation without floating-point overflow. */
  private nextToken(item: Record<string, unknown>): string {
    return (BigInt(String(item.swarm_token ?? '0')) + 1n).toString();
  }

  /** Refuse stale principal or generation against an already-read item. */
  private assertFence(item: Record<string, unknown>, token?: string): void {
    const id = String(item.id);
    if (item.assignee !== this.engine.author) throw new StaleFenceError(`${id}: Item claimed by ${String(item.assignee)}`);
    if (item.swarm_token !== undefined && (token ?? this.tokens.get(id)) !== item.swarm_token) throw new StaleFenceError(id);
  }

  /** Read and check ownership under the operation pin before dispatching mutations. */
  private async fence(id: string, token?: string) {
    const item = (await this.engine.client.get(id, { depth: 'full' })).item;
    this.assertFence(item, token); return item;
  }

  /** Renew the agent heartbeat, optionally verifying one held item generation. */
  async heartbeat(id?: string, token?: string) {
    if (id === undefined) return { agent: this.engine.author, heartbeat: touchHeartbeat(this.engine.pmRoot, this.engine.author) };
    return withSwarmLease(this.engine.pmRoot, this.engine.author, async lease => {
      await this.fence(id, token);
      lease.assert();
      return { agent: this.engine.author, heartbeat: touchHeartbeat(this.engine.pmRoot, this.engine.author) };
    });
  }

  /** Bind an ownership-dependent mutation to one checked item generation. */
  private async owned<T>(id: string, token: string | undefined, operation: (item: Record<string, unknown>, lease: Lease) => Promise<T>): Promise<T> {
    return withSwarmLease(this.engine.pmRoot, this.engine.author, async lease => operation(await this.fence(id, token), lease));
  }

  /** Atomically transfer owner, generation and bounded receiver context in one SDK update. */
  async handoff(id: string, to: string, note: string, token?: string) {
    to = to.trim();
    if (!to || to === this.engine.author || !note.trim() || note.length > 4096) throw new Error('handoff requires a different --to agent and a nonempty --note of at most 4096 characters');
    return this.owned(id, token, async (item, lease) => {
      const statuses = resolveRuntimeStatusRegistry((await readSettings(this.engine.pmRoot)).schema);
      if (statusIsTerminal(String(item.status), statuses)) throw new Error('Cannot hand off a terminal item');
      return this.transfer(item, to, note, lease);
    });
  }

  /** Capture a compact snapshot and append its transfer evidence in the same transaction. */
  private async transfer(item: Record<string, unknown>, to: string | undefined, note: string, lease: Lease) {
    const id = String(item.id); const token = this.nextToken(item); const at = new Date().toISOString();
    const files = itemFootprint(item);
    const comments = (item.comments as { text: string; author: string; created_at: string }[]).slice(-3).map(row => ({ ...row, text: row.text.slice(0, 1024) }));
    const context = { id, title: item.title, status: item.status, priority: item.priority, files: files.slice(0, 50), files_omitted: Math.max(0, files.length - 50), comments, from: item.assignee, to: to ?? null, token, note, at };
    const statuses = resolveRuntimeStatusRegistry((await readSettings(this.engine.pmRoot)).schema);
    await lease.write(() => this.engine.client.update(id, {
      author: this.engine.author, force: true, ...(to === undefined ? { status: statuses.open_status } : { assignee: to }),
      unset: [...(to === undefined ? ['assignee'] : []), ...(to === undefined ? ['swarm_handoff'] : [])],
      field: [`swarm_token=${token}`, `swarm_claimed_at=${at}`, ...(to === undefined ? [] : [`swarm_handoff=${JSON.stringify(context)}`])],
      comment: [note],
    }));
    this.tokens.delete(id);
    return { id, previous_owner: item.assignee, agent: to ?? null, token, context };
  }

  /** Recover nonterminal claims whose principal has stopped heartbeating. */
  async reclaim(staleAfter: number, to?: string) {
    to = to?.trim();
    if (!Number.isFinite(staleAfter) || staleAfter <= 0 || (to !== undefined && !to)) throw new Error('reclaim requires --stale-after as positive seconds and a nonempty optional --to');
    return withSwarmLease(this.engine.pmRoot, this.engine.author, async lease => {
      const statuses = resolveRuntimeStatusRegistry((await readSettings(this.engine.pmRoot)).schema);
      const recovered = []; const refused: { id: string; reason: string }[] = [];
      for (const row of (await this.engine.corpus()).items) {
        if (!row.assignee?.trim() || statusIsTerminal(row.status, statuses)) continue;
        const recorded = typeof row.swarm_claimed_at === 'string' ? row.swarm_claimed_at : row.updated_at;
        const observed = readRuntime<{ heartbeat: string }>(heartbeatPath(this.engine.pmRoot, row.assignee))?.heartbeat;
        const times = [recorded, observed].map(value => value === undefined ? NaN : Date.parse(value)).filter(Number.isFinite);
        if (times.length === 0) { refused.push({ id: row.id, reason: 'No valid claim or heartbeat timestamp; repair liveness evidence before reclaiming' }); continue; }
        if (Date.now() - Math.max(...times) < staleAfter * 1000) continue;
        const item = (await this.engine.client.get(row.id, { depth: 'full' })).item;
        const note = `Swarm reclaim: previous owner ${row.assignee}; last heartbeat ${observed ?? 'not recorded'}; previous token ${String(row.swarm_token ?? '0')}; destination ${to ?? 'pool'}; claim baseline ${recorded}`;
        recovered.push(await this.transfer(item, to, note, lease));
      }
      return { recovered, refused };
    });
  }

  /** Finish a fenced claim and release its ownership in one durable mutation. */
  async close(id: string, note: string, token?: string) {
    if (!note.trim()) throw new Error('close requires a nonempty --note');
    return this.owned(id, token, async (item, lease) => {
      const statuses = resolveRuntimeStatusRegistry((await readSettings(this.engine.pmRoot)).schema);
      await lease.write(() => this.engine.client.update(id, { author: this.engine.author, status: statuses.close_status, message: note, unset: ['assignee', 'swarm_handoff'], field: [`swarm_token=${this.nextToken(item)}`] }));
      this.tokens.delete(id); return { id, closed: true };
    });
  }

}
