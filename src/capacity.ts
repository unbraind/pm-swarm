import { capacityCommand } from './capacity-command.ts';
import { capacityInstant } from './capacity-time.ts';
import { RESOURCE_TAG } from './resources.ts';
import type { FairPolicy } from './fair-scheduling.ts';
import { laneCapacityState, interruptions } from './interruption.ts';
import { normalizeItemId, readSettings, resolveRuntimeStatusRegistry, scanMutationSecrets, statusIsTerminal } from '@unbrained/pm-cli/sdk';
import { clientMutationSnapshot, inspectItems } from './inspection.ts';
import { withSwarmLease } from './lease.ts';
import type { Lease } from './lease.ts';
import { assertPrivatePathSafe, commitItemMutation, commitMutation } from './settings.ts';
import type { RuntimeStatusRegistry } from '@unbrained/pm-cli/sdk';
import type { Swarm } from './swarm.ts';

/** Native capacity records are reserved for swarm coordination. */
export const CAPACITY_TAG = 'swarm-capacity';
/** Registered native field holding the current window and forecast inputs. */
export const CAPACITY_FIELD = 'swarm_capacity_window';
/** Registered lane field storing the capacity selected at acquisition. */
export const LANE_CAPACITY_FIELD = 'swarm_capacity';
/** Both forecast inputs must be no more than 24 hours old. */
export const OBSERVATION_MAX_AGE_MS = 86_400_000;

/** A caller-reported cumulative measurement. */
export interface CapacityObservation { at: string; used: number; source: string }
/** Ordered exclusive upper bounds in the declared unit. */
interface CapacityPolicy { bands: string[]; otherwise: number; forecast: 'recent' | 'window' | 'max' }

/** One declared window, with the latest inputs retained in the native item projection. */
interface CapacityWindow {
  name: string;
  limit: number;
  unit: string;
  window: number;
  resets_at: string;
  observations: CapacityObservation[];
  policy: CapacityPolicy;
}

/** Stable capacity refusal categories. */
export type CapacityRefusalCode = 'capacity_invalid' | 'capacity_undeclared' | 'capacity_forecast_exceeded' | 'capacity_exhausted' | 'capacity_lanes_occupied' | 'capacity_policy_denied';

/** Measurement and recovery fields portable across the supported host range. */
type CapacityRefusalDetails = Record<string, string | number | boolean | null>;

/** Carry an actionable command and structured measurements through CLI and SDK refusals. */
export class CapacityRefusal extends Error {
  /** Stable refusal reason for automation. */
  readonly code: CapacityRefusalCode;
  /** Runnable recovery instruction or input correction. */
  readonly remedy: string;
  /** Portable measurement context when a capacity was resolved. */
  readonly details?: CapacityRefusalDetails;
  /** Build a refusal without echoing invalid raw values. */
  constructor(code: CapacityRefusalCode, remedy: string, details?: CapacityRefusalDetails) {
    super(code + ': ' + remedy);
    this.code = code;
    this.remedy = remedy;
    this.details = details;
  }
}

/** Refuse to operate on a capacity record as a work item. */
export function assertNotCapacity(item: Record<string, unknown>): void {
  if ((item.tags as string[]).includes(CAPACITY_TAG)) throw new Error(`Capacity records require ${capacityCommand('capacity', '--help')}.`);
}

/** Keep capacity and resource control items outside both start engines. */
export function assertStartWorkItem(item: Record<string, unknown>): void {
  const tags = item.tags as string[];
  assertNotCapacity(item);
  if (tags.includes(RESOURCE_TAG)) throw new Error('Resource items require swarm resource; use an ordinary work item for start.');
}

/** Normalize logical capacity names before matching their native records or rendering a retry command. */
export function capacityName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name) || scanMutationSecrets(name).length) throw new CapacityRefusal('capacity_invalid', 'Use a capacity name of at most 40 letters, digits and hyphens, starting with a letter.');
  return name;
}

/** Validate the contents of labels without storing credential-shaped text. */
function label(value: unknown, flag: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || scanMutationSecrets(value).length) throw new CapacityRefusal('capacity_invalid', `Supply a public ${flag} label of 1–80 characters.`);
  assertPrivatePathSafe(value);
  return value.trim();
}

