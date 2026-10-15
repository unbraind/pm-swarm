import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSettings, resolveRuntimeStatusRegistry, resolveItemTypeRegistry, statusIsTerminal, acquireLock, resolveLinkedTestTrustBatch, resolveLinkedTestSourceRef, acknowledgeLinkedTests, nowIso, resolveClaimPrincipal } from '@unbrained/pm-cli/sdk';
import type { PmClient, TestResult } from '@unbrained/pm-cli/sdk';
import { certifyCompleteListResult, computeActionabilityReport, selectActionableEntries } from '@unbrained/pm-cli/sdk/query';
import { branchExists, changedFiles, commit, git, missingDrivers, predict, chain } from './git.ts';
import { footprintPath, overlaps, partition } from './planner.ts';
import { cleanOrder, minimalConflict } from './order.ts';
import { settings } from './settings.ts';
import type { Lane, SwarmSettings } from './types.ts';

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
    this.repo = repo; this.pmRoot = pmRoot; this.client = client; this.author = resolveClaimPrincipal(author);
  }

  /** Load and certify the entire item corpus; never silently plan a partial tracker. */
  async corpus() { return certifyCompleteListResult(await this.client.listAllComplete()); }

  /** Select open ready unclaimed work through SDK actionability and claim views. */
  async plan(parent?: string, limit?: number) {
    const corpus = await this.corpus(); const config = await settings(this.pmRoot, limit === undefined ? {} : { lane_limit: limit });
    const prefs = await readSettings(this.pmRoot); const statuses = resolveRuntimeStatusRegistry(prefs.schema); const types = resolveItemTypeRegistry(prefs);
    const report = computeActionabilityReport(corpus.items, corpus.items, statuses, types);
    const ready = selectActionableEntries(report, statuses, {}, types).ready;
    const candidates = [];
    for (const { item } of ready) {
      if (item.status !== statuses.open_status || (parent !== undefined && item.parent !== parent)) continue;
      const view = await this.client.get(item.id, { fields: 'id,assignee,claim_state' });
      if (view.claim_state?.claimed !== false) continue;
      candidates.push({ id: item.id, files: (item.files ?? []).map(file => footprintPath(file.path)), dependencies: (item.dependencies ?? []).map(dep => dep.id) });
    }
    return { ...partition(candidates, config.lane_limit), complete_list: corpus.complete_list, read_output: corpus.read_output };
  }

  /** Claim before creating a worktree, and keep its absolute location only in local Git config. */
  async start(id: string, overrides: Partial<SwarmSettings> = {}) {
    return this.exclusive(() => this.startLane(id, overrides));
  }

  /** Hold a shared-repository SDK lease across claim and worktree publication. */
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const common = git(this.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const release = await acquireLock(join(common, 'swarm.local'), 'operation', 1800, this.author);
    try { return await operation(); } finally { await release(); }
  }

  /** Publish a lane under the repository operation lease. */
  private async startLane(id: string, overrides: Partial<SwarmSettings>) {
    const config = await settings(this.pmRoot, overrides);
    const item = (await this.client.get(id, { depth: 'full' })).item;
    const branch = `${config.branch_prefix}${item.id}`; git(this.repo, ['check-ref-format', '--branch', branch]);
    if (branchExists(this.repo, branch) || item.swarm_branch) throw new Error('Lane already exists');
    const prefs = await readSettings(this.pmRoot);
    if (statusIsTerminal(String(item.status), resolveRuntimeStatusRegistry(prefs.schema))) throw new Error('Cannot start a terminal item');
    const view = await this.client.get(id, { fields: 'id,assignee,claim_state' });
    if (view.claim_state?.claimed && view.claim_state.assignee !== this.author) throw new Error(`Item claimed by ${view.claim_state.assignee}`);
    const base = commit(this.repo, config.base); const path = resolve(this.repo, config.root, `${basename(this.repo)}-${item.id}`);
    await this.client.claim(item.id, { author: this.author });
    let created = false;
    try {
      git(this.repo, ['worktree', 'add', '-b', branch, path, base]); created = true;
      git(this.repo, ['config', '--local', `swarm.lane.${item.id}`, path]);
      await this.client.update(item.id, { author: this.author, field: [`swarm_branch=${branch}`, `swarm_base=${base}`, `swarm_base_ref=${config.base}`] });
    } catch (error) {
      if (created) { git(this.repo, ['config', '--local', '--unset', `swarm.lane.${item.id}`]); git(this.repo, ['worktree', 'remove', path]); }
      if (branchExists(this.repo, branch)) git(this.repo, ['branch', '-D', branch]);
      if (view.claim_state?.claimed === false) await this.client.release(item.id, { author: this.author });
      throw error;
    }
    return { id: item.id, branch, base, worktree: path, missing_merge_drivers: missingDrivers(path) };
  }

  /** Discover lanes from certified item fields and existing local branches. */
  async lanes(): Promise<Lane[]> {
    const corpus = await this.corpus(); const config = await settings(this.pmRoot);
    const statuses = resolveRuntimeStatusRegistry((await readSettings(this.pmRoot)).schema);
    const lanes: Lane[] = [];
    for (const item of corpus.items) {
      if (typeof item.swarm_branch !== 'string' || !branchExists(this.repo, item.swarm_branch)) continue;
      if (typeof item.swarm_base !== 'string') throw new Error(`Lane ${item.id} has no base SHA`);
      const target = typeof item.swarm_base_ref === 'string' ? item.swarm_base_ref : config.base;
      lanes.push({ id: item.id, branch: item.swarm_branch, sha: commit(this.repo, item.swarm_branch), base: commit(this.repo, item.swarm_base), target, agent: item.assignee ?? null, files: (item.files ?? []).map(file => footprintPath(file.path)), terminal: statusIsTerminal(item.status, statuses) });
    }
    return lanes;
  }

  /** Report actual branch changes, footprint drift, and pairwise/base-tip merge predictions. */
  async status() {
    const lanes = await this.lanes(); const predictions = [];
    const rows = lanes.map(lane => {
      const tip = commit(this.repo, lane.target); const changed = changedFiles(this.repo, tip, lane.sha);
      const [behind, ahead] = git(this.repo, ['rev-list', '--left-right', '--count', `${tip}...${lane.sha}`]).split(/\s+/).map(Number);
      predictions.push(predict(this.repo, lane.sha, tip));
      return { id: lane.id, branch: lane.branch, agent: lane.agent, ahead, behind, changed_files: changed, footprint_drift: changed.filter(path => !lane.files.some(file => overlaps(file, path))) };
    });
    for (const [i, left] of lanes.entries()) for (const right of lanes.slice(i + 1)) predictions.push(predict(this.repo, left.sha, right.sha));
    return { lanes: rows, predictions, missing_merge_drivers: missingDrivers(this.repo) };
  }

  /** Preview footprint updates by default; apply through the SDK files mutation. */
  async sync(id: string, apply = false) {
    const lane = (await this.lanes()).find(row => row.id === id);
    if (lane === undefined) throw new Error('No active lane for item');
    const files = changedFiles(this.repo, commit(this.repo, lane.target), lane.sha).map(footprintPath);
    const add = files.filter(path => !lane.files.includes(path));
    if (apply && add.length > 0) await this.client.files(id, { add, author: this.author });
    return { id, dry_run: !apply, add };
  }

  /** Simulate all lanes, report a smallest conflicting subset, and optionally merge tested commits locally. */
  async land(execute = false) { return this.exclusive(() => this.landLanes(execute)); }

  /** Keep simulation and execution inside the same shared repository lease. */
  private async landLanes(execute: boolean) {
    const lanes = await this.lanes(); const config = await settings(this.pmRoot);
    if (lanes.length > 8) throw new Error('Landing search supports at most 8 lanes; land a smaller batch');
    if (lanes.some(lane => lane.target !== config.base)) throw new Error('All lanes must target the configured swarm base');
    const base = commit(this.repo, config.base); const order = cleanOrder(this.repo, base, lanes);
    if (order === null) return { order: [], conflicting_set: minimalConflict(this.repo, base, lanes), executed: false, exit_code: 1 };
    if (execute && order.length > 0) {
      this.assertLandingBase(config.base, base);
      let simulated = base;
      for (const lane of order) {
        const result = predict(this.repo, simulated, lane.sha);
        simulated = chain(this.repo, simulated, lane.sha, result.tree);
        await this.checkTests(lane.id, simulated);
      }
      let expected = base;
      for (const lane of order) {
        this.assertLandingBase(config.base, expected);
        if (commit(this.repo, lane.branch) !== lane.sha || predict(this.repo, expected, lane.sha).conflicts.length > 0) throw new Error('Lane changed during landing; simulate again');
        git(this.repo, ['-c', 'user.name=SteveBot', '-c', 'user.email=1153461+unbraind@users.noreply.github.com', 'merge', '--no-ff', '--no-edit', lane.sha]);
        expected = commit(this.repo, 'HEAD');
      }
    }
    return { order: order.map(lane => lane.id), conflicting_set: [], executed: execute };
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
      await acknowledgeLinkedTests(join(path, '.agents/pm'), tests, nowIso());
      const runner = new URL(`./test-runner${extname(import.meta.filename)}`, import.meta.url);
      const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, [fileURLToPath(runner)], { cwd: path, input: JSON.stringify({ tests, pmRoot: join(path, '.agents/pm') }), encoding: 'utf8', env: environment });
      if (result.status !== 0 || result.stdout !== JSON.stringify({ passed: true })) throw new Error(`Linked tests failed for ${id}: ${result.stderr}`);
    } finally { git(this.repo, ['worktree', 'remove', '--force', path]); rmSync(directory, { recursive: true, force: true }); }
  }

  /** Reap only terminal merged branches, and release only this caller's stale claims. */
  async reap(dryRun = false) { return this.exclusive(() => this.reapLanes(dryRun)); }

  /** Check ancestry and remove registrations under the shared repository lease. */
  private async reapLanes(dryRun: boolean) {
    const lanes = await this.lanes(); const removed: string[] = []; const released: string[] = [];
    for (const lane of lanes) {
      if (!lane.terminal || spawnSync('git', ['merge-base', '--is-ancestor', lane.sha, commit(this.repo, lane.target)], { cwd: this.repo }).status !== 0) continue;
      const pathResult = spawnSync('git', ['config', '--local', '--get', `swarm.lane.${lane.id}`], { cwd: this.repo, encoding: 'utf8' });
      const path = pathResult.stdout.trimEnd();
      const worktrees = git(this.repo, ['worktree', 'list', '--porcelain', '-z']).split('\0\0');
      const matching = worktrees.find(entry => entry.split('\0').includes(`branch refs/heads/${lane.branch}`));
      if (matching !== undefined && !matching.split('\0').includes(`worktree ${path}`)) continue;
      if (!dryRun) {
        if (matching !== undefined) git(this.repo, ['worktree', 'remove', path]);
        git(this.repo, ['branch', '-d', lane.branch]);
        if (pathResult.status === 0) git(this.repo, ['config', '--local', '--unset', `swarm.lane.${lane.id}`]);
      }
      removed.push(lane.id);
      if (lane.agent === this.author) { if (!dryRun) await this.client.release(lane.id, { author: this.author }); released.push(lane.id); }
    }
    return { dry_run: dryRun, removed, released };
  }
}
