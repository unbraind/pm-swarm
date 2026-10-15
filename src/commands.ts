import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { createPmCliExpectedError, readSettings, resolveAuthor } from '@unbrained/pm-cli/sdk';
import { defineCommand } from '@unbrained/pm-cli/sdk/authoring';
import type { CommandHandlerContext, ExtensionApi, FlagDefinition } from '@unbrained/pm-cli/sdk/authoring';
import { git } from './git.ts';
import { settings } from './settings.ts';
import { Swarm } from './swarm.ts';
import type { SwarmSettings } from './types.ts';

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
  const prefix = textOption(options.branchPrefix); if (prefix !== undefined) result.branch_prefix = prefix;
  const limit = textOption(options.limit); if (limit !== undefined) result.lane_limit = Number(limit);
  return result;
}
/** Dispatch native host context to the shared SDK engine; leave rendering to pm. */
export async function runCommand(command: string, ctx: CommandHandlerContext): Promise<Record<string, unknown>> {
  try {
    if (ctx.sdk === undefined) throw new Error('pm-swarm requires the host SDK command context');
    const repo = git(ctx.source_workspace_root ?? ctx.repo_root ?? ctx.pm_root, ['rev-parse', '--show-toplevel']);
    const client = ctx.sdk.client;
    const opts = overrides(ctx.options);
    const author = resolveAuthor(textOption(ctx.options.agent) ?? ctx.global.author, (await readSettings(ctx.pm_root)).author_default);
    const swarm = new Swarm(repo, ctx.pm_root, client, author);
    const id = ctx.args[0];
    if (['start', 'sync'].includes(command) && id === undefined) throw new Error('An item id is required');
    switch (command) {
      case 'plan': {
        const result = await swarm.plan(textOption(ctx.options.parent), opts.lane_limit);
        if (ctx.options.full === true || ctx.global.json === true) return result;
        const { complete_list: _complete, read_output: _read, ...compact } = result;
        return compact;
      }
      case 'start': return swarm.start(id, opts);
      case 'status': return swarm.status(ctx.options.full === true);
      case 'sync': return swarm.sync(id, ctx.options.apply === true && ctx.options.dryRun !== true);
      case 'land': return swarm.land(ctx.options.execute === true);
      case 'reap': return swarm.reap(ctx.options.dryRun === true);
      case 'settings': {
        const config = await settings(ctx.pm_root, opts);
        if (isAbsolute(config.root) || /^[A-Za-z]:/.test(config.root)) throw new Error('Tracked swarm root setting must be relative; use start --root for local absolute paths');
        if (ctx.options.apply === true) await ctx.sdk.mutateWorkspaceSettings({ operationId: randomUUID(), mutate: current => ({ ...current, swarm: config }) });
        return { swarm: config, dry_run: ctx.options.apply !== true };
      }
      default: throw new Error('Unknown swarm command');
    }
  } catch (error) {
    throw createPmCliExpectedError(String(error), { exitCode: 2 });
  }
}
/** Register portable fields and command metadata for host TOON/JSON rendering. */
export function register(api: ExtensionApi): void {
  api.registerItemFields(['swarm_branch', 'swarm_base', 'swarm_base_ref'].map(name => ({ name, type: 'string', optional: true })));
  const definitions = {
    plan: { description: 'Partition ready unclaimed work into safe parallel waves', flags: ['parent', 'limit', 'full'], id: false },
    start: { description: 'Claim an item and create a private worktree lane', flags: ['agent', 'base', 'root'], id: true },
    status: { description: 'Predict branch conflicts and report footprint drift', flags: ['full'], id: false },
    sync: { description: 'Preview changed-file links; --apply records them', flags: ['dry-run', 'apply'], id: true },
    land: { description: 'Find a clean landing order; --execute tests and merges locally', flags: ['execute', 'full'], id: false },
    reap: { description: 'Remove only merged terminal lanes and release own stale claims', flags: ['dry-run'], id: false },
    settings: { description: 'Preview or --apply SDK swarm settings', flags: ['base', 'root', 'branch-prefix', 'limit', 'apply'], id: false },
  };
  for (const [name, definition] of Object.entries(definitions)) {
    const flags: FlagDefinition[] = definition.flags.map(flag => ({ long: `--${flag}`, description: flag, ...(['dry-run', 'apply', 'execute', 'full'].includes(flag) ? { value_type: 'boolean' as const } : { value_name: 'value', value_type: 'string' as const }) }));
    api.registerCommand(defineCommand({ name: `swarm ${name}`, description: definition.description, intent: 'Project management = context management: derive safe parallel work from pm and Git', arguments: definition.id ? [{ name: 'id', required: true }] : [], flags, examples: [`pm swarm ${name}${definition.id ? ' task-id' : ''} --json`], run: ctx => runCommand(name, ctx) }));
  }
}
