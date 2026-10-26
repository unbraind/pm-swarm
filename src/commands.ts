import { validateCommandInputs } from './admission.ts';
import { SchedulingRefusal } from './fair-scheduling.ts';
import { relative } from 'node:path';
import { encodeToon } from '@unbrained/pm-cli/sdk/testing';
import { createPmCliExpectedError, isPmCliExpectedError, readSettings, resolveAuthor } from '@unbrained/pm-cli/sdk';
import { defineCommand } from '@unbrained/pm-cli/sdk/authoring';
import type { CommandHandlerContext, ExtensionApi, FlagDefinition } from '@unbrained/pm-cli/sdk/authoring';
import { repositoryRoot } from './workspace.ts';
import { SharedTracker, SHARED_LAND_REFUSAL } from './shared-tracker.ts';
import { guardItemDocument, commitMutation, assertPrivatePathSafe, SettingsRefusal, updateSettings } from './settings.ts';
import { StaleFenceError } from './lease.ts';
import { Swarm } from './swarm.ts';
import { runWatch, watchInterval } from './watch.ts';
import type { SwarmSettings } from './types.ts';
import { ResourceReservations, ResourceRefusal } from './resources.ts';
import { trackerResourceBackend } from './resource-tracker.ts';
import { PlanProgress, ProgressRefusal } from './progress.ts';
import type { ProgressStage } from './progress.ts';

