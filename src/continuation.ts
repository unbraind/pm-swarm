import { getItemAt, getHistoryPath, readHistoryEntries, hashHistoryStream } from '@unbrained/pm-cli/sdk';
import type { ItemDocument } from '@unbrained/pm-cli/sdk';
import { assertBriefBudget, assertBriefIdentitySafe, packBrief } from './assignment-brief.ts';
import { currentInterruption } from './interruption.ts';
import type { CapacityInterruption } from './interruption.ts';
import { git, gitRecords, commit, branchExists, registeredWorktrees, inspectWorktree, unavailableWorktree } from './git.ts';
import type { WorktreeUnavailableReason } from './git.ts';
import { SettingsRefusal, readItemHistoryHead } from './settings.ts';
import type { ItemHistoryHead } from './settings.ts';
import type { Swarm } from './swarm.ts';
import { repositoryRoot } from './workspace.ts';

/** Mark native files_add entries emitted by swarm's two sync apply routes. */
export const SYNC_HISTORY_MESSAGE = 'Swarm sync paths';

/** A chronological change to the lane's native evidence. */
interface Activity {
  at: string;
  kind: 'linked_file' | 'synced_path' | 'comment' | 'test';
  action: 'added' | 'removed';
  path?: string;
  text?: string;
  command?: string;
}

/** Fields selected independently within a continuation budget. */
interface ContinuationWork {
  acceptance_criteria?: string;
  title?: string;
  activity?: Activity[];
  files?: string[];
  commits?: string[];
  uncommitted_paths?: string[];
}

/** Portable receiver context with the ownership fence and chronological evidence. */
export interface ContinuationPacket {
  id: string;
  from: string;
  to: string;
  token: string;
  token_budget: number;
  claim_started_at: string;
  interruption: CapacityInterruption | null;
  acceptance_state: 'unverified';
  capacity: string | null;
  git_worktree_available?: boolean;
  git_worktree_unavailable_reason?: WorktreeUnavailableReason;
  context: ContinuationWork;
  omission_receipt: Partial<Record<keyof ContinuationWork, number | 'withheld: privacy'>>;
}

/** Sequence changes by committed native revision, including multiple rows in one revision. */
const COLLECTIONS = ['files', 'comments', 'tests'] as const;
type Collection = typeof COLLECTIONS[number];
type Evidence = Pick<Activity, 'path' | 'text' | 'command'>;

/** Retain task-facing fields and avoid importing host-local authorship or test options. */
function evidence(item: ItemDocument['metadata'], collection: Collection): Evidence[] {
  switch (collection) {
    case 'files': return item.files?.map(({ path }) => ({ path })) ?? [];
    case 'comments': return item.comments?.map(({ text }) => ({ text })) ?? [];
    case 'tests': return item.tests?.map(({ command, path }) => ({ command, path })) ?? [];
  }
}