/** Read a finite decimal amount without accepting whitespace, booleans or alternate radices. */
function amount(value: unknown, flag: string): number {
  const numeric = typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric < 0) throw new CapacityRefusal('capacity_invalid', `Supply a nonnegative finite decimal for ${flag}.`);
  return numeric;
}

/** Parse bounded relative windows with explicit units. */
function windowLength(value: unknown): number {
  const match = typeof value === 'string' ? /^(\d+)([smhdw])$/.exec(value) : null;
  const units = new Map([['s', 1_000], ['m', 60_000], ['h', 3_600_000], ['d', 86_400_000], ['w', 604_800_000]]);
  const length = match === null ? NaN : Number(match[1]) * units.get(match[2])!;
  if (!Number.isSafeInteger(length) || length <= 0 || length > 366 * 86_400_000) throw new CapacityRefusal('capacity_invalid', 'Supply a positive --window in seconds, minutes, hours, days or weeks, at most 366 days.');
  return length;
}

/** Require an ISO timestamp with an explicit time zone. */
function instant(value: unknown, flag: string): string {
  const timestamp = capacityInstant(value);
  if (timestamp === undefined) throw new CapacityRefusal('capacity_invalid', `Supply an ISO timestamp with a time zone for ${flag}.`);
  return timestamp;
}

/** Parse a policy bound and an integer simultaneous lane count. */
function policyBand(value: unknown): [number, number] {
  const match = typeof value === 'string' ? /^forecast<(\d+(?:\.\d+)?)=(\d+)$/.exec(value) : null;
  if (match === null) throw new CapacityRefusal('capacity_invalid', 'Use --band forecast<THRESHOLD=LANES with a nonnegative decimal threshold and integer lane count.');
  const lanes = Number(match[2]);
  if (!Number.isSafeInteger(lanes)) throw new CapacityRefusal('capacity_invalid', 'Supply a safe integer lane count.');
  return [amount(match[1], '--band'), lanes];
}

/** Preserve the caller's band order after validating strictly increasing bounds. */
function capacityPolicy(values: unknown, fallback: unknown, forecast: unknown = 'max'): CapacityPolicy {
  if (forecast !== 'recent' && forecast !== 'window' && forecast !== 'max') throw new CapacityRefusal('capacity_invalid', 'Use --forecast recent, window or max.');
  const bands = Array.isArray(values) ? [...values] : values === undefined ? [] : [values];
  const otherwise = amount(fallback === undefined ? 0 : fallback, '--else');
  if (!Number.isSafeInteger(otherwise) || bands.length > 32) throw new CapacityRefusal('capacity_invalid', 'Use at most 32 bands and a nonnegative integer --else lane count.');
  let previous = -1;
  for (const band of bands) {
    const [threshold] = policyBand(band);
    if (threshold <= previous) throw new CapacityRefusal('capacity_invalid', 'Order bands by strictly increasing forecast thresholds.');
    previous = threshold;
  }
  return { bands: bands as string[], otherwise, forecast };
}

/** Parse a requested primary capacity and optional ordered retry capacities. */
export function capacityOrder(value: string | undefined): string[] {
  if (value === undefined) return [];
  const names = value.split(',').map(capacityName);
  if (names.length > 16 || new Set(names).size !== names.length) throw new CapacityRefusal('capacity_invalid', 'Supply up to 16 distinct comma-separated capacity names.');
  return names;
}

/** Capacity operations accept only their own input fields and the operator identity. */
const ACTION_FIELDS = {
  status: [], declare: ['limit', 'unit', 'window', 'resetsAt'],
  observe: ['used', 'source', 'at'], policy: ['band', 'else', 'forecast'],
} as const;

