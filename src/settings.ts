import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { getSettingsPath, readFileIfExists } from '@unbrained/pm-cli/sdk';
import type { BeforeMutationHook, ExtensionCommandSdk } from '@unbrained/pm-cli/sdk/authoring';
import { containsPrivatePath } from './privacy.ts';
import { retryLock } from './lease.ts';
import type { SwarmSettings } from './types.ts';

/** Stable settings and output refusal categories, independent of local coordinates. */
export type SettingsRefusalCode = 'swarm_settings_invalid' | 'swarm_private_path' | 'swarm_input_invalid';
/** Invalid configuration carries an actionable remedy without echoing its value. */
export class SettingsRefusal extends Error {
  /** Stable machine-readable refusal category. */
  readonly code: SettingsRefusalCode;
  /** Concrete corrective action for the caller. */
  readonly remedy: string;
  /** Safe structural field location for privacy refusals; never the offending value. */
  readonly field: string | undefined;
  /** Construct a portable diagnostic safe for host error rendering. */
  constructor(code: SettingsRefusalCode, remedy: string, field?: string) {
    super(`${code}: ${remedy}`); this.name = 'SettingsRefusal'; this.code = code; this.remedy = remedy; this.field = field;
  }
}
/** Package-owned section metadata; the pinned host has no settings registration API. */
export const swarmSettingsSection = {
  name: 'swarm',
  defaults: { base: 'main', root: '../.pm-swarm', branch_prefix: 'swarm/', lane_limit: 4 },
  flags: { base: '--base', root: '--root', branch_prefix: '--branch-prefix', lane_limit: '--limit', progress_orchestrator: '--progress-orchestrator' },
} as const;

/** Refuse nested values and report only safe structural field names, including opaque foreign keys. */
export function assertPrivatePathSafe(value: unknown, field = 'value'): void {
  if (typeof value === 'string' && containsPrivatePath(value)) throw new SettingsRefusal('swarm_private_path', `Remove private user-home paths from ${field}; replace them with project-relative references before retrying.`, field);
  if (Array.isArray(value)) for (const [index, entry] of value.entries()) assertPrivatePathSafe(entry, `${field}[${index}]`);
  else if (typeof value === 'object' && value !== null) for (const [key, entry] of Object.entries(value)) {
    const label = /^[a-z_][a-z0-9_]{0,63}$/i.test(key) ? key : '[foreign-key]';
    assertPrivatePathSafe(key, `${field}.${label}`); assertPrivatePathSafe(entry, `${field}.${label}`);
  }
}
/** A request-local flag limits whole-document hooks to this package's own mutations, allowing explicit core repairs. */
const ITEM_ADMISSION = new AsyncLocalStorage<{ refusal?: SettingsRefusal }>();
/** Require a full snapshot for every item writer and retain its guard scope through the SDK's item lock. */
export function commitItemMutation<Payload extends { id: string; options: unknown; item: Record<string, unknown> }, Result>(payload: Payload, commit: (admitted: Payload) => Promise<Result>): Promise<Result> {
  if (typeof payload.item !== 'object' || payload.item === null || Array.isArray(payload.item)) throw new SettingsRefusal('swarm_input_invalid', 'Supply the complete current item document before attempting this mutation.', 'document');
  assertPrivatePathSafe(payload.item, 'document');
  const scope: { refusal?: SettingsRefusal } = {};
  return commitMutation(payload, admitted => ITEM_ADMISSION.run(scope, async () => {
    try { return await commit(admitted); } catch (error) { throw scope.refusal ?? error; }
  }));
}
/** Admit the SDK's complete proposed document under its native writer lock before item/history persistence. */
export const guardItemDocument: BeforeMutationHook = context => {
  const scope = ITEM_ADMISSION.getStore();
  if (scope === undefined || context.after === null) return { allow: true };
  try { assertPrivatePathSafe(context.after, 'document'); return { allow: true }; }
  catch (error) {
    const refusal = error as SettingsRefusal; scope.refusal = refusal;
    return { allow: false, code: refusal.code, message: refusal.message, remediation: refusal.remedy };
  }
};
/** Admit the complete prospective mutation at its sink before invoking its sole writer.
 * Callbacks consume the admitted payload rather than recapturing uninspected data.
 * Storage coordinates and lease mechanics are not serialized mutation content.
 */