/** Retain the exit status of asynchronous Git lane failures while sanitizing host errors. */
class GitCommandFailure extends Error {
  /** Existing host exit status for the failed Git operation. */
  readonly exitCode: number;
  /** Keep native expected statuses and the generic Git failure status. */
  constructor(error: unknown) { super(String(error)); this.exitCode = isPmCliExpectedError(error) ? error.exitCode : 1; }
}
/** Await a lane result without changing the established Git error transport. */
async function laneOperation(operation: Promise<Record<string, unknown>>, repo: string | undefined): Promise<Record<string, unknown>> {
  try { return await operation; }
  catch (error) { if (repo === undefined) throw error; throw new GitCommandFailure(error); }
}
/** Read a scalar from the immutable input frame already checked by admission. */
function textOption(value: unknown): string | undefined { return value as string | undefined; }
/** Preserve flag precedence without injecting undefined over configured defaults. */
function overrides(options: Record<string, unknown>): Partial<SwarmSettings> {
  const result: Partial<SwarmSettings> = {};
  for (const key of ['base', 'root'] as const) { const value = textOption(options[key]); if (value !== undefined) result[key] = value; }
  const orchestrator = textOption(options.progressOrchestrator); if (orchestrator !== undefined) result.progress_orchestrator = orchestrator;
  const prefix = textOption(options.branchPrefix); if (prefix !== undefined) result.branch_prefix = prefix;
  const limit = textOption(options.limit); if (limit !== undefined) result.lane_limit = Number(limit);
  return result;
}
/** Resource actions admitted before backend construction or dispatch. */
type ResourceAction = 'status' | 'reserve' | 'renew' | 'release' | 'publish';
/** Dispatch one admitted resource action through the existing reservation SDK. */
async function dispatchResource(resources: ResourceReservations, action: ResourceAction, id: string, options: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = textOption(options.token) ?? '';
  switch (action) {
    case 'status': return { ...await resources.status(id) };
    case 'reserve': return { ...await resources.reserve(id, options.ttl === undefined ? undefined : Number(textOption(options.ttl))) };
    case 'renew': return { ...await resources.renew(id, token, options.ttl === undefined ? undefined : Number(textOption(options.ttl))) };
    case 'release': return { ...await resources.release(id, token) };
    case 'publish': return { ...await resources.publish(id, token, textOption(options.note)!) };
  }
}
/** Dispatch native host context to the shared SDK engine; leave rendering to pm. */
async function dispatch(command: string, ctx: CommandHandlerContext): Promise<Record<string, unknown>> {
  if (ctx.sdk === undefined) throw new Error('pm-swarm requires the host SDK command context');
  const workspace = ctx.source_workspace_root ?? ctx.repo_root ?? ctx.pm_root;
  const repo = ['settings', 'heartbeat', 'reclaim', 'handoff', 'close', 'resource', 'progress'].includes(command) ? undefined : repositoryRoot(workspace);
  const client = ctx.sdk.client;
  const opts = overrides(ctx.options);
  const author = resolveAuthor(textOption(ctx.options.agent) ?? ctx.global.author, (await readSettings(ctx.pm_root)).author_default);
  const swarm = repo === undefined ? new SharedTracker(new Swarm(workspace, ctx.pm_root, client, author)) : new Swarm(repo, ctx.pm_root, client, author);
  const id = ctx.args[0];
  switch (command) {
    case 'progress': {
      const progress = new PlanProgress({ cwd: workspace, pmRoot: ctx.pm_root, author: ctx.global.author }, true);
      const options = { agent: textOption(ctx.options.agent), orchestrator: textOption(ctx.options.orchestrator), revision: textOption(ctx.options.revision), offset: ctx.options.offset === undefined ? undefined : Number(textOption(ctx.options.offset)), limit: ctx.options.limit === undefined ? undefined : Number(textOption(ctx.options.limit)) };
      const stage = textOption(ctx.options.stage);
      if (stage === undefined) {
        return { ...await progress.view(id, options) };
      }
      return { ...await progress.witness(id, { ...options, stage: stage as ProgressStage, step: textOption(ctx.options.step)!, revision: options.revision!, evidence: textOption(ctx.options.evidence)!, apply: ctx.options.apply === true }) };
    }
    case 'resource': {
      const resources = new ResourceReservations(trackerResourceBackend((swarm as SharedTracker).engine), author);
      const action = (textOption(ctx.options.action) ?? 'status') as ResourceAction;
      return dispatchResource(resources, action, id, ctx.options);
    }
    case 'plan': {
      const result = await swarm.plan(textOption(ctx.options.parent), opts.lane_limit);
      if (ctx.options.full === true || ctx.global.json === true) return result;
      const { complete_list: _complete, read_output: _read, ...compact } = result;
      return compact;
    }
    case 'schedule': return { ...await swarm.schedule({ skills: textOption(ctx.options.skills)?.split(',').map(skill => skill.trim()) ?? [], maxWaitSeconds: ctx.options.maxWait === undefined ? undefined : Number(textOption(ctx.options.maxWait)), limit: ctx.options.limit === undefined ? undefined : Number(textOption(ctx.options.limit)), parent: textOption(ctx.options.parent), dryRun: ctx.options.dryRun === true }) };
    case 'next': {
      const operation = swarm.next(textOption(ctx.options.parent), ctx.options.dryRun === true);
      return laneOperation(operation, repo);
    }
    case 'start': {
      const operation = swarm.start(id, opts, ctx.options.strict === true);
      return laneOperation(operation, repo);
    }
    case 'status': {
      if (ctx.options.watch === true) {
        await runWatch(swarm, watchInterval(textOption(ctx.options.interval)), ctx.global.json === true || ctx.global.outputFormat === 'json');
        return { swarm_watch_complete: true };
      }
      if (ctx.options.interval !== undefined) throw new Error('--interval requires --watch');
      const operation = swarm.status(ctx.options.full === true);
      return laneOperation(operation, repo);
    }
    case 'sync': {
      const operation = swarm.sync(id, ctx.options.apply === true && ctx.options.dryRun !== true, textOption(ctx.options.files)?.split(',').map(path => path.trim()), textOption(ctx.options.token));
      return await operation;
    }
    case 'heartbeat': return await (swarm as SharedTracker).heartbeat(id, textOption(ctx.options.token));
    case 'handoff': return await (swarm as SharedTracker).handoff(id, textOption(ctx.options.to)!, textOption(ctx.options.note)!, textOption(ctx.options.token));
    case 'reclaim': return await (swarm as SharedTracker).reclaim(Number(textOption(ctx.options.staleAfter)), textOption(ctx.options.to), ctx.options.dryRun === true, textOption(ctx.options.parent));
    case 'close': return await (swarm as SharedTracker).close(id, textOption(ctx.options.note)!, textOption(ctx.options.token));
    case 'land': {
      if (repo === undefined) throw new Error(SHARED_LAND_REFUSAL);
      return laneOperation(swarm.land(ctx.options.execute === true), repo);
    }
    case 'reap': {
      const operation = swarm.reap(ctx.options.dryRun === true);
      return laneOperation(operation, repo);
    }
    case 'settings': return { ...await updateSettings(ctx.sdk, ctx.pm_root, opts, { apply: ctx.options.apply === true, operationId: textOption(ctx.options.operationId) }) };
    default: throw new Error('Unknown swarm command');
  }
}
/** Dispatch and validate the complete host result before any renderer can emit it. */
export async function runCommand(command: string, ctx: CommandHandlerContext): Promise<Record<string, unknown>> {
  try {
    // Accepted leaves are immutable scalars; snapshot caller-owned containers before any await.
    ctx = { ...ctx, args: [...ctx.args], options: { ...ctx.options }, global: { ...ctx.global } };
    validateCommandInputs(command, ctx);
    const result = await dispatch(command, ctx);
    if (typeof result.worktree === 'string') result.worktree = relative(repositoryRoot(ctx.source_workspace_root ?? ctx.repo_root ?? ctx.pm_root)!, result.worktree);
    assertPrivatePathSafe(result);
    return result;
  } catch (error) {
    try { assertPrivatePathSafe(String(error)); } catch (refusal) { error = refusal; }
    throw createPmCliExpectedError(String(error), { exitCode: error instanceof GitCommandFailure ? error.exitCode : 2, context: {
      ...(error instanceof SettingsRefusal || error instanceof SchedulingRefusal || error instanceof ResourceRefusal || error instanceof ProgressRefusal ? { code: error.code, required: error.remedy } : error instanceof StaleFenceError ? { code: error.code } : {}),
      ...(error instanceof SettingsRefusal && error.field !== undefined ? { field: error.field } : {}),
      recovery: { recovery_mode: 'compact', attempted_command: 'pm swarm [values withheld]', normalized_args: ['swarm', '[values withheld]'], parsed_positionals: [{ role: 'arguments', value: '[values withheld]' }], provided_fields: ['[values withheld]'] },
    } });
  }
}
/** Registration metadata is also the single source of truth for mutation variants and refusal coverage. */
export const swarmCommandDefinitions = {
  progress: { mutations: ['claimed', 'produced', 'reviewed', 'accepted'].map(stage => ({ stage, apply: true })), description: 'Read revision-bound Plan progress or explicitly append a witness', flags: ['agent', 'orchestrator', 'revision', 'offset', 'limit', 'stage', 'step', 'evidence', 'apply'], id: true },
  resource: { mutations: ['reserve', 'renew', 'release', 'publish'].map(action => ({ action })), description: 'Reserve, renew, release or publish with an exclusive resource fence', flags: ['agent', 'action', 'ttl', 'token', 'note'], id: true },
  plan: { mutations: [], description: 'Partition ready unclaimed work into safe parallel waves', flags: ['parent', 'limit', 'full'], id: false },
  schedule: { mutations: [{}], description: 'Select qualified ready work with starvation promotion and handoff costs', flags: ['agent', 'skills', 'max-wait', 'parent', 'limit', 'dry-run'], id: false },
  next: { mutations: [{}], description: 'Pick and start the best safe ready item', flags: ['agent', 'parent', 'dry-run'], id: false },
  start: { mutations: [{}], description: 'Claim an item; create a worktree lane when inside Git', flags: ['agent', 'base', 'root', 'branch-prefix', 'strict'], id: true },
  status: { mutations: [], description: 'Report active lanes and overlaps; predict conflicts in Git', flags: ['full', 'watch', 'interval'], id: false },
  sync: { mutations: [{ apply: true }], description: 'Preview changed-file links; --apply records them', flags: ['agent', 'dry-run', 'apply', 'files', 'token'], id: true },
  heartbeat: { mutations: [{}], description: 'Renew agent liveness, optionally fencing an item', flags: ['agent', 'token'], id: false },
  reclaim: { mutations: [{}], description: 'Recover claims from agents that stopped heartbeating', flags: ['agent', 'stale-after', 'to', 'parent', 'dry-run'], id: false },
  handoff: { mutations: [{}], description: 'Transfer fenced ownership with receiver context atomically', flags: ['agent', 'to', 'note', 'token'], id: true },
  close: { mutations: [{}], description: 'Finish and release a fenced claim atomically', flags: ['agent', 'note', 'token'], id: true },
  land: { mutations: [{ execute: true }], description: 'Find a clean landing order; --execute tests and merges locally', flags: ['execute', 'full'], id: false },
  reap: { mutations: [{}], description: 'Remove only merged terminal lanes and release own stale claims', flags: ['agent', 'dry-run'], id: false },
  settings: { mutations: [{ apply: true }], description: 'Preview or --apply SDK swarm settings', flags: ['base', 'root', 'branch-prefix', 'limit', 'progress-orchestrator', 'operation-id', 'apply'], id: false },
} satisfies Record<string, { description: string; flags: string[]; id: boolean; mutations: Record<string, string | boolean>[] }>;
/** Every command path owned by the package renderer. */
export const swarmCommandNames = Object.keys(swarmCommandDefinitions);
/** Return a typed refusal instead of throwing into the host's native-renderer fallback. */
function safeRendererResult(result: unknown): unknown {
  try { return commitMutation(result, admitted => admitted); }
  catch { return { code: 'swarm_private_path', required: 'Replace private user-home paths with project-relative references.' }; }
}
/** Register portable fields and command metadata for host TOON/JSON rendering. */
export function register(api: ExtensionApi): void {
  api.hooks.beforeMutation(guardItemDocument);
  for (const format of ['toon', 'json'] as const) api.registerRenderer(format, context => {
    const result = safeRendererResult(context.result);
    if ('swarm_watch_complete' in (result as object) && (result as { swarm_watch_complete?: boolean }).swarm_watch_complete === true) return '';
    return format === 'json' ? JSON.stringify(result) : encodeToon(result);
  }, {
    commands: swarmCommandNames.map(name => `swarm ${name}`),
    resultDiscriminator: result => {
      try { assertPrivatePathSafe(result); } catch { return true; }
      return typeof result === 'object' && result !== null && !Array.isArray(result) && Object.keys(result).some(key => ['id', 'swarm', 'mode', 'suggested_start_set', 'lanes', 'selected', 'order', 'removed', 'dry_run', 'resource', 'revision', 'branch', 'heartbeat', 'swarm_watch_complete'].includes(key)) && (!('swarm_watch_complete' in result) || result.swarm_watch_complete === true);
    },
  });
  api.registerItemFields(['swarm_branch', 'swarm_base', 'swarm_base_ref', 'swarm_token', 'swarm_claimed_at', 'swarm_handoff', 'swarm_resource_expires_at', 'swarm_preferred_agent', 'swarm_handoff_cost'].map(name => ({ name, type: 'string', optional: true })));

  for (const [name, definition] of Object.entries(swarmCommandDefinitions)) {
    const flags: FlagDefinition[] = definition.flags.map(flag => ({ long: `--${flag}`, description: flag, ...(['dry-run', 'apply', 'execute', 'full', 'strict', 'watch'].includes(flag) ? { value_type: 'boolean' as const } : { value_name: 'value', value_type: 'string' as const }) }));
    api.registerCommand(defineCommand({ name: `swarm ${name}`, description: definition.description, intent: 'Project management = context management: coordinate parallel agents on a shared tracker, with optional Git lanes', arguments: definition.id || name === 'heartbeat' ? [{ name: 'id', required: definition.id }] : [], flags, examples: [`pm swarm ${name}${definition.id ? ' task-id' : ''} --json`], run: ctx => runCommand(name, ctx) }));
  }
}