/** Use the same validated values for CLI and embedded callers. */
export function capacityAction(options: Record<string, unknown>, now: number) {
  const input = options.action ?? 'status';
  if (typeof input !== 'string' || !Object.hasOwn(ACTION_FIELDS, input)) {
    throw new CapacityRefusal('capacity_invalid', 'Use --action declare, observe, policy or status.');
  }
  const action = input as keyof typeof ACTION_FIELDS;
  const fields: readonly string[] = ACTION_FIELDS[action];
  for (const [field, value] of Object.entries(options)) {
    if (value !== undefined && field !== 'action' && field !== 'agent' && !fields.includes(field)) {
      throw new CapacityRefusal('capacity_invalid', `Use only the options for the selected capacity action. Run ${capacityCommand('capacity', '--help')}.`);
    }
  }
  switch (action) {
    case 'status': return { action: 'status' } as const;
    case 'declare': {
      const limit = amount(options.limit, '--limit');
      if (limit === 0) throw new CapacityRefusal('capacity_invalid', 'Supply a positive --limit.');
      return { action: 'declare', limit, unit: label(options.unit, '--unit'), window: windowLength(options.window), resets_at: instant(options.resetsAt, '--resets-at') } as const;
    }
    case 'observe': return { action: 'observe', observation: { used: amount(options.used, '--used'), source: label(options.source, '--source'), at: instant(options.at ?? new Date(now).toISOString(), '--at') } } as const;
    case 'policy': return { action: 'policy', policy: capacityPolicy(options.band, options.else, options.forecast) } as const;
  }
}

/** Decode persisted projections before using their values in a scheduling decision. */
function parseWindow(raw: unknown, name: string): CapacityWindow {
  try {
    if (typeof raw !== 'string') throw new Error('Missing capacity data');
    const state = JSON.parse(raw) as CapacityWindow;
    if (typeof state.limit !== 'number' || state.name !== name || amount(state.limit, '--limit') === 0 || label(state.unit, '--unit') !== state.unit ||
        !Number.isSafeInteger(state.window) || state.window < 1_000 || state.window > 366 * 86_400_000 ||
        instant(state.resets_at, '--resets-at') !== state.resets_at || !Array.isArray(state.observations) || state.observations.length > 2) throw new Error('Invalid window');
    let previous = Date.parse(state.resets_at) - state.window - 1;
    for (const observation of state.observations) {
      const at = Date.parse(instant(observation.at, '--at'));
      if (at <= previous || at >= Date.parse(state.resets_at) || typeof observation.used !== 'number') throw new Error('Invalid sequence');
      amount(observation.used, '--used'); label(observation.source, '--source');
      previous = at;
    }
    return { name: state.name, limit: state.limit, unit: state.unit, window: state.window, resets_at: state.resets_at,
      observations: state.observations.map(({ at, used, source }) => ({ at, used, source })),
      policy: capacityPolicy(state.policy?.bands, state.policy?.otherwise ?? 0, state.policy?.forecast) };
  } catch {
    throw new CapacityRefusal('capacity_invalid', 'Inspect the native history of the capacity record before repairing its window.');
  }
}

/** Select only measurements available at the decision clock and label stale evidence. */
function observationsAsOf(state: CapacityWindow, now: number) {
  return state.observations.filter(entry => Date.parse(entry.at) <= now)
    .map(entry => ({ ...entry, stale: now - Date.parse(entry.at) > OBSERVATION_MAX_AGE_MS }));
}

/** Derive the read model at a single instant, retaining stale values only as labeled evidence. */
function capacityView(state: CapacityWindow, now: number, active_lanes: number, reported_exhausted: boolean) {
  const reset = Date.parse(state.resets_at);
  const start = reset - state.window;
  const observations = observationsAsOf(state, now);
  const latest = observations.at(-1);
  const [first, second] = observations.filter(entry => !entry.stale && now < reset);
  const burn_rate_per_hour = first === undefined || second === undefined ? null :
    Math.min(Number.MAX_VALUE, Math.max(0, (second.used - first.used) / (Date.parse(second.at) - Date.parse(first.at))) * 3_600_000);
  const elapsed_share = Math.max(0, Math.min(1, (now - start) / state.window));
  const forecast_recent = burn_rate_per_hour === null ? null : Math.min(Number.MAX_VALUE, second!.used + burn_rate_per_hour * ((reset - Date.parse(second!.at)) / 3_600_000));
  // The second observation is strictly after the window start. Use its elapsed share.
  const forecast_window = second === undefined ? null : Math.min(Number.MAX_VALUE, second.used / ((Date.parse(second.at) - start) / state.window));
  const forecast = forecast_recent === null ? null : state.policy.forecast === 'recent' ? forecast_recent :
    state.policy.forecast === 'window' ? forecast_window : Math.max(forecast_recent, forecast_window!);
  const band = forecast === null ? undefined : state.policy.bands.map(policyBand).find(([threshold]) => forecast < threshold);
  const exhausted = reported_exhausted || now < start || now >= reset || latest !== undefined && !latest.stale && latest.used >= state.limit;
  const forecast_exceeded = forecast !== null && forecast >= state.limit;
  const admitted_lane_count = exhausted || forecast_exceeded ? 0 : band?.[1] ?? state.policy.otherwise;
  return {
    capacity: state.name, limit: state.limit, unit: state.unit, starts_at: new Date(start).toISOString(), resets_at: state.resets_at,
    window_seconds: state.window / 1000, elapsed_share,
    seconds_to_reset: Math.max(0, (reset - now) / 1000), used: latest?.used ?? null, observation_stale: latest?.stale ?? null,
    observation_max_age_seconds: OBSERVATION_MAX_AGE_MS / 1000, observations, burn_rate_per_hour,
    forecast, forecast_recent, forecast_window, reported_exhausted, policy: state.policy, exhausted, forecast_exceeded, admitted_lane_count, active_lanes,
    available_lanes: Math.max(0, admitted_lane_count - active_lanes),
  };
}