/** Preserve order and distinguish identical independent rows when comparing revisions. */
function addedRows(before: Evidence[], after: Evidence[]): Evidence[] {
  const counts = new Map<string, number>();
  for (const row of before) {
    const key = JSON.stringify(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return after.filter(row => {
    const key = JSON.stringify(row);
    const count = counts.get(key) ?? 0;
    if (count === 0) return true;
    counts.set(key, count - 1);
    return false;
  });
}

/** Read the exact history paired with this owned document and project changes after its claim. */
async function laneHistory(engine: Swarm, item: Record<string, unknown>, expected?: ItemHistoryHead) {
  const id = String(item.id);
  const head = expected ?? await readItemHistoryHead(engine.pmRoot, id);
  const history = await readHistoryEntries(getHistoryPath(engine.pmRoot, id), id);
  if (history.length !== head.length || hashHistoryStream(history) !== head.hash) {
    throw new SettingsRefusal('swarm_superseded', 'Native history advanced while preparing the continuation. Retry with the current lane token.');
  }
  const token = item.swarm_token;
  const changes = history.map(entry => entry.patch);
  const index = changes.map((patch, i) => token === undefined ?
    history[i].op === 'claim' && patch.some(op => op.path === '/metadata/assignee' && op.value === item.assignee) :
    patch.some(op => op.path === '/metadata/swarm_token' && op.value === token)).lastIndexOf(true);
  if (index < 0) throw new SettingsRefusal('swarm_document_changed', 'Inspect the native claim history before transferring this lane.');
  const baseline = await getItemAt(id, String(index + 1), { pmRoot: engine.pmRoot });
  const activity: Activity[] = [];
  const previous = new Map(COLLECTIONS.map(name => [name, evidence(baseline.document.metadata, name)]));
  for (let i = index + 1; i < history.length; i++) {
    const affected = COLLECTIONS.filter(name => changes[i].some(op => op.path === '' || op.path === '/metadata' ||
      op.path === '/metadata/' + name || op.path.startsWith('/metadata/' + name + '/')));
    if (affected.length === 0) continue;
    const revision = await getItemAt(id, String(i + 1), { pmRoot: engine.pmRoot });
    for (const name of affected) {
      const old = previous.get(name)!;
      const current = evidence(revision.document.metadata, name);
      const kind: Activity['kind'] = name === 'files' ? history[i].message === SYNC_HISTORY_MESSAGE ? 'synced_path' : 'linked_file' : name === 'comments' ? 'comment' : 'test';
      const at = history[i].ts;
      activity.push(...addedRows(old, current).map(row => ({ ...row, at, kind, action: 'added' as const })));
      activity.push(...addedRows(current, old).map(row => ({ ...row, at, kind, action: 'removed' as const })));
      previous.set(name, current);
    }
  }
  return { claim_started_at: history[index].ts, activity };
}

/** Available Git evidence and the reason when a checkout cannot supply paths. */
type GitEvidence = Pick<ContinuationPacket, 'git_worktree_available' | 'git_worktree_unavailable_reason'>
  & Pick<ContinuationWork, 'commits' | 'uncommitted_paths'>;

/** Resolve the registered branch's actual checkout and capture paths without refreshing its index. */
async function gitEvidence(engine: Swarm, item: Record<string, unknown>): Promise<GitEvidence> {
  if (typeof item.swarm_branch !== 'string' || typeof item.swarm_base !== 'string') return {};
  const repo = repositoryRoot(engine.repo);
  if (repo === undefined || !branchExists(repo, item.swarm_branch)) return unavailableWorktree('branch_unavailable');
  const branch = 'refs/heads/' + item.swarm_branch;
  const base = commit(repo, item.swarm_base);
  const tip = commit(repo, branch);
  const commits = await gitRecords(repo, ['rev-list', '--reverse', base + '..' + tip], '\n');
  const checkout = inspectWorktree(repo, item.swarm_branch, registeredWorktrees(repo).get(item.swarm_branch));
  if (!('path' in checkout)) return { commits, ...checkout };
  let dirty: string[];
  let currentBranch: string;
  try {
    dirty = await gitRecords(checkout.path, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], '\0');
    currentBranch = git(checkout.path, ['symbolic-ref', 'HEAD']);
  } catch {
    return { commits, ...unavailableWorktree('checkout_unreadable') };
  }
  if (currentBranch !== branch || commit(repo, branch) !== tip) {
    throw new SettingsRefusal('swarm_superseded', 'The lane branch advanced while preparing the continuation. Inspect its current Git evidence and retry.');
  }
  return { commits, git_worktree_available: true, uncommitted_paths: dirty.map(row => row.slice(3)) };
}

/** Build and admit a budgeted receiver packet before changing the current ownership generation. */
export async function buildContinuation(engine: Swarm, item: Record<string, unknown>, to: string, token: string, token_budget: number, capacity: string | null, expected?: ItemHistoryHead): Promise<ContinuationPacket> {
  const id = String(item.id);
  const from = engine.author;
  const interruption = currentInterruption(item) ?? null;
  assertBriefIdentitySafe({ id, from, to, token, capacity, interruption });
  const { claim_started_at, activity } = await laneHistory(engine, item, expected);
  const { git_worktree_available, git_worktree_unavailable_reason, commits, uncommitted_paths } = await gitEvidence(engine, item);
  const packet: ContinuationPacket = {
    id, from, to, token, token_budget, claim_started_at, interruption, capacity, acceptance_state: 'unverified',
    ...(git_worktree_available === undefined ? {} : { git_worktree_available }),
    ...(git_worktree_unavailable_reason === undefined ? {} : { git_worktree_unavailable_reason }), context: {}, omission_receipt: {},
  };
  const files = evidence(item as ItemDocument['metadata'], 'files').map(({ path }) => path!);
  return packBrief(packet, { acceptance_criteria: item.acceptance_criteria as string | undefined, title: item.title as string | undefined, activity, files, commits, uncommitted_paths });
}

/** Return the exact saved transfer receipt, checking privacy and any newly requested budget. */
export function replayContinuation(snapshot: Record<string, unknown>, tokenBudget?: number): ContinuationPacket {
  assertBriefIdentitySafe(snapshot);
  const packet = snapshot as unknown as ContinuationPacket;
  const token_budget = tokenBudget ?? packet.token_budget;
  assertBriefBudget(token_budget);
  return packBrief({ ...packet, token_budget }, {});
}
