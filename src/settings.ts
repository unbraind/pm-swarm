import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { getSettingsPath, readFileIfExists } from '@unbrained/pm-cli/sdk';
import type { ExtensionCommandSdk } from '@unbrained/pm-cli/sdk/authoring';
import { retryLock } from './lease.ts';
import type { SwarmSettings } from './types.ts';

/** Stable settings and output refusal categories, independent of local coordinates. */
export type SettingsRefusalCode = 'swarm_settings_invalid' | 'swarm_private_path';
/** Invalid configuration carries an actionable remedy without echoing its value. */
export class SettingsRefusal extends Error {
  /** Stable machine-readable refusal category. */
  readonly code: SettingsRefusalCode;
  /** Concrete corrective action for the caller. */
  readonly remedy: string;
  /** Construct a portable diagnostic safe for host error rendering. */
  constructor(code: SettingsRefusalCode, remedy: string) {
    super(`${code}: ${remedy}`); this.name = 'SettingsRefusal'; this.code = code; this.remedy = remedy;
  }
}
/** Package-owned section metadata; the pinned host has no settings registration API. */
export const swarmSettingsSection = {
  name: 'swarm',
  defaults: { base: 'main', root: '../.pm-swarm', branch_prefix: 'swarm/', lane_limit: 4 },
  flags: { base: '--base', root: '--root', branch_prefix: '--branch-prefix', lane_limit: '--limit', progress_orchestrator: '--progress-orchestrator' },
} as const;

/** Refuse nested output values and keys containing an absolute home location. */
export function assertPrivatePathSafe(value: unknown): void {
  const home = /(?:\/(?:home|Users)\/|\/(?:root)(?:\/|\b)|[A-Za-z]:[\\/]Users[\\/])/i;
  if (typeof value === 'string' && home.test(value)) throw new SettingsRefusal('swarm_private_path', 'Replace absolute home paths with project-relative paths before requesting this output.');
  if (Array.isArray(value)) for (const entry of value) assertPrivatePathSafe(entry);
  else if (typeof value === 'object' && value !== null) for (const [key, entry] of Object.entries(value)) { assertPrivatePathSafe(key); assertPrivatePathSafe(entry); }
}
/** Read the extension subtree through public SDK file APIs, never a second settings writer. */
async function rawSection(pmRoot: string): Promise<Record<string, unknown>> {
  let document: unknown;
  try { document = JSON.parse(await readFileIfExists(getSettingsPath(pmRoot)) ?? '{}'); }
  catch { throw new SettingsRefusal('swarm_settings_invalid', 'Repair the settings JSON document and retry swarm settings.'); }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) throw new SettingsRefusal('swarm_settings_invalid', 'Use an object for the settings document.');
  const section = (document as Record<string, unknown>).swarm;
  if (section === undefined) return {};
  if (typeof section !== 'object' || section === null || Array.isArray(section)) throw new SettingsRefusal('swarm_settings_invalid', 'Use an object for the swarm settings section.');
  return section as Record<string, unknown>;
}
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
  let config: SwarmSettings | undefined; let foreign = 0;
  await options.checkpoint?.('before_transaction');
  const operationId = options.operationId ?? randomUUID();
  const result = await retryLock(() => sdk.mutateWorkspaceSettings({
    operationId, dryRun: options.apply !== true,
    /** Derive the patch exclusively from the source protected by the SDK audit lock. */
    mutate: async current => {
      const section = await rawSection(pmRoot);
      await options.checkpoint?.('locked_read');
      config = resolveSwarmSettings(section, overrides);
      if (isAbsolute(config.root) || /^[A-Za-z]:/.test(config.root)) throw new SettingsRefusal('swarm_settings_invalid', 'Tracked swarm root setting must be relative; use a project-relative --root.');
      assertPrivatePathSafe(config);
      foreign = Object.keys(section).filter(key => !Object.hasOwn(swarmSettingsSection.flags, key)).length;
      await options.checkpoint?.('validated');
      return { ...current, swarm: { ...section, ...config } };
    },
  }));
  await options.checkpoint?.('committed');
  // A replay skips the callback. Report current settings rather than claiming our patch ran again.
  const effective = config ?? await settings(pmRoot);
  assertPrivatePathSafe(effective);
  return { swarm: effective, dry_run: result.dry_run, changed: !result.replayed && result.changed, replayed: result.replayed, skipped: { count: foreign, reason: 'Foreign settings are preserved without interpretation' } };
}