/** Compute the next window or observation with all time checks before the native write. */
function changeWindow(name: string, previous: CapacityWindow | undefined, change: Exclude<ReturnType<typeof capacityAction>, { action: 'status' }>, now: number): CapacityWindow {
  if (change.action === 'declare') {
    const reset = Date.parse(change.resets_at);
    if (reset <= now || reset - change.window > now) throw new CapacityRefusal('capacity_invalid', 'Declare a window that contains the current time.');
    if (previous !== undefined && now < Date.parse(previous.resets_at)) throw new CapacityRefusal('capacity_invalid', `The current window is active. Inspect it with ${capacityCommand('capacity', name)}.`);
    const { limit, unit, window, resets_at } = change;
    return { name, limit, unit, window, resets_at, observations: [], policy: previous?.unit === unit ? previous.policy : { bands: [], otherwise: 0, forecast: 'max' } };
  }
  if (previous === undefined) throw undeclared(name);
  if (change.action === 'policy') return { ...previous, policy: change.policy };
  const at = Date.parse(change.observation.at);
  const reset = Date.parse(previous.resets_at);
  if (at > now || at < reset - previous.window || at >= reset || now >= reset || at <= Date.parse(previous.observations.at(-1)?.at ?? '')) {
    throw new CapacityRefusal('capacity_invalid', `Supply a newer observation in the active window. Inspect it with ${capacityCommand('capacity', name)}.`);
  }
  return { ...previous, observations: [...previous.observations.slice(-1), change.observation] };
}

/** Point callers to the declaration contract for a missing capacity. */
function undeclared(name: string): CapacityRefusal {
  const next_command = capacityCommand('capacity', '--help');
  return new CapacityRefusal('capacity_undeclared', `Declare ${name} using the capacity options shown by ${next_command}.`, { capacity: name, used: null, forecast: null, resets_at: null, next_command });
}

/** One write-free SDK snapshot for capacity decisions. */
async function registry(engine: Swarm) {
  const items = await inspectItems(engine.pmRoot, engine.repo);
  if (items === null) throw new CapacityRefusal('capacity_invalid', 'Use a local tracker with shared SDK writer fencing for capacity coordination.');
  const settings = await readSettings(engine.pmRoot);
  return { items, statuses: resolveRuntimeStatusRegistry(settings.schema), prefix: settings.id_prefix };
}

/** Locate renamed native records by their declared identity after a workspace prefix changes. */
function hasCapacityName(value: unknown, name: string): boolean {
  if (typeof value !== 'string') return false;
  try { return (JSON.parse(value) as { name?: unknown } | null)?.name === name; }
  catch { return false; }
}

/** Resolve the unique native item with the requested lifecycle state for this logical name. */
function recordFor(items: Record<string, unknown>[], statuses: RuntimeStatusRegistry, name: string, prefix: string, terminal = false) {
  const canonicalId = normalizeItemId('swarm-capacity-' + name, prefix);
  const records = items.filter(item => (item.tags as string[]).includes(CAPACITY_TAG) && (item.id === canonicalId || hasCapacityName(item[CAPACITY_FIELD], name)) && statusIsTerminal(String(item.status), statuses) === terminal);
  if (records.length > 1) throw new CapacityRefusal('capacity_invalid', `Inspect duplicate native records for ${name} before retrying.`);
  return records[0];
}

