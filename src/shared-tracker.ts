import type { ItemHistoryHead } from './settings.ts';
import { scheduleNext } from './fair-scheduling.ts';
import type { FairPolicy, ScheduleOptions, ScheduleReceipt } from './fair-scheduling.ts';
import { readSettings, resolveRuntimeStatusRegistry, statusIsTerminal } from '@unbrained/pm-cli/sdk';
import { footprintPath, itemFootprint, partition } from './planner.ts';
import { footprintOverlaps, selectNext } from './selection.ts';
import { commitItemMutation, assertPrivatePathSafe, settings, SettingsRefusal } from './settings.ts';
import { Swarm } from './swarm.ts';
import { heartbeatPath, readRuntime, StaleFenceError, touchHeartbeat, withSwarmLease } from './lease.ts';
import type { Lease } from './lease.ts';
import type { SwarmSettings } from './types.ts';
import { RESOURCE_TAG } from './resources.ts';
import { recoveryItem } from './recovery.ts';
import { clientMutationSnapshot, inspectItem, inspectItems, readItem } from './inspection.ts';
import { completeClaim } from './close.ts';

/** Explain the Git requirement consistently in CLI and embedded shared mode. */
export const SHARED_LAND_REFUSAL = 'pm swarm land needs a git repository: landing merges git branches; in shared-tracker mode work is already on the shared tracker. Use next, sync --files, status and reap.';

/** Portable shared selection receipt, including optional claim or receiver context. */
export type SharedNextReceipt = Pick<ReturnType<typeof selectNext>, 'reason' | 'warnings' | 'skipped'> & Partial<Awaited<ReturnType<SharedTracker['start']>>> & { mode: string; selected: string | null; dry_run: boolean; context?: Record<string, unknown> };

/** Accept only a decimal fencing generation; a missing value is generation zero. */
function decimalFencingGeneration(value: unknown): string | undefined {
  const current = String(value ?? '0');
  return /^\d+$/.test(current) ? current : undefined;
}

/** Decode receiver context only when its object shape and decimal fence are valid. */
function parseHandoffContext(id: string, raw: string, token: unknown): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new StaleFenceError(id); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new StaleFenceError(id);
  const context = parsed as Record<string, unknown>;
  if (typeof context.token !== 'string' || decimalFencingGeneration(context.token) === undefined || context.token !== token) throw new StaleFenceError(id);
  assertPrivatePathSafe(context, 'context');
  return context;
}

