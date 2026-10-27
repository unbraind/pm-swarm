import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { getSettingsPath, readFileIfExists, PmClient, getHistoryPath, readHistorySnapshot, hashHistoryStream, resolveHistoryTarget } from '@unbrained/pm-cli/sdk';
import type { ItemDocument } from '@unbrained/pm-cli/sdk';
import type { BeforeMutationHook, ExtensionCommandSdk, OnWriteHook } from '@unbrained/pm-cli/sdk/authoring';
import { containsPrivatePath } from './privacy.ts';
import { retryLock } from './lease.ts';
import type { SwarmSettings } from './types.ts';

/** Stable settings and output refusal categories, independent of local coordinates. */
export type SettingsRefusalCode = 'swarm_settings_invalid' | 'swarm_private_path' | 'swarm_input_invalid' | 'swarm_sdk_mismatch' | 'swarm_document_changed' | 'swarm_partial_commit' | 'swarm_superseded';
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
/** Portable refusal details cross package copies without relying on cross-module instanceof checks. */
interface AdmissionRefusal { code: SettingsRefusalCode; remedy: string; field?: string }
/** One admitted document and its verified native successors travel through the host commit. */
interface ItemAdmissionScope { related?: Map<string, ItemAdmissionScope>; id: string; expected: string; pending?: string; committed: number; refusal?: AdmissionRefusal; generation?: { token: unknown }; history?: ItemHistoryHead; beforeWrite?: () => Promise<void>; onCommitted?: (before: ItemDocument, after: ItemDocument) => void }
/** Observable boundaries cover the complete handoff from checked snapshot into the host's atomic writer. */
export const ITEM_MUTATION_BOUNDARIES = ['admitted', 'scoped', 'before_commit'] as const;
/** Trusted request-local instrumentation may observe or interrupt transitions, never replace SDK results. */
type ItemMutationObserver = (boundary: typeof ITEM_MUTATION_BOUNDARIES[number]) => void | Promise<void>;
/** A process-wide registry shares request scope between source, distribution and installed package copies. */
interface AdmissionRuntime { scopes: AsyncLocalStorage<ItemAdmissionScope>; observers: AsyncLocalStorage<ItemMutationObserver>; reads: AsyncLocalStorage<{ active: boolean }>; identities: Set<unknown> }
/** Public module identity, rather than a version string, distinguishes physically separate SDK runtimes. */
const ADMISSION_KEY = Symbol.for('pm-swarm.item-admission/v1');
const ADMISSION = (Reflect.get(globalThis, ADMISSION_KEY) as AdmissionRuntime | undefined) ?? { scopes: new AsyncLocalStorage<ItemAdmissionScope>(), observers: new AsyncLocalStorage<ItemMutationObserver>(), reads: new AsyncLocalStorage<{ active: boolean }>(), identities: new Set<unknown>() };
Object.defineProperty(globalThis, ADMISSION_KEY, { value: ADMISSION });
ADMISSION.identities.add(PmClient);
/** Instrument one operation without a process-global callback or substitution of SDK reads/writes. */
export function withItemMutationObserver<Result>(observer: ItemMutationObserver, operation: () => Result): Result {
  return ADMISSION.observers.run(observer, operation);
}
/** Confirm the bound client's active package hooks before acquiring a native core claim. */
export async function requireActiveExtensionRead<Result>(operation: () => Promise<Result>): Promise<Result> {
  const probe = { active: false }; const result = await ADMISSION.reads.run(probe, operation);
  if (!probe.active) throw new SettingsRefusal('swarm_sdk_mismatch', 'Use the host SDK client with the active extension enabled; activate pm-swarm and retry before acquiring a claim.');
  return result;
}
/** A request-local SDK read proves activation without changing its result or storing a receipt. */
export function recordActiveExtensionRead(): void {
  const probe = ADMISSION.reads.getStore(); if (probe !== undefined) probe.active = true;
}
/** Refuse split SDK runtimes before reads can select a writer or acquire a package lease. */
export function assertSdkInstance(client?: unknown): void {
  if (ADMISSION.identities.size !== 1 || (client !== undefined && !(client instanceof PmClient))) throw new SettingsRefusal('swarm_sdk_mismatch', 'Use the host SDK client and one shared pm SDK installation; remove the nested SDK dependency, reinstall the extension and restart the process.');
}
/** Remove only SDK read projections, then compare every persisted field and the complete body canonically. */
export function documentFingerprint(item: Record<string, unknown>): string {
  const collections = ['comments', 'notes', 'learnings', 'files', 'tests', 'docs', 'reminders', 'events'];
  const metadata = Object.fromEntries(Object.entries(item).filter(([key, value]) => !['body', 'notes_count', 'tests_count', 'collection_counts'].includes(key)
    && !(collections.includes(key) && Array.isArray(value) && value.length === 0)));
  return JSON.stringify({ metadata, body: item.body ?? '' }, (_key, value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value);
}
/** A changed fencing generation belongs to a peer, including a same-author replacement. */
export function assertClaimGeneration(current: unknown, expected: unknown): void {
  if (current !== expected) throw new SettingsRefusal('swarm_superseded', 'A peer owns a different claim generation. Preserve its item and Git resources; refresh the current token before retrying.', 'swarm_token');
}
/** Append-only SDK revision: document hashes and fencing generations alone cannot distinguish ABA. */
export interface ItemHistoryHead { length: number; hash: string }
/** Read the native stream once through the SDK, retaining both its monotonic length and record identity. */
export async function readItemHistoryHead(pmRoot: string, id: string, version?: number): Promise<ItemHistoryHead> {
  try {
    const { entries } = await readHistorySnapshot(getHistoryPath(pmRoot, id), id);
    const end = version === undefined ? entries.length : resolveHistoryTarget(String(version), entries).historyIndex + 1;
    return { length: end, hash: hashHistoryStream(entries.slice(0, end)) };
  } catch { throw new SettingsRefusal('swarm_superseded', 'Native item history cannot be verified. Preserve its claim and Git resources; inspect native history before retrying.', 'history'); }
}
/** Call only inside the native item writer lock, before any cleanup mutation or Git deletion. */
export async function assertItemHistoryHead(pmRoot: string, id: string, expected: ItemHistoryHead): Promise<void> {
  const current = await readItemHistoryHead(pmRoot, id);
  if (current.length !== expected.length || current.hash !== expected.hash) throw new SettingsRefusal('swarm_superseded', 'Native item history advanced or changed after the checked snapshot. Preserve the peer claim and Git resources; refresh its history before retrying.', 'history');
}
/** Require a full snapshot for every item writer and retain its guard scope through the SDK's item lock. */
export function commitItemMutation<Payload extends { id: string; options: unknown; item: Record<string, unknown> }, Result>(payload: Payload, commit: (admitted: Payload) => Promise<Result>, options: { history: ItemHistoryHead } & { related?: ReadonlyMap<string, { item: Record<string, unknown>; history: ItemHistoryHead }>; transaction?: boolean; generation?: { token: unknown }; beforeWrite?: () => Promise<void>; onCommitted?: (before: ItemDocument, after: ItemDocument) => void }): Promise<Result> {
  if (typeof payload.item !== 'object' || payload.item === null || Array.isArray(payload.item)) throw new SettingsRefusal('swarm_input_invalid', 'Supply the complete current item document before attempting this mutation.', 'document');
  assertPrivatePathSafe(payload.item, 'document');
  if (options.history === undefined || !Number.isSafeInteger(options.history.length) || typeof options.history.hash !== 'string') throw new SettingsRefusal('swarm_input_invalid', 'Supply the native history head captured before reading the complete decision document; never refresh it at commit time.', 'history');
  assertSdkInstance();
  const id = String(payload.item.id); const expected = documentFingerprint(payload.item);
  const related = options.related === undefined ? undefined : new Map([...options.related].map(([id, value]) => [id, { id, expected: documentFingerprint(value.item), history: value.history, committed: 0, onCommitted: options.onCommitted }]));
  const checkpoint = ADMISSION.observers.getStore();
  return commitMutation(payload, async admitted => {
    const history = options.history;
    const scope: ItemAdmissionScope = { id, expected, related, committed: 0, generation: options.generation, history, beforeWrite: options.beforeWrite, onCommitted: options.onCommitted };
    await checkpoint?.('admitted');
    return ADMISSION.scopes.run(scope, async () => {
      await checkpoint?.('scoped');
      await checkpoint?.('before_commit');
      try { return await commit(admitted); } catch (error) {
        if (scope.committed > 0 && options.transaction !== true) throw new SettingsRefusal('swarm_partial_commit', `${scope.committed} native item mutation(s) already committed; inspect the current tracker before retrying. ${scope.refusal?.remedy ?? 'The SDK refused a later step in its compound operation.'}`, scope.refusal?.field);
        if (scope.refusal !== undefined) throw new SettingsRefusal(scope.refusal.code, scope.refusal.remedy, scope.refusal.field);
        throw error;
      }
    });
  });
}
/** Admit the SDK's complete proposed document under its native writer lock before item/history persistence. */
export const guardItemDocument: BeforeMutationHook = async context => {
  const primary = ADMISSION.scopes.getStore();
  const id = context.before?.metadata.id ?? context.after?.metadata.id;
  const scope = primary === undefined || id === primary.id ? primary : primary.related?.get(String(id));
  if (primary !== undefined && scope === undefined) {
    primary.refusal = { code: 'swarm_document_changed', remedy: 'Refresh the native lifecycle documents before retrying this compound operation.', field: 'document' };
    return { allow: false, code: primary.refusal.code, remediation: primary.refusal.remedy };
  }
  if (scope === undefined) return { allow: true };
  try {
    assertSdkInstance();
    if (scope.history !== undefined) await assertItemHistoryHead(context.pm_root, scope.id, scope.history);
    if (scope.generation !== undefined) assertClaimGeneration(context.before?.metadata.swarm_token, scope.generation.token);
    assertPrivatePathSafe(context.after, 'document');
    if (context.before === null || documentFingerprint({ ...context.before.metadata, body: context.before.body }) !== scope.expected) throw new SettingsRefusal('swarm_document_changed', 'The item changed after admission; refresh its complete document, re-evaluate ownership and retry with the current receipt.', 'document');
    await scope.beforeWrite?.();
    scope.pending = context.after === null ? undefined : documentFingerprint({ ...context.after.metadata, body: context.after.body });
    return { allow: true };
  }
  catch (error) {
    const refusal = error as SettingsRefusal; scope.refusal = { code: refusal.code, remedy: refusal.remedy, field: refusal.field };
    return { allow: false, code: refusal.code, message: refusal.message, remediation: refusal.remedy };
  }
};
/** Advance only a natively committed, previously admitted successor, never a peer edit or a cache/history notification. */
export const recordItemCommit: OnWriteHook = context => {
  const primary = ADMISSION.scopes.getStore();
  const scope = context.item_id === primary?.id ? primary : primary?.related?.get(String(context.item_id));
  if (scope?.pending === undefined || context.before === undefined || context.after === undefined) return;
  const before = documentFingerprint({ ...context.before.metadata, body: context.before.body });
  const after = documentFingerprint({ ...context.after.metadata, body: context.after.body });
  if (before !== scope.expected || after !== scope.pending) return;
  scope.expected = after; scope.pending = undefined; scope.committed++;
  scope.onCommitted?.(context.before, context.after);
};
/** Admit the complete prospective mutation at its sink before invoking its sole writer.
 * Callbacks consume the admitted payload rather than recapturing uninspected data.
 * Storage coordinates and lease mechanics are not serialized mutation content.
 */
export function commitMutation<Value, Result>(payload: Value, commit: (admitted: Value) => Result): Result {
  assertPrivatePathSafe(payload);
  assertSdkInstance();
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
export async function updateSettings(sdk: Pick<ExtensionCommandSdk, 'client' | 'mutateWorkspaceSettings'>, pmRoot: string, overrides: Partial<SwarmSettings> = {}, options: SettingsMutationOptions = {}): Promise<SettingsReceipt> {
  assertPrivatePathSafe({ overrides, operationId: options.operationId });
  assertSdkInstance(sdk.client);
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