/** Count active ownership only, including across Git and shared lane modes. */
function occupancy(items: Record<string, unknown>[], statuses: RuntimeStatusRegistry, name: string, now: number, except?: string): number {
  return items.filter(item => item.id !== except && item[LANE_CAPACITY_FIELD] === name &&
    !statusIsTerminal(String(item.status), statuses) && laneCapacityState(item, now).capacity === name).length;
}

/** Project both occupation and provider exhaustion from the same native registry snapshot. */
function registryView(state: CapacityWindow, now: number, items: Record<string, unknown>[], statuses: RuntimeStatusRegistry, except?: string) {
  const start = Date.parse(state.resets_at) - state.window;
  const stopped = items.some(item => interruptions(item).some(stop => stop.capacity === state.name && stop.resets_at === state.resets_at &&
    Date.parse(stop.at) >= start && Date.parse(stop.resets_at) > now));
  return capacityView(state, now, occupancy(items, statuses, state.name, now, except), stopped);
}

/** Create the lane binding field only when a capacity was selected. */
export function capacityFields(binding: unknown): string[] {
  return typeof binding === 'string' ? [LANE_CAPACITY_FIELD + '=' + binding] : [];
}

/** Clear a prior assignment's binding when a fresh lane has no capacity. */
export function capacityUnset(item: Record<string, unknown>, binding: unknown, unset: string[] = []): string[] {
  return typeof binding !== 'string' && item[LANE_CAPACITY_FIELD] !== undefined ? [...unset, LANE_CAPACITY_FIELD] : unset;
}

/** Match shared lane generations while supporting freshly fenced Git lanes. */
export function incrementFence(value: unknown): string {
  const current = String(value ?? '0');
  if (!/^\d+$/.test(current)) throw new CapacityRefusal('capacity_invalid', 'Inspect malformed native lane generation before retrying.');
  return (BigInt(current) + 1n).toString();
}

/** Admission result shared by preview and both native acquisition paths. */
export type CapacityStatus = ReturnType<typeof capacityView>;

/** Select the portable measurements used in admission and stop refusal diagnostics. */
export function capacityDiagnosis(view: CapacityStatus) {
  return {
    capacity: view.capacity, used: view.used, limit: view.limit, unit: view.unit, forecast: view.forecast, resets_at: view.resets_at,
    observation_stale: view.observation_stale, admitted_lane_count: view.admitted_lane_count, active_lanes: view.active_lanes,
  };
}

/** Project an inherited binding only while its native capacity record is still declared. */
export async function declaredLaneCapacity(engine: Swarm, binding: unknown): Promise<string | undefined> {
  if (typeof binding !== 'string') return undefined;
  const name = capacityName(binding);
  const { items, statuses, prefix } = await registry(engine);
  return recordFor(items, statuses, name, prefix) === undefined ? undefined : name;
}

/** Evaluate the explicit or inherited capacity under the caller's operation lease for writes. */
export async function admitCapacity(engine: Swarm, order: string[], itemId: string, command: 'next' | 'schedule' | 'start' | 'brief' | 'handoff' | 'reclaim', retryFlags: string[], binding?: unknown): Promise<CapacityStatus | undefined> {
  const [requested, ...fallback] = order;
  const name = requested ?? (typeof binding === 'string' ? capacityName(binding) : undefined);
  if (name === undefined) return undefined;
  const { items, statuses, prefix } = await registry(engine);
  const record = recordFor(items, statuses, name, prefix);
  const next = fallback[0];
  const args = [...(command === 'start' || command === 'brief' ? [itemId] : []), ...retryFlags];
  const nextCommand = next === undefined ? capacityCommand('capacity', name) :
    capacityCommand(command, ...args, '--agent', engine.author, '--capacity', fallback.join(','));
  const recovery = { next_capacity: next ?? null, next_command: nextCommand };
  if (record === undefined) {
    if (requested === undefined) return undefined;
    const missing = undeclared(name);
    if (next === undefined) throw missing;
    throw new CapacityRefusal(missing.code, `Declare ${name} or try ${nextCommand}.`, { ...missing.details, ...recovery });
  }
  const view = registryView(parseWindow(record[CAPACITY_FIELD], name), Date.now(), items, statuses, itemId);
  if (command === 'reclaim' && view.seconds_to_reset === 0) return undefined;
  if (view.available_lanes > 0) return view;
  const code = view.exhausted ? 'capacity_exhausted' : view.forecast_exceeded ? 'capacity_forecast_exceeded' :
    view.admitted_lane_count > 0 ? 'capacity_lanes_occupied' : 'capacity_policy_denied';
  const reason = code === 'capacity_lanes_occupied'
    ? `${view.active_lanes} of ${view.admitted_lane_count} admitted lanes active`
    : `used ${view.used ?? 'unknown'}, forecast ${view.forecast ?? 'unknown'}`;
  const message = `Capacity ${name} ${reason}, resets at ${view.resets_at}. Run ${nextCommand}.`;
  throw new CapacityRefusal(code, message, { ...capacityDiagnosis(view), ...recovery });
}

