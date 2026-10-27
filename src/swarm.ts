import { scheduleNext } from './fair-scheduling.ts';
import type { FairPolicy, ScheduleOptions, ScheduleReceipt } from './fair-scheduling.ts';
import { gitEnvironment } from './git-environment.ts';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, extname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSettings, resolveRuntimeStatusRegistry, resolveItemTypeRegistry, statusIsTerminal, acquireLock, resolveLinkedTestTrustBatch, resolveLinkedTestSourceRef, acknowledgeLinkedTests, nowIso, resolveClaimPrincipal } from '@unbrained/pm-cli/sdk';
import type { PmClient, TestResult } from '@unbrained/pm-cli/sdk';
import { certifyCompleteListResult, computeActionabilityReport, selectActionableEntries } from '@unbrained/pm-cli/sdk/query';
import { branchExists, changedFiles, commit, git, missingDrivers, predict, chain } from './git.ts';
import { footprintPath, itemFootprint, overlaps, partition } from './planner.ts';
import { footprintOverlaps, selectNext } from './selection.ts';
import { maximalCleanOrder, minimalConflict } from './order.ts';
import { lanePathRefusal } from './reap.ts';
import { commitItemMutation, commitMutation, assertPrivatePathSafe, assertSdkInstance, settings } from './settings.ts';
import { inspectItem, readItem } from './inspection.ts';
import { RESOURCE_TAG } from './resources.ts';
import { StaleFenceError, withSwarmLease, retryLock } from './lease.ts';
import type { Lease } from './lease.ts';
import type { Candidate, Lane, SwarmSettings } from './types.ts';
import { recoveryItem } from './recovery.ts';

/** Bind all operations to one real repository, tracker, and caller identity. */
export class Swarm {
  /** Construct with the host's SDK client so extension field registrations survive. */
  readonly repo: string;
  /** Explicit tracker storage root bound by the host. */
  readonly pmRoot: string;
  /** Native SDK client retaining extension schema registrations. */
  readonly client: PmClient;
  /** Principal allowed to claim or release this invocation. */
  readonly author: string;
  /** Retain the bound invocation without process-global directory changes. */
  constructor(repo: string, pmRoot: string, client: PmClient, author: string) {
    assertSdkInstance(client);
    this.repo = repo; this.pmRoot = pmRoot; this.client = client; this.author = resolveClaimPrincipal(author);
  }

  /** Load and certify the entire item corpus; never silently plan a partial tracker. */
  async corpus() { return certifyCompleteListResult(await this.client.listAllComplete()); }

  /** Select open ready unclaimed work through SDK actionability and certified ownership. */
  async plan(parent?: string, limit?: number) {
    const config = await settings(this.pmRoot, limit === undefined ? {} : { lane_limit: limit });
    const { candidates, corpus } = await this.readyCandidates(parent);
    return { ...partition(candidates, config.lane_limit), complete_list: corpus.complete_list, read_output: corpus.read_output };
  }

  /** Use the same certified readiness and ownership rules for plan and next. */
  async readyCandidates(parent?: string, gitLanes = true) {
    const corpus = await this.corpus();
    const prefs = await readSettings(this.pmRoot); const statuses = resolveRuntimeStatusRegistry(prefs.schema); const types = resolveItemTypeRegistry(prefs);
    const report = computeActionabilityReport(corpus.items, corpus.items, statuses, types);
    const ready = selectActionableEntries(report, statuses, {}, types).ready;
    const candidates: (Candidate & { priority: number; created_at: string })[] = [];
    for (const { item } of ready) {
      if (item.tags.includes(RESOURCE_TAG) || item.status !== statuses.open_status || (gitLanes && item.swarm_branch) || (parent !== undefined && item.parent !== parent)) continue;
      if (item.assignee?.trim()) continue;
      candidates.push({ id: item.id, files: itemFootprint(item), dependencies: (item.dependencies ?? []).map(dep => dep.id), priority: item.priority, created_at: item.created_at });
    }
    return { candidates, corpus };
  }

