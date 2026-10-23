import { SchedulingRefusal } from './fair-scheduling.ts';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { createPmCliExpectedError, readSettings, resolveAuthor } from '@unbrained/pm-cli/sdk';
import { defineCommand } from '@unbrained/pm-cli/sdk/authoring';
import type { CommandHandlerContext, ExtensionApi, FlagDefinition } from '@unbrained/pm-cli/sdk/authoring';
import { repositoryRoot } from './workspace.ts';
import { SharedTracker, SHARED_LAND_REFUSAL } from './shared-tracker.ts';
import { settings } from './settings.ts';
import { retryLock, StaleFenceError } from './lease.ts';
import { Swarm } from './swarm.ts';
import { runWatch, watchInterval } from './watch.ts';
import type { SwarmSettings } from './types.ts';
import { ResourceReservations, ResourceRefusal } from './resources.ts';
import { trackerResourceBackend } from './resource-tracker.ts';
import { PlanProgress, ProgressRefusal } from './progress.ts';
import type { ProgressStage } from './progress.ts';

/** Read a scalar flag without accepting repeated or non-text values. */
function textOption(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') throw new Error('Expected one nonempty flag value');
  return value;
}
/** Preserve flag precedence without injecting undefined over configured defaults. */
function overrides(options: Record<string, unknown>): Partial<SwarmSettings> {
  const result: Partial<SwarmSettings> = {};
  for (const key of ['base', 'root'] as const) { const value = textOption(options[key]); if (value !== undefined) result[key] = value; }
  const orchestrator = textOption(options.progressOrchestrator); if (orchestrator !== undefined) result.progress_orchestrator = orchestrator;
  const prefix = textOption(options.branchPrefix); if (prefix !== undefined) result.branch_prefix = prefix;
  const limit = textOption(options.limit); if (limit !== undefined) result.lane_limit = Number(limit);
  return result;
}
/** Dispatch native host context to the shared SDK engine; leave rendering to pm. */
export async function runCommand(command: string, ctx: CommandHandlerContext): Promise<Record<string, unknown>> {
  try {
    if (ctx.sdk === undefined) throw new Error('pm-swarm requires the host SDK command context');
    const workspace = ctx.source_workspace_root ?? ctx.repo_root ?? ctx.pm_root;
    const repo = ['settings', 'heartbeat', 'reclaim', 'handoff', 'close', 'resource', 'progress'].includes(command) ? undefined : repositoryRoot(workspace);
    const client = ctx.sdk.client;
    const opts = overrides(ctx.options);
    const author = resolveAuthor(textOption(ctx.options.agent) ?? ctx.global.author, (await readSettings(ctx.pm_root)).author_default);
    const swarm = repo === undefined ? new SharedTracker(new Swarm(workspace, ctx.pm_root, client, author)) : new Swarm(repo, ctx.pm_root, client, author);
    const id = ctx.args[0];
    if (['start', 'sync', 'handoff', 'close', 'resource', 'progress'].includes(command) && id === undefined) throw new Error('An item id is required');
    switch (command) {
      case 'progress': {
        const progress = new PlanProgress({ cwd: workspace, pmRoot: ctx.pm_root, author: ctx.global.author }, true);
        const options = { agent: textOption(ctx.options.agent), orchestrator: textOption(ctx.options.orchestrator), revision: textOption(ctx.options.revision), offset: ctx.options.offset === undefined ? undefined : Number(textOption(ctx.options.offset)), limit: ctx.options.limit === undefined ? undefined : Number(textOption(ctx.options.limit)) };
        const stage = textOption(ctx.options.stage);
        if (stage === undefined) {
          if (ctx.options.apply === true || ctx.options.step !== undefined || ctx.options.evidence !== undefined) throw new ProgressRefusal('progress_invalid', 'Supply --stage, --step, --revision and --evidence to declare a witness; omit --apply to preview.');
          return { ...await progress.view(id, options) };
        }
        return { ...await progress.witness(id, { ...options, stage: stage as ProgressStage, step: textOption(ctx.options.step) ?? '', revision: options.revision ?? '', evidence: textOption(ctx.options.evidence) ?? '', apply: ctx.options.apply === true }) };
      }
      case 'resource': {
        const resources = new ResourceReservations(trackerResourceBackend((swarm as SharedTracker).engine), author);
        const action = textOption(ctx.options.action) ?? 'status'; const token = textOption(ctx.options.token) ?? '';
        switch (action) {
          case 'status': return { ...await resources.status(id) };
          case 'reserve': return { ...await resources.reserve(id, ctx.options.ttl === undefined ? undefined : Number(textOption(ctx.options.ttl))) };
          case 'renew': return { ...await resources.renew(id, token, ctx.options.ttl === undefined ? undefined : Number(textOption(ctx.options.ttl))) };
          case 'release': return { ...await resources.release(id, token) };
          case 'publish': return { ...await resources.publish(id, token, textOption(ctx.options.note) ?? '') };
          default: throw new ResourceRefusal('resource_invalid', 'Use --action status, reserve, renew, release or publish.');
        }
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
        return repo === undefined ? await operation : operation;
      }
      case 'start': {
        const operation = swarm.start(id, opts, ctx.options.strict === true);
        return repo === undefined ? await operation : operation;
      }
      case 'status': {
        if (ctx.options.watch === true) {
          await runWatch(swarm, watchInterval(textOption(ctx.options.interval)), ctx.global.json === true || ctx.global.outputFormat === 'json');
          return { swarm_watch_complete: true };
        }
        if (ctx.options.interval !== undefined) throw new Error('--interval requires --watch');
        const operation = swarm.status(ctx.options.full === true);
        return repo === undefined ? await operation : operation;
      }
      case 'sync': {
        const operation = swarm.sync(id, ctx.options.apply === true && ctx.options.dryRun !== true, textOption(ctx.options.files)?.split(',').map(path => path.trim()), textOption(ctx.options.token));
        return await operation;
      }
      case 'heartbeat': return await (swarm as SharedTracker).heartbeat(id, textOption(ctx.options.token));
      case 'handoff': return await (swarm as SharedTracker).handoff(id, textOption(ctx.options.to) ?? '', textOption(ctx.options.note) ?? '', textOption(ctx.options.token));
      case 'reclaim': return await (swarm as SharedTracker).reclaim(Number(textOption(ctx.options.staleAfter)), textOption(ctx.options.to), ctx.options.dryRun === true, textOption(ctx.options.parent));
      case 'close': return await (swarm as SharedTracker).close(id, textOption(ctx.options.note) ?? '', textOption(ctx.options.token));
      case 'land': {
        if (repo === undefined) throw new Error(SHARED_LAND_REFUSAL);
        return swarm.land(ctx.options.execute === true);
      }
      case 'reap': {
        const operation = swarm.reap(ctx.options.dryRun === true);
        return repo === undefined ? await operation : operation;
      }
      case 'settings': {
        const config = await settings(ctx.pm_root, opts);
        if (isAbsolute(config.root) || /^[A-Za-z]:/.test(config.root)) throw new Error('Tracked swarm root setting must be relative; use start --root for local absolute paths');
        if (ctx.options.apply === true) await retryLock(() => ctx.sdk!.mutateWorkspaceSettings({ operationId: randomUUID(), mutate: current => ({ ...current, swarm: config }) }));
        return { swarm: config, dry_run: ctx.options.apply !== true };
      }
      default: throw new Error('Unknown swarm command');
    }
  } catch (error) {
    throw createPmCliExpectedError(String(error), { exitCode: 2, ...(error instanceof SchedulingRefusal || error instanceof ResourceRefusal || error instanceof ProgressRefusal ? { context: { code: error.code, required: error.remedy } } : error instanceof StaleFenceError ? { context: { code: error.code } } : {}) });
  }
}
/** Register portable fields and command metadata for host TOON/JSON rendering. */
export function register(api: ExtensionApi): void {
  for (const format of ['toon', 'json'] as const) api.registerRenderer(format, () => '', {
    commands: ['swarm status'],
    resultDiscriminator: result => typeof result === 'object' && result !== null && 'swarm_watch_complete' in result && result.swarm_watch_complete === true,
  });
  api.registerItemFields(['swarm_branch', 'swarm_base', 'swarm_base_ref', 'swarm_token', 'swarm_claimed_at', 'swarm_handoff', 'swarm_resource_expires_at', 'swarm_preferred_agent', 'swarm_handoff_cost'].map(name => ({ name, type: 'string', optional: true })));
  const definitions = {
    progress: { description: 'Read revision-bound Plan progress or explicitly append a witness', flags: ['agent', 'orchestrator', 'revision', 'offset', 'limit', 'stage', 'step', 'evidence', 'apply'], id: true },
    resource: { description: 'Reserve, renew, release or publish with an exclusive resource fence', flags: ['agent', 'action', 'ttl', 'token', 'note'], id: true },
    plan: { description: 'Partition ready unclaimed work into safe parallel waves', flags: ['parent', 'limit', 'full'], id: false },
    schedule: { description: 'Select qualified ready work with starvation promotion and handoff costs', flags: ['agent', 'skills', 'max-wait', 'parent', 'limit', 'dry-run'], id: false },
    next: { description: 'Pick and start the best safe ready item', flags: ['agent', 'parent', 'dry-run'], id: false },
    start: { description: 'Claim an item; create a worktree lane when inside Git', flags: ['agent', 'base', 'root', 'strict'], id: true },
    status: { description: 'Report active lanes and overlaps; predict conflicts in Git', flags: ['full', 'watch', 'interval'], id: false },
    sync: { description: 'Preview changed-file links; --apply records them', flags: ['agent', 'dry-run', 'apply', 'files', 'token'], id: true },
    heartbeat: { description: 'Renew agent liveness, optionally fencing an item', flags: ['agent', 'token'], id: false },
    reclaim: { description: 'Recover claims from agents that stopped heartbeating', flags: ['agent', 'stale-after', 'to', 'parent', 'dry-run'], id: false },
    handoff: { description: 'Transfer fenced ownership with receiver context atomically', flags: ['agent', 'to', 'note', 'token'], id: true },
    close: { description: 'Finish and release a fenced claim atomically', flags: ['agent', 'note', 'token'], id: true },
    land: { description: 'Find a clean landing order; --execute tests and merges locally', flags: ['execute', 'full'], id: false },
    reap: { description: 'Remove only merged terminal lanes and release own stale claims', flags: ['agent', 'dry-run'], id: false },
    settings: { description: 'Preview or --apply SDK swarm settings', flags: ['base', 'root', 'branch-prefix', 'limit', 'progress-orchestrator', 'apply'], id: false },
  };
  for (const [name, definition] of Object.entries(definitions)) {
    const flags: FlagDefinition[] = definition.flags.map(flag => ({ long: `--${flag}`, description: flag, ...(['dry-run', 'apply', 'execute', 'full', 'strict', 'watch'].includes(flag) ? { value_type: 'boolean' as const } : { value_name: 'value', value_type: 'string' as const }) }));
    api.registerCommand(defineCommand({ name: `swarm ${name}`, description: definition.description, intent: 'Project management = context management: coordinate parallel agents on a shared tracker, with optional Git lanes', arguments: definition.id || name === 'heartbeat' ? [{ name: 'id', required: definition.id }] : [], flags, examples: [`pm swarm ${name}${definition.id ? ' task-id' : ''} --json`], run: ctx => runCommand(name, ctx) }));
  }
}