export function commitMutation<Value, Result>(payload: Value, commit: (admitted: Value) => Result): Result {
  assertPrivatePathSafe(payload);
  return commit(payload);
}
/** Read the extension subtree through public SDK file APIs, never a second settings writer. */
async function rawDocument(pmRoot: string): Promise<Record<string, unknown>> {
  let document: unknown;
  try { document = JSON.parse(await readFileIfExists(getSettingsPath(pmRoot)) ?? '{}'); }
  catch { throw new SettingsRefusal('swarm_settings_invalid', 'Repair the settings JSON document and retry swarm settings.'); }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) throw new SettingsRefusal('swarm_settings_invalid', 'Use an object for the settings document.');
  return document as Record<string, unknown>;
}
/** Validate only the owned section's shape while preserving all foreign document fields. */
function sectionOf(document: Record<string, unknown>): Record<string, unknown> {
  const section = document.swarm;
  if (section === undefined) return {};
  if (typeof section !== 'object' || section === null || Array.isArray(section)) throw new SettingsRefusal('swarm_settings_invalid', 'Use an object for the swarm settings section.');
  return section as Record<string, unknown>;
}
/** Read the package section through the complete source document without losing foreign fields. */
async function rawSection(pmRoot: string): Promise<Record<string, unknown>> { return sectionOf(await rawDocument(pmRoot)); }
/** Resolve only owned keys; retain foreign keys on writes without interpreting them. */
export function resolveSwarmSettings(section: Record<string, unknown>, overrides: Partial<SwarmSettings> = {}): SwarmSettings {
  const owned = Object.fromEntries(Object.keys(swarmSettingsSection.flags).filter(key => section[key] !== undefined).map(key => [key, section[key]]));
  const config = { ...swarmSettingsSection.defaults, ...owned, ...overrides } as SwarmSettings;
  for (const key of ['base', 'root', 'branch_prefix', 'progress_orchestrator'] as const) {
    const value = config[key];
    if (key === 'progress_orchestrator' && value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '' || /[\x00-\x1f\x7f]/.test(value)) throw new SettingsRefusal('swarm_settings_invalid', `Invalid swarm ${key}; supply one nonempty string without control characters.`);
  }
  if (!Number.isInteger(config.lane_limit) || config.lane_limit < 1 || config.lane_limit > 8) throw new SettingsRefusal('swarm_settings_invalid', 'swarm lane_limit must be an integer from 1 to 8; use --limit.');
  assertPrivatePathSafe(config);
  return config;
}
/** Read package settings with flags taking precedence over each configured leaf. */
export async function settings(pmRoot: string, overrides: Partial<SwarmSettings> = {}): Promise<SwarmSettings> {
  return resolveSwarmSettings(await rawSection(pmRoot), overrides);
}
/** Persisted lane configuration remains portable even when a non-home absolute path is public prose. */
export function validatePersistedRoot(config: SwarmSettings): void {
  if (/^(?:[/\\]|[a-z]:)/i.test(config.root)) throw new SettingsRefusal('swarm_settings_invalid', 'Use a project-relative swarm root before saving settings.');
}
/** Package write boundaries exposed for deterministic failure and interleaving verification. */
export type SettingsBoundary = 'before_transaction' | 'locked_read' | 'validated' | 'committed';
/** Replay-safe mutation options; callbacks execute inside the host lock when appropriate. */
export interface SettingsMutationOptions {
  apply?: boolean;
  operationId?: string;
  checkpoint?: (boundary: SettingsBoundary) => void | Promise<void>;
}
/** Compact mutation receipt; no complete host settings tree or filesystem coordinates. */
export interface SettingsReceipt {
  swarm: SwarmSettings;
  dry_run: boolean;
  changed: boolean;
  replayed: boolean;
  skipped: { count: number; reason: string };
}
/** Patch the freshly locked subtree, leaving every foreign setting intact and releasing last. */
export async function updateSettings(sdk: Pick<ExtensionCommandSdk, 'mutateWorkspaceSettings'>, pmRoot: string, overrides: Partial<SwarmSettings> = {}, options: SettingsMutationOptions = {}): Promise<SettingsReceipt> {
  assertPrivatePathSafe({ overrides, operationId: options.operationId });
  validatePersistedRoot(await settings(pmRoot, overrides));
  let config: SwarmSettings | undefined; let foreign = 0;
  await options.checkpoint?.('before_transaction');
  const operationId = options.operationId ?? randomUUID();
  const result = await retryLock(() => commitMutation({ operationId, dryRun: options.apply !== true }, admitted => sdk.mutateWorkspaceSettings({
    ...admitted,
    /** Derive the patch exclusively from the source protected by the SDK audit lock. */
    mutate: async current => {
      const source = await rawDocument(pmRoot); const section = sectionOf(source);
      await options.checkpoint?.('locked_read');
      config = resolveSwarmSettings(section, overrides);
      assertPrivatePathSafe(config);
      validatePersistedRoot(config);
      foreign = Object.keys(section).filter(key => !Object.hasOwn(swarmSettingsSection.flags, key)).length;
      await options.checkpoint?.('validated');
      const patch = { ...current, swarm: { ...section, ...config } };
      assertPrivatePathSafe({ ...source, swarm: patch.swarm }, 'settings');
      assertPrivatePathSafe(patch, 'settings');
      return commitMutation(patch, admitted => admitted);
    },
  })));
  await options.checkpoint?.('committed');
  // A replay skips the callback. Report current settings rather than claiming our patch ran again.
  const effective = config ?? await settings(pmRoot);
  assertPrivatePathSafe(effective);
  return { swarm: effective, dry_run: result.dry_run, changed: !result.replayed && result.changed, replayed: result.replayed, skipped: { count: foreign, reason: 'Foreign settings are preserved without interpretation' } };
}