  /** Claim before creating a worktree, and keep its absolute location only in local Git config. */
  async start(id: string, overrides: Partial<SwarmSettings> = {}, strict = false) {
    assertPrivatePathSafe({ id, overrides, author: this.author });
    return this.exclusive(lease => this.startLane(id, overrides, strict, lease));
  }

  /** Select by declared skills, bounded aging and handoff cost through the existing claim path. */
  async schedule(options: ScheduleOptions): Promise<ScheduleReceipt> {
    return scheduleNext(this, options, policy => this.next(options.parent, options.dryRun === true, policy));
  }

  /** Pick and publish under one lease; previews take no lease and perform no mutations. */
  async next(parent?: string, dryRun = false, policy?: FairPolicy) {
    assertPrivatePathSafe({ parent, author: this.author });
    if (dryRun) return this.nextLane(parent, true, undefined, policy);
    return this.exclusive(lease => this.nextLane(parent, false, lease, policy));
  }

  /** Rank ready work, exclude active overlaps, and explain every skipped candidate. */
  private async nextLane(parent: string | undefined, dryRun: boolean, lease?: Lease, policy?: FairPolicy) {
    const { candidates, corpus } = await this.readyCandidates(parent);
    const active = await this.activeFootprints();
    const { chosen, unknown, reason, warnings, skipped } = policy === undefined ? selectNext(candidates, active) : policy.select(candidates, active, corpus.items);
    assertPrivatePathSafe({ reason, warnings, skipped });
    const lane = chosen !== undefined && !dryRun ? await this.startLane(chosen.item.id, {}, !unknown, lease!) : undefined;
    return { ...lane, selected: chosen?.item.id ?? null, dry_run: dryRun, reason, warnings, skipped };
  }

  /** Include every assigned tracker item, measuring changes for local Git lanes. */
  private async activeFootprints() {
    const corpus = await this.corpus();
    const lanes = await this.lanes(corpus);
    const localIds = new Set(lanes.map(lane => lane.id));
    const gitLanes = lanes.filter(lane => !lane.terminal).map(lane => ({ ...lane, changed: changedFiles(this.repo, commit(this.repo, lane.target), lane.sha) }));
    const statuses = resolveRuntimeStatusRegistry((await readSettings(this.pmRoot)).schema);
    const assigned = corpus.items.filter(item => !item.tags.includes(RESOURCE_TAG) && item.assignee?.trim() && !statusIsTerminal(item.status, statuses) && !localIds.has(item.id));
    return [...gitLanes, ...assigned.map(item => ({ id: item.id, files: itemFootprint(item) }))];
  }