/** Refuse returning a Git lane to the pool; explicit reassignment keeps its branch. */
function gitLanePoolRefusal(branch: unknown, to: string | undefined): string | undefined {
  if (to !== undefined || !branch) return undefined;
  return 'Git lane cannot return to the pool; use --to to assign its worktree branch';
}

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
      if (item.tags.includes(RESOURCE_TAG) || !item.assignee?.trim()) continue;
      const terminal = statusIsTerminal(item.status, statuses);
      const claim = withClaims && !terminal ? (await readItem(this.engine.client, item.id, 'claim_state')).claim_state : undefined;
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
    assertPrivatePathSafe({ id, overrides: _overrides, author: this.engine.author });
    return withSwarmLease(this.engine.pmRoot, this.engine.author, lease => this.claimLane(id, strict, lease));
  }

  /** Validate terminal status, ownership and declared overlap before claiming. */
  private async claimLane(id: string, strict: boolean, lease: Lease, corpus?: Awaited<ReturnType<Swarm['corpus']>>) {
    const local = await inspectItem(this.engine.pmRoot, this.engine.repo, id);
    if (local !== null) assertPrivatePathSafe({ ...local.item, body: local.body }, 'document');
    const preliminary = local ?? await readItem(this.engine.client, id);
    const canonicalId = String(preliminary.item.id);
    await this.claimState(preliminary.item);
    corpus ??= await this.engine.corpus();
    const active = (await this.sharedLanes(corpus, false)).filter(lane => !lane.terminal && lane.id !== canonicalId);
    this.claimWarnings(itemFootprint(preliminary.item), active, strict);
    const initial = await clientMutationSnapshot(this.engine.pmRoot, this.engine.client, canonicalId); const item = initial.item;
    const token = await this.claimState(item); const heartbeat = new Date().toISOString();
    const overlap_warnings = this.claimWarnings(itemFootprint(item), active, strict);
    const receipt = { mode: 'shared-tracker', id: canonicalId, agent: this.engine.author, token, files: itemFootprint(item), overlap_warnings };
    assertPrivatePathSafe(receipt);
    let publication: Record<string, unknown> | undefined;
    lease.onFailure(async () => {
      if (publication !== undefined && !item.assignee) {
        await this.engine.releaseAcquiredClaim(String(item.id), initial.version + 1, publication, lease);
        this.tokens.delete(String(item.id));
      }
    });
    await lease.write(() => commitItemMutation({ id: canonicalId, options: { author: this.engine.author, assignee: this.engine.author, field: [`swarm_token=${token}`, `swarm_claimed_at=${heartbeat}`], unset: ['swarm_handoff'], comment: [`Swarm claim token ${token}`] }, item }, async admitted => {
      const result = await this.engine.client.update(admitted.id, admitted.options); publication = result.item; return result;
    }, { history: initial.historyHead, onCommitted: (_before, after) => { publication = after.metadata; } }));
    this.tokens.set(String(item.id), token);
    return receipt;
  }

  /** Validate a guard or authoritative client snapshot without recording a claim or read receipt. */
  private async claimState(item: Record<string, unknown>): Promise<string> {
    if ((item.tags as string[]).includes(RESOURCE_TAG)) throw new Error('Resource items require swarm resource; use an ordinary work item for start.');
    const statuses = resolveRuntimeStatusRegistry((await readSettings(this.engine.pmRoot)).schema);
    if (statusIsTerminal(String(item.status), statuses)) throw new Error('Cannot start a terminal item');
    const owner = String(item.assignee ?? '').trim();
    if (owner && owner !== this.engine.author) throw new Error(`Item claimed by ${owner}`);
    return this.nextToken(item);
  }

  /** Check prospective overlap output before the ownership write or effectful client read. */
  private claimWarnings(files: string[], active: { id: string; files: string[] }[], strict: boolean) {
    const warnings = footprintOverlaps(files, active);
    assertPrivatePathSafe(warnings);
    if (strict && warnings.length > 0) throw new Error(`Overlapping start refused: ${warnings.map(row => `lane ${row.lane_id} on path ${row.path} (${row.lane_path})`).join('; ')}`);
    return warnings;
  }

  /** Select by declared skills, bounded aging and handoff cost through the existing claim path. */
  async schedule(options: ScheduleOptions): Promise<ScheduleReceipt> {
    return scheduleNext(this.engine, options, this.next.bind(this, options.parent, options.dryRun === true));
  }

  /** Pick by shared readiness and rank while holding the tracker coordination lease. */
  async next(parent?: string, dryRun = false, policy?: FairPolicy): Promise<SharedNextReceipt> {
    assertPrivatePathSafe({ parent, author: this.engine.author });
    /** Keep the read/claim decision inside a single bounded operation. */
    const choose = async (lease?: Lease) => {
      const { candidates, corpus } = await this.engine.readyCandidates(parent, false);
      const incoming = await this.incomingHandoff(corpus.items, parent, dryRun, policy);
      if (incoming !== undefined) {
        if (lease !== undefined) this.tokens.set(incoming.id, incoming.token);
        return incoming;
      }
      const active = (await this.sharedLanes(corpus, false)).filter(lane => !lane.terminal);
      const { chosen, unknown, warnings, skipped, reason } = policy === undefined ? selectNext(candidates, active) : policy.select(candidates, active, corpus.items);
      assertPrivatePathSafe({ warnings, skipped, reason });
      const lane = chosen !== undefined && lease !== undefined ? await this.claimLane(chosen.item.id, !unknown, lease, corpus) : undefined;
      return { mode: 'shared-tracker', ...lane, selected: chosen?.item.id ?? null, dry_run: dryRun, reason, warnings, skipped };
    };
    if (dryRun) return choose();
    // Preflight cannot announce liveness, cache a token or acquire a writer lease.
    // Only preflight receiver content here. Selection still certifies one fresh
    // complete corpus inside the lease and performs no per-lane client reads.
    const local = await inspectItems(this.engine.pmRoot, this.engine.repo);
    await this.incomingHandoff(local ?? (await this.engine.corpus()).items, parent, dryRun, policy);
    return withSwarmLease(this.engine.pmRoot, this.engine.author, choose);
  }

  /** Admit the complete prospective receiver receipt before caching a token or announcing liveness. */
  private async incomingHandoff(items: Awaited<ReturnType<Swarm['corpus']>>['items'], parent: string | undefined, dryRun: boolean, policy?: FairPolicy) {
    const statuses = resolveRuntimeStatusRegistry((await readSettings(this.engine.pmRoot)).schema);
    const incoming = items.find(item => item.assignee === this.engine.author && !statusIsTerminal(item.status, statuses) && (parent === undefined || item.parent === parent) && typeof item.swarm_handoff === 'string');
    if (incoming === undefined) return undefined;
    policy?.handoff(incoming);
    const context = parseHandoffContext(incoming.id, String(incoming.swarm_handoff), incoming.swarm_token);
    const receipt = { mode: 'shared-tracker', selected: incoming.id, id: incoming.id, agent: this.engine.author, token: String(incoming.swarm_token), context, dry_run: dryRun, reason: 'Assigned handoff', warnings: [], skipped: [] };
    assertPrivatePathSafe(receipt);
    return receipt;
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
    assertPrivatePathSafe({ id, explicitFiles, token, author: this.engine.author });
    if (explicitFiles === undefined || explicitFiles.length === 0 || explicitFiles.some(path => path.trim() === '')) throw new Error('Without git, sync requires --files a,b; add --apply to link them.');
    const files = [...new Set(explicitFiles.map(footprintPath))];
    /** Preserve preview and legacy no-op behavior while fencing every actual mutation. */
    const evaluate = async (lease?: Lease) => {
      const local = await inspectItem(this.engine.pmRoot, this.engine.repo, id);
      if (local !== null) await this.syncDecision(local.item, apply, files, token);
      const snapshot = apply ? await clientMutationSnapshot(this.engine.pmRoot, this.engine.client, id) : undefined;
      const item = snapshot?.item ?? (await readItem(this.engine.client, id)).item;
      const add = await this.syncDecision(item, apply, files, token);
      if (apply && add.length > 0) {
        await lease!.write(() => commitItemMutation({ id, options: { add, author: this.engine.author }, item }, admitted => this.engine.client.files(admitted.id, admitted.options), { history: snapshot!.historyHead }));
      }
      return { mode: 'shared-tracker', id, dry_run: !apply, add };
    };
    return apply ? withSwarmLease(this.engine.pmRoot, this.engine.author, evaluate) : evaluate();
  }

  /** Validate sync ownership and prospective links without materializing SDK read receipts. */
  private async syncDecision(item: Record<string, unknown>, apply: boolean, files: string[], token?: string): Promise<string[]> {
    if ((item.tags as string[]).includes(RESOURCE_TAG)) throw new Error('Resource items require swarm resource; use an ordinary work item for sync.');
    if (apply && token !== undefined) this.assertFence(item, token);
    const statuses = resolveRuntimeStatusRegistry((await readSettings(this.engine.pmRoot)).schema);
    if (!String(item.assignee ?? '').trim() || statusIsTerminal(String(item.status), statuses)) throw new Error('No active lane for item');
    const linked = itemFootprint(item as { files?: { path: string }[] }); const add = files.filter(path => !linked.includes(path));
    if (apply && add.length > 0 && token === undefined) this.assertFence(item);
    return add;
  }

  /** Explain why branch landing is unnecessary for work already on the shared tracker. */
  async land(_execute = false): Promise<never> {
    throw new Error(SHARED_LAND_REFUSAL);
  }

  /** Release this principal's terminal claims; preserve active and foreign ownership. */
  async reap(dryRun = false) {
    assertPrivatePathSafe(this.engine.author);
    return withSwarmLease(this.engine.pmRoot, this.engine.author, async lease => {
      const released: string[] = []; const refused: { id: string; reason: string }[] = [];
      const corpus = await this.engine.corpus(); const snapshots = new Map(corpus.items.map(item => [item.id, item]));
      for (const lane of await this.sharedLanes(corpus, false)) {
        if (!lane.terminal) continue;
        if (lane.agent !== this.engine.author) { refused.push({ id: lane.id, reason: 'Terminal claim belongs to another agent; use reap --agent with its principal' }); continue; }
        const recovery = await recoveryItem(this.engine.client, snapshots.get(lane.id)!, refused, this.engine.pmRoot);
        if (recovery === undefined) continue;
        const { item: current, historyHead } = recovery;
        if (!dryRun) await lease.write(() => commitItemMutation({ id: lane.id, options: { author: this.engine.author }, item: current }, admitted => this.engine.client.release(admitted.id, admitted.options), { generation: { token: current.swarm_token }, history: historyHead }));
        released.push(lane.id);
      }
      return { mode: 'shared-tracker', dry_run: dryRun, released, removed: [], cleanup: [], refused };
    });
  }

  /** Increment the durable item generation without floating-point overflow. */
  private nextToken(item: Record<string, unknown>): string {
    const current = decimalFencingGeneration(item.swarm_token);
    if (current === undefined) throw new Error(`Item ${String(item.id)} has a malformed swarm_token; repair it before changing ownership`);
    return (BigInt(current) + 1n).toString();
  }

  /** Refuse stale principal or generation against an already-read item. */
  private assertFence(item: Record<string, unknown>, token?: string): void {
    if ((item.tags as string[]).includes(RESOURCE_TAG)) throw new Error('Resource items require swarm resource; item handoff, heartbeat and close cannot change reservations.');
    const id = String(item.id);
    if (item.assignee !== this.engine.author) throw new StaleFenceError(`${id}: Item claimed by ${String(item.assignee)}`);
    if (item.swarm_token !== undefined && (token ?? this.tokens.get(id)) !== item.swarm_token) throw new StaleFenceError(id);
  }

  /** Read and check ownership under the operation pin before dispatching mutations. */
  private async fence(id: string, token?: string) {
    const local = await inspectItem(this.engine.pmRoot, this.engine.repo, id);
    if (local !== null) this.assertFence(local.item, token);
    const snapshot = await clientMutationSnapshot(this.engine.pmRoot, this.engine.client, id);
    this.assertFence(snapshot.item, token); return snapshot;
  }

  /** Renew the agent heartbeat, optionally verifying one held item generation. */
  async heartbeat(id?: string, token?: string) {
    assertPrivatePathSafe({ id, token, author: this.engine.author });
    if (id === undefined) return { agent: this.engine.author, heartbeat: touchHeartbeat(this.engine.pmRoot, this.engine.author) };
    return withSwarmLease(this.engine.pmRoot, this.engine.author, async lease => {
      await this.fence(id, token);
      lease.assert();
      return { agent: this.engine.author, heartbeat: touchHeartbeat(this.engine.pmRoot, this.engine.author) };
    });
  }

  /** Bind an ownership-dependent mutation to one checked item generation. */
  private async owned<T>(id: string, token: string | undefined, operation: (item: Record<string, unknown>, lease: Lease, history: ItemHistoryHead) => Promise<T>, preview?: (item: Record<string, unknown>) => Promise<unknown>): Promise<T> {
    if (preview !== undefined) {
      const local = await inspectItem(this.engine.pmRoot, this.engine.repo, id);
      if (local !== null) { this.assertFence(local.item, token); assertPrivatePathSafe({ ...local.item, body: local.body }, 'document'); await preview(local.item); }
    }
    return withSwarmLease(this.engine.pmRoot, this.engine.author, async lease => {
      const snapshot = await this.fence(id, token); return operation(snapshot.item, lease, snapshot.historyHead);
    });
  }

  /** Atomically transfer owner, generation and bounded receiver context in one SDK update. */
  async handoff(id: string, to: string, note: string, token?: string) {
    assertPrivatePathSafe({ id, to, note, token, author: this.engine.author });
    to = to.trim();
    if (!to || to === this.engine.author || !note.trim() || note.length > 4096) throw new Error('handoff requires a different --to agent and a nonempty --note of at most 4096 characters');
    /** Reuse the exact transfer preparation for preflight and the fresh fenced commit. */
    const transfer = async (item: Record<string, unknown>, lease?: Lease, history?: ItemHistoryHead) => {
      const statuses = resolveRuntimeStatusRegistry((await readSettings(this.engine.pmRoot)).schema);
      if (statusIsTerminal(String(item.status), statuses)) throw new Error('Cannot hand off a terminal item');
      return this.transfer(item, to, note, lease, history);
    };
    return this.owned(id, token, (item, lease, history) => transfer(item, lease, history), item => transfer(item));
  }

  /** Capture a compact snapshot and append its transfer evidence in the same transaction. */
  private async transfer(item: Record<string, unknown>, to: string | undefined, note: string, lease?: Lease, history?: ItemHistoryHead) {
    const id = String(item.id); const token = this.nextToken(item); const at = new Date().toISOString();
    let files: string[];
    try { files = itemFootprint(item); }
    catch { throw new SettingsRefusal('swarm_input_invalid', 'Repair foreign footprint declarations before transferring this item.'); }
    const comments = ((item.comments as { text: string; author: string; created_at: string }[] | undefined) ?? []).slice(-3).map(row => ({ ...row, text: row.text.slice(0, 1024) }));
    const context = { id, title: item.title, status: item.status, priority: item.priority, files: files.slice(0, 50), files_omitted: Math.max(0, files.length - 50), comments, from: item.assignee, to: to ?? null, token, note, at };
    const statuses = resolveRuntimeStatusRegistry((await readSettings(this.engine.pmRoot)).schema);
    assertPrivatePathSafe(context);
    if (lease !== undefined) await lease.write(() => commitItemMutation({ id, options: {
      author: this.engine.author, force: true, ...(to === undefined ? { status: statuses.open_status } : { assignee: to }),
      unset: [...(to === undefined ? ['assignee'] : []), ...(to === undefined ? ['swarm_handoff'] : [])],
      field: [`swarm_token=${token}`, `swarm_claimed_at=${at}`, ...(to === undefined ? [] : [`swarm_handoff=${JSON.stringify(context)}`])],
      comment: [note],
    }, item }, admitted => this.engine.client.update(admitted.id, admitted.options), { history: history! }));
    if (lease !== undefined) this.tokens.delete(id);
    return { id, previous_owner: item.assignee, agent: to ?? null, token, context };
  }

  /** Preview or recover stale swarm work, preserving unrelated owners and workflow states. */
  async reclaim(staleAfter: number, to?: string, dryRun = false, parent?: string) {
    assertPrivatePathSafe({ to, parent, author: this.engine.author });
    to = to?.trim();
    if (!Number.isFinite(staleAfter) || staleAfter <= 0 || (to !== undefined && !to)) throw new Error('reclaim requires --stale-after as positive seconds and a nonempty optional --to');
    /** Share eligibility and fresh-snapshot checks between preview and mutation. */
    const evaluate = async (lease?: Lease) => {
      const statuses = resolveRuntimeStatusRegistry((await readSettings(this.engine.pmRoot)).schema);
      const recovered = []; const refused: { id: string; reason: string; code?: string }[] = [];
      for (const row of (await this.engine.corpus()).items) {
        if (row.tags.includes(RESOURCE_TAG) || !row.assignee?.trim() || statusIsTerminal(row.status, statuses) || (parent !== undefined && row.parent !== parent)) continue;
        if (row.assignee === this.engine.author) continue;
        if (row.swarm_token === undefined && row.swarm_claimed_at === undefined && row.swarm_branch === undefined) continue;
        if (row.status !== statuses.open_status && row.status !== statuses.in_progress_status) { refused.push({ id: row.id, reason: 'Workflow status is outside open or in-progress work; preserve it for explicit review' }); continue; }
        const recorded = typeof row.swarm_claimed_at === 'string' ? row.swarm_claimed_at : row.updated_at;
        const observed = readRuntime<{ heartbeat: string }>(heartbeatPath(this.engine.pmRoot, row.assignee))?.heartbeat;
        const times = [recorded, observed].map(value => value === undefined ? NaN : Date.parse(value)).filter(Number.isFinite);
        if (times.length === 0) { refused.push({ id: row.id, reason: 'No valid claim or heartbeat timestamp; repair liveness evidence before reclaiming' }); continue; }
        if (Date.now() - Math.max(...times) < staleAfter * 1000) continue;
        const recovery = await recoveryItem(this.engine.client, row, refused, this.engine.pmRoot);
        if (recovery === undefined) continue;
        const { item, historyHead } = recovery;
        if (decimalFencingGeneration(item.swarm_token) === undefined) { refused.push({ id: row.id, reason: 'Malformed swarm_token; repair the fencing generation before reclaiming' }); continue; }
        const laneRefusal = gitLanePoolRefusal(item.swarm_branch, to);
        if (laneRefusal !== undefined) { refused.push({ id: row.id, reason: laneRefusal }); continue; }
        const renewed = readRuntime<{ heartbeat: string }>(heartbeatPath(this.engine.pmRoot, row.assignee))?.heartbeat;
        if (renewed !== undefined && Date.now() - Date.parse(renewed) < staleAfter * 1000) continue;
        const note = `Swarm reclaim: previous owner ${row.assignee}; last heartbeat ${renewed ?? observed ?? 'not recorded'}; previous token ${String(row.swarm_token ?? '0')}; destination ${to ?? 'pool'}; claim baseline ${recorded}`;
        try { recovered.push(await this.transfer(item, to, note, lease, historyHead)); }
        catch (error) {
          if (!(error instanceof SettingsRefusal)) throw error;
          refused.push(error.code === 'swarm_superseded' ? { id: row.id, code: error.code, reason: 'superseded: Native history advanced; preserve the peer claim and refresh before recovery' } : { id: row.id, reason: 'Unsafe foreign context; replace private locations with project-relative references before recovery' });
        }
      }
      return { dry_run: dryRun, recovered, refused };
    };
    return dryRun ? evaluate() : withSwarmLease(this.engine.pmRoot, this.engine.author, evaluate);
  }

  /** Close through native core once; interrupted or terminal work requires explicit inspection. */
  async close(id: string, note: string, token?: string) {
    return completeClaim(this.engine, id, note, token, this.tokens);
  }

}
