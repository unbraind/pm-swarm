import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import { assertPrivatePathSafe, resolveSwarmSettings, SettingsRefusal, validatePersistedRoot } from './settings.ts';
import { FairPolicy } from './fair-scheduling.ts';
import { ProgressRefusal, validateProgressWitness } from './progress.ts';
import type { ProgressStage } from './progress.ts';
import { ResourceRefusal, validateResourceToken } from './resources.ts';
import { footprintPath } from './planner.ts';

/** Refuse invalid input without echoing it or entering a tracker writer lease. */
function invalid(remedy: string): never { throw new SettingsRefusal('swarm_input_invalid', remedy); }
/** Validate the complete command payload before dispatch can read, lease or write a tracker. */
export function validateCommandInputs(command: string, ctx: CommandHandlerContext): void {
  assertPrivatePathSafe({ args: ctx.args, options: ctx.options, global: ctx.global });
  if (ctx.global.author !== undefined && (typeof ctx.global.author !== 'string' || !ctx.global.author.trim())) invalid('Supply one nonempty author identity.');
  for (const arg of ctx.args) if (typeof arg !== 'string' || !arg.trim()) invalid('Supply nonempty item ids.');
  for (const [name, value] of Object.entries(ctx.options)) {
    if (value === undefined) continue;
    if (['dryRun', 'apply', 'execute', 'full', 'strict', 'watch'].includes(name)) {
      if (typeof value !== 'boolean') invalid('Supply boolean switches without a value.');
    } else if (typeof value !== 'string' || !value.trim()) invalid('Supply one nonempty value for each flag.');
  }
  validateActionInputs(command, ctx.options);
  const options = ctx.options as Record<string, string | boolean | undefined>;
  if (['start', 'sync', 'handoff', 'close', 'resource', 'progress'].includes(command) && ctx.args[0] === undefined) invalid('An item id is required.');
  if (options.token !== undefined && !/^\d+$/.test(String(options.token))) invalid('Use the decimal --token returned by the last successful claim.');
  if (['settings', 'start', 'plan'].includes(command)) {
    const config = resolveSwarmSettings({}, {
      ...(options.base === undefined ? {} : { base: String(options.base) }),
      ...(options.root === undefined ? {} : { root: String(options.root) }),
      ...(options.branchPrefix === undefined ? {} : { branch_prefix: String(options.branchPrefix) }),
      ...(options.progressOrchestrator === undefined ? {} : { progress_orchestrator: String(options.progressOrchestrator) }),
      ...(options.limit === undefined ? {} : { lane_limit: Number(options.limit) }),
    });
    if (command === 'settings') validatePersistedRoot(config);
  }
  if (command === 'sync' && typeof options.files === 'string') {
    for (const file of options.files.split(',')) { if (!file.trim()) invalid('sync --files requires nonempty comma-separated paths.'); footprintPath(file.trim()); }
  }
  if (['handoff', 'close'].includes(command)) {
    if (typeof options.note !== 'string' || !options.note.trim()) invalid(`${command} requires a nonempty --note.`);
    if (command === 'handoff' && (typeof options.to !== 'string' || options.note.length > 4096)) invalid('handoff requires --to and a --note of at most 4096 characters.');
  }
}

/** Validate action-specific numeric and declaration inputs without opening a backend. */
export function validateActionInputs(command: string, options: Record<string, unknown>): void {
  if (command === 'schedule') new FairPolicy('input-admission', { skills: options.skills === undefined ? [] : String(options.skills).split(',').map(value => value.trim()), maxWaitSeconds: options.maxWait === undefined ? undefined : Number(options.maxWait), limit: options.limit === undefined ? undefined : Number(options.limit) });
  if (command === 'resource') {
    const action = options.action ?? 'status';
    if (!['status', 'reserve', 'renew', 'release', 'publish'].includes(String(action))) throw new ResourceRefusal('resource_invalid', 'Use --action status, reserve, renew, release or publish.');
    if (options.ttl !== undefined && (!Number.isInteger(Number(options.ttl)) || Number(options.ttl) < 1 || Number(options.ttl) > 86400)) throw new ResourceRefusal('resource_invalid', 'Set --ttl to integer seconds from 1 through 86400.');
    if (action === 'publish' && (typeof options.note !== 'string' || !options.note.trim() || options.note.length > 4096)) throw new ResourceRefusal('resource_invalid', 'Supply a nonempty --note of at most 4096 characters.');
    if (['renew', 'release', 'publish'].includes(String(action))) validateResourceToken(options.token);
  }
  if (command === 'reclaim' && (!Number.isFinite(Number(options.staleAfter)) || Number(options.staleAfter) <= 0)) invalid('reclaim requires --stale-after as positive seconds.');
  if (command === 'progress') {
    if ((options.offset !== undefined && (!Number.isInteger(Number(options.offset)) || Number(options.offset) < 0)) || (options.limit !== undefined && (!Number.isInteger(Number(options.limit)) || Number(options.limit) < 1 || Number(options.limit) > 100))) throw new ProgressRefusal('progress_invalid', 'Use a nonnegative integer --offset and --limit from 1 through 100.');
    if (options.stage !== undefined) validateProgressWitness({ stage: String(options.stage) as ProgressStage, step: String(options.step ?? ''), revision: String(options.revision ?? ''), evidence: String(options.evidence ?? '') });
    else if (options.apply === true || options.step !== undefined || options.evidence !== undefined) throw new ProgressRefusal('progress_invalid', 'Supply --stage, --step, --revision and --evidence to declare a witness.');
  }
}