  /** Hold the tracker lease outside the repository lease across Git operations. */
  private async exclusive<T>(operation: (lease: Lease) => Promise<T>): Promise<T> {
    return withSwarmLease(this.pmRoot, this.author, async lease => {
      const common = git(this.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      // Coordination is not a domain write and must not announce principal liveness before admission.
      const release = await retryLock(() => { lease.assert(); return commitMutation({ resource: 'operation', author: this.author }, admitted => acquireLock(join(common, 'swarm.local'), admitted.resource, 1800, admitted.author)); });
      try { return await operation(lease); } finally { await release(); }
    }, { allowBlocking: true, receiptWorkspace: this.repo });
  }

  /** Publish a lane under the repository operation lease. */
  private async startLane(id: string, overrides: Partial<SwarmSettings>, strict: boolean, lease: Lease) {
    const config = await settings(this.pmRoot, overrides);
    const local = await inspectItem(this.pmRoot, this.repo, id);
    if (local !== null) assertPrivatePathSafe({ ...local.item, body: local.body }, 'document');
    const item = (await readItem(this.client, id)).item;
    if ((item.tags as string[]).includes(RESOURCE_TAG)) throw new Error('Resource items require swarm resource; use an ordinary work item for start.');
    const branch = `${config.branch_prefix}${item.id}`; git(this.repo, ['check-ref-format', '--branch', branch]);
    if (branchExists(this.repo, branch) || item.swarm_branch) throw new Error('Lane already exists');
    const prefs = await readSettings(this.pmRoot);
    if (statusIsTerminal(String(item.status), resolveRuntimeStatusRegistry(prefs.schema))) throw new Error('Cannot start a terminal item');
    const view = await readItem(this.client, id, 'id,assignee,claim_state');
    if (view.claim_state?.claimed && view.claim_state.assignee !== this.author) throw new Error(`Item claimed by ${view.claim_state.assignee}`);
    const overlap_warnings = footprintOverlaps(itemFootprint(item), (await this.activeFootprints()).filter(lane => lane.id !== id));
    if (strict && overlap_warnings.length > 0) throw new Error(`Overlapping start refused: ${overlap_warnings.map(row => `lane ${row.lane_id} on path ${row.path} (${row.lane_path})`).join('; ')}`);
    const base = commit(this.repo, config.base); const path = resolve(this.repo, config.root, `${basename(this.repo)}-${item.id}`);
    assertPrivatePathSafe({ id: item.id, branch, base, worktree: relative(this.repo, path), overlap_warnings });
    await lease.write(() => commitItemMutation({ id: item.id, options: { author: this.author }, item }, admitted => this.client.claim(admitted.id, admitted.options)));
    const claimed = (await readItem(this.client, id)).item;
    let created = false;
    try {
      git(this.repo, ['worktree', 'add', '-b', branch, path, base]); created = true;
      git(this.repo, ['config', '--local', `swarm.lane.${item.id}`, path]);
      await lease.write(() => commitItemMutation({ id: item.id, options: { author: this.author, field: [`swarm_branch=${branch}`, `swarm_base=${base}`, `swarm_base_ref=${config.base}`] }, item: claimed }, admitted => this.client.update(admitted.id, admitted.options)));
    } catch (error) {
      if (created) { git(this.repo, ['config', '--local', '--unset', `swarm.lane.${item.id}`]); git(this.repo, ['worktree', 'remove', path]); }
      if (branchExists(this.repo, branch)) git(this.repo, ['branch', '-D', branch]);
      if (view.claim_state?.claimed === false) await lease.write(() => commitItemMutation({ id: item.id, options: { author: this.author }, item: claimed }, admitted => this.client.release(admitted.id, admitted.options)));
      throw error;
    }
    return { id: item.id, branch, base, worktree: path, overlap_warnings, missing_merge_drivers: missingDrivers(path) };
  }

  /** Discover lanes from certified item fields and existing local branches. */
  async lanes(corpus?: Awaited<ReturnType<Swarm['corpus']>>): Promise<Lane[]> {
    corpus ??= await this.corpus(); const config = await settings(this.pmRoot);
    const statuses = resolveRuntimeStatusRegistry((await readSettings(this.pmRoot)).schema);
    const lanes: Lane[] = [];
    for (const item of corpus.items) {
      if (typeof item.swarm_branch !== 'string' || !branchExists(this.repo, item.swarm_branch)) continue;
      if (typeof item.swarm_base !== 'string') throw new Error(`Lane ${item.id} has no base SHA`);
      const target = typeof item.swarm_base_ref === 'string' ? item.swarm_base_ref : config.base;
      lanes.push({ id: item.id, branch: item.swarm_branch, sha: commit(this.repo, item.swarm_branch), base: commit(this.repo, item.swarm_base), target, agent: item.assignee ?? null, files: itemFootprint(item), terminal: statusIsTerminal(item.status, statuses) });
    }
    return lanes;
  }

  /** Report actual branch changes, footprint drift, and pairwise/base-tip merge predictions. */
  async status(full = false) {
    const lanes = await this.lanes(); const predictions = [];
    const rows = lanes.map(lane => {
      const tip = commit(this.repo, lane.target); const changed = changedFiles(this.repo, tip, lane.sha);
      const [behind, ahead] = git(this.repo, ['rev-list', '--left-right', '--count', `${tip}...${lane.sha}`]).split(/\s+/).map(Number);
      predictions.push({ ...predict(this.repo, lane.sha, tip), left_id: lane.id, left_branch: lane.branch, right_id: 'base', right_branch: lane.target });
      return { id: lane.id, branch: lane.branch, agent: lane.agent, ahead, behind, changed_files: changed, footprint_drift: changed.filter(path => !lane.files.some(file => overlaps(file, path))) };
    });
    for (const [i, left] of lanes.entries()) for (const right of lanes.slice(i + 1)) predictions.push({ ...predict(this.repo, left.sha, right.sha), left_id: left.id, left_branch: left.branch, right_id: right.id, right_branch: right.branch });
    const clean_pairs = predictions.filter(row => row.clean).length;
    const visible = full ? predictions : predictions.filter(row => !row.clean).map(({ left: _left, right: _right, tree: _tree, ...row }) => row);
    return { lanes: rows, predictions: visible, clean_pairs, missing_merge_drivers: missingDrivers(this.repo) };
  }

  /** Preview footprint updates by default; apply through the SDK files mutation. */
  async sync(id: string, apply = false, explicitFiles?: string[], token?: string) {
    assertPrivatePathSafe({ id, explicitFiles, token, author: this.author });
    /** Keep lane discovery, authoritative ownership and each write within the same pin. */
    const evaluate = async (lease?: Lease) => {
      const lane = (await this.lanes()).find(row => row.id === id);
      if (lane === undefined) throw new Error('No active lane for item');
      if (explicitFiles !== undefined && (explicitFiles.length === 0 || explicitFiles.some(path => path.trim() === ''))) throw new Error('sync --files requires nonempty comma-separated paths');
      const files = commitMutation([...new Set((explicitFiles ?? changedFiles(this.repo, commit(this.repo, lane.target), lane.sha)).map(footprintPath))], admitted => admitted);
      const item = apply ? (await readItem(this.client, id)).item : undefined;
      const linked = item === undefined ? lane.files : itemFootprint(item);
      const add = files.filter(path => !linked.includes(path));
      if (apply && (add.length > 0 || token !== undefined)) {
        if (item!.assignee !== this.author) throw new Error(item!.assignee ? `Item claimed by ${String(item!.assignee)}` : 'Lane is unclaimed; claim it before applying file links');
        if (item!.swarm_token !== undefined && token !== item!.swarm_token) throw new StaleFenceError(id);
        const statuses = resolveRuntimeStatusRegistry((await readSettings(this.pmRoot)).schema);
        if (statusIsTerminal(String(item!.status), statuses)) throw new Error('No active lane for item');
        if (add.length > 0) await lease!.write(() => commitItemMutation({ id, options: { add, author: this.author }, item: item! }, admitted => this.client.files(admitted.id, admitted.options)));
      }
      return { id, dry_run: !apply, add };
    };
    return apply ? withSwarmLease(this.pmRoot, this.author, evaluate, { allowBlocking: true }) : evaluate();
  }

  /** Simulate all lanes, report a smallest conflicting subset, and optionally merge tested commits locally. */
  async land(execute = false) { assertPrivatePathSafe(this.author); return this.exclusive(() => this.landLanes(execute)); }

  /** Keep simulation and execution inside the same shared repository lease. */
  private async landLanes(execute: boolean) {
    const lanes = await this.lanes(); const config = await settings(this.pmRoot);
    if (lanes.length > 8) throw new Error('Landing search supports at most 8 lanes; land a smaller batch');
    if (lanes.some(lane => lane.target !== config.base)) throw new Error('All lanes must target the configured swarm base');
    const base = commit(this.repo, config.base); const order = maximalCleanOrder(this.repo, base, lanes);
    const blocked = this.blockedLanes(base, config.base, lanes.filter(lane => !order.includes(lane)), order);
    const conflicting_set = blocked.length > 0 ? minimalConflict(this.repo, base, lanes) : [];
    assertPrivatePathSafe({ lanes, order: order.map(lane => lane.id), conflicting_set, blocked });
    if (execute && order.length > 0) {
      this.assertLandingBase(config.base, base);
      let simulated = base;
      for (const lane of order) {
        const result = predict(this.repo, simulated, lane.sha);
        if (!result.clean) throw new Error('Lane changed during landing; simulate again');
        simulated = chain(this.repo, simulated, lane.sha, result.tree);
        await this.checkTests(lane.id, simulated);
      }
      let expected = base;
      for (const lane of order) {
        this.assertLandingBase(config.base, expected);
        if (commit(this.repo, lane.branch) !== lane.sha || !predict(this.repo, expected, lane.sha).clean) throw new Error('Lane changed during landing; simulate again');
        git(this.repo, ['-c', 'user.name=SteveBot', '-c', 'user.email=1153461+unbraind@users.noreply.github.com', 'merge', '--no-ff', '--no-edit', lane.sha]);
        expected = commit(this.repo, 'HEAD');
      }
    }
    return { order: order.map(lane => lane.id), conflicting_set, blocked, executed: execute, ...(blocked.length > 0 ? { exit_code: 1 } : {}) };
  }

  /** Attribute blocked files to the base or the clean prefix introducing their conflict. */
  private blockedLanes(base: string, target: string, blocked: Lane[], order: Lane[]) {
    return blocked.map(lane => {
      let current = base;
      const peers = [];
      const baseConflict = predict(this.repo, current, lane.sha);
      if (!baseConflict.clean) peers.push({ id: 'base', branch: target, conflicts: baseConflict.conflicts, messages: baseConflict.messages, next_step: `rebase ${lane.branch} after ${target} lands` });
      let previous = baseConflict;
      for (const peer of order) {
        const merged = predict(this.repo, current, peer.sha);
        current = chain(this.repo, current, peer.sha, merged.tree);
        const prediction = predict(this.repo, current, lane.sha);
        const direct = predict(this.repo, peer.sha, lane.sha);
        const introduced = prediction.conflicts.filter(file => !previous.conflicts.includes(file));
        const files = [...new Set([...direct.conflicts, ...introduced])].sort();
        if (!direct.clean || (!prediction.clean && previous.clean) || files.length > 0) peers.push({ id: peer.id, branch: peer.branch, conflicts: files, messages: prediction.messages, next_step: `rebase ${lane.branch} after ${peer.branch} lands` });
        previous = prediction;
      }
      return { id: lane.id, branch: lane.branch, conflicts: previous.conflicts, messages: previous.messages, peers };
    });
  }

  /** Refuse dirty workspaces or a base that moved after simulation. */
  private assertLandingBase(base: string, expected: string): void {
    if (git(this.repo, ['symbolic-ref', '--short', 'HEAD']) !== base || commit(this.repo, 'HEAD') !== expected || git(this.repo, ['status', '--porcelain']) !== '') throw new Error('Landing requires the unchanged base branch and a clean worktree');
  }

  /** Run the item's SDK linked tests on the simulated merged commit in an isolated worktree. */
  private async checkTests(id: string, sha: string): Promise<void> {
    const tests = (await this.client.run('test', { id, options: { list: true } }) as TestResult).tests;
    if (tests.length === 0) throw new Error(`Lane ${id} has no linked tests`);
    const trust = await resolveLinkedTestTrustBatch(this.pmRoot, tests, await resolveLinkedTestSourceRef(this.repo));
    if (trust.some(decision => !decision.trusted)) throw new Error(`Linked tests are untrusted for ${id}`);
    const directory = mkdtempSync(join(tmpdir(), 'pm-swarm-')); const path = join(directory, 'verify');
    git(this.repo, ['worktree', 'add', '--detach', path, sha]);
    try {
      await commitMutation({ tests, at: nowIso() }, admitted => acknowledgeLinkedTests(join(path, '.agents/pm'), admitted.tests, admitted.at));
      const runner = new URL(`./test-runner${extname(import.meta.filename)}`, import.meta.url);
      const environment: NodeJS.ProcessEnv = { ...gitEnvironment(), PM_SOURCE_WORKSPACE_ROOT: path }; delete environment.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, [fileURLToPath(runner)], { cwd: path, input: JSON.stringify({ tests, pmRoot: join(path, '.agents/pm') }), encoding: 'utf8', env: environment });
      if (result.status !== 0 || result.stdout !== JSON.stringify({ passed: true })) throw new Error(`Linked tests failed for ${id}: ${result.stderr}`);
    } finally { git(this.repo, ['worktree', 'remove', '--force', path]); rmSync(directory, { recursive: true, force: true }); }
  }