/** Preserve fair ranking flags when capacity admission offers a fallback retry. */
export function admitNextCapacity(engine: Swarm, order: string[], id: string, parent: string | undefined, dryRun: boolean, policy?: FairPolicy, binding?: unknown) {
  const retry = [...(parent === undefined ? [] : ['--parent', parent]), ...(dryRun ? ['--dry-run'] : [])];
  if (policy !== undefined) {
    if (policy.skills.size > 0) retry.push('--skills', [...policy.skills].join(','));
    retry.push('--max-wait', String(policy.maxWait), '--limit', String(policy.limit));
  }
  return admitCapacity(engine, order, id, policy === undefined ? 'next' : 'schedule', retry, binding);
}

/** Coordinate one native item per logical capacity with the same shared operation lease as claims. */
export class Capacities {
  /** Native tracker and SDK client that own these records. */
  private readonly engine: Swarm;
  /** Clock used for stale measurements and window boundaries. */
  private readonly clock: () => number;
  /** Bind the SDK engine and a caller-supplied clock for deterministic embedded use. */
  constructor(engine: Swarm, clock: () => number = Date.now) {
    this.engine = engine;
    this.clock = clock;
  }

  /** Read or update a window and append each accepted observation to native item history. */
  async run(inputName: string, options: Record<string, unknown> = {}) {
    const name = capacityName(inputName);
    const change = capacityAction(options, this.clock());
    const { pmRoot, author, client } = this.engine;
    assertPrivatePathSafe(author);
    if (scanMutationSecrets(author).length) throw new CapacityRefusal('capacity_invalid', 'Supply a public operator identity.');
    /** Re-read the selected window while the writer lease is held. */
    const mutate = async (lease?: Lease) => {
      const now = this.clock();
      const { items, statuses, prefix } = await registry(this.engine);
      const record = recordFor(items, statuses, name, prefix);
      if (change.action === 'status') {
        if (record === undefined) throw undeclared(name);
        return registryView(parseWindow(record[CAPACITY_FIELD], name), now, items, statuses);
      }
      const retired = record === undefined && change.action === 'declare' ? recordFor(items, statuses, name, prefix, true) : undefined;
      const selected = record ?? retired;
      const snapshot = selected === undefined ? undefined : await clientMutationSnapshot(pmRoot, client, String(selected.id));
      const reopening = retired !== undefined;
      if (snapshot !== undefined && recordFor([snapshot.item], statuses, name, prefix, reopening) === undefined) throw undeclared(name);
      const previous = snapshot === undefined || reopening ? undefined : parseWindow(snapshot.item[CAPACITY_FIELD], name);
      const state = changeWindow(name, previous, change, now);
      const field = [`${CAPACITY_FIELD}=${JSON.stringify(state)}`];
      const result = registryView(state, now, items, statuses);
      await lease!.write(async () => {
        if (snapshot === undefined) {
          await commitMutation({ id: `swarm-capacity-${name}`, title: `Swarm capacity ${name}`, type: 'Task', addTags: [CAPACITY_TAG], author, field }, admitted => client.create(admitted));
          return;
        }
        const options = { author, field, ...(reopening ? { status: statuses.open_status } : {}), message: `Swarm capacity ${change.action}` };
        await commitItemMutation({ id: String(snapshot.item.id), item: snapshot.item, options }, admitted => client.update(admitted.id, admitted.options), { history: snapshot.historyHead });
      }, { announce: false });
      return result;
    };
    return change.action === 'status' ? mutate() : withSwarmLease(pmRoot, author, mutate);
  }
}