  /** Reap only terminal merged branches, and release only this caller's stale claims. */
  async reap(dryRun = false) { assertPrivatePathSafe(this.author); return this.exclusive(lease => this.reapLanes(dryRun, lease)); }

  /** Check ancestry and remove registrations under the shared repository lease. */
  private async reapLanes(dryRun: boolean, lease: Lease) {
    const corpus = await this.corpus(); const snapshots = new Map(corpus.items.map(item => [item.id, item]));
    const lanes = await this.lanes(corpus); const config = await settings(this.pmRoot);
    const removed: string[] = []; const released: string[] = [];
    const cleanup: { id: string; action: string }[] = []; const refused: { id: string; reason: string }[] = [];
    for (const lane of lanes) {
      if (!lane.terminal || spawnSync('git', ['merge-base', '--is-ancestor', lane.sha, commit(this.repo, lane.target)], { cwd: this.repo, env: gitEnvironment() }).status !== 0) continue;
      const pathResult = spawnSync('git', ['config', '--local', '--get', `swarm.lane.${lane.id}`], { cwd: this.repo, env: gitEnvironment(), encoding: 'utf8' });
      const path = pathResult.stdout.trimEnd();
      const worktrees = git(this.repo, ['worktree', 'list', '--porcelain', '-z']).split('\0\0');
      const matching = worktrees.find(entry => entry.split('\0').includes(`branch refs/heads/${lane.branch}`));
      if (matching !== undefined && !matching.split('\0').includes(`worktree ${path}`)) { refused.push({ id: lane.id, reason: 'Lane branch is checked out at a different location' }); continue; }
      const refusal = path === '' ? null : lanePathRefusal(this.repo, config.root, lane.id, path, matching === undefined);
      if (refusal !== null) { refused.push({ id: lane.id, reason: refusal }); continue; }
      const missing = !existsSync(path);
      if (matching !== undefined && matching.split('\0').some(field => field.startsWith('locked'))) { refused.push({ id: lane.id, reason: 'Lane worktree is locked' }); continue; }
      const current = await recoveryItem(this.client, snapshots.get(lane.id)!, refused);
      if (current === undefined) continue;
      if (matching !== undefined) cleanup.push({ id: lane.id, action: missing ? 'pruned_registration' : 'removed_worktree' });
      else if (!missing) cleanup.push({ id: lane.id, action: 'removed_orphan' });
      if (!dryRun) {
        // Remove only this lane's stale registration; a global prune would touch unrelated worktrees.
        if (matching !== undefined) git(this.repo, ['worktree', 'remove', ...(missing ? ['--force'] : []), path]);
        else if (!missing) rmSync(path, { recursive: true });
        git(this.repo, ['branch', '-d', lane.branch]);
        if (pathResult.status === 0) git(this.repo, ['config', '--local', '--unset', `swarm.lane.${lane.id}`]);
      }
      removed.push(lane.id);
      if (lane.agent === this.author) { if (!dryRun) await lease.write(() => commitItemMutation({ id: lane.id, options: { author: this.author }, item: current }, admitted => this.client.release(admitted.id, admitted.options))); released.push(lane.id); }
    }
    return { dry_run: dryRun, removed, released, cleanup, refused };
  }
}
