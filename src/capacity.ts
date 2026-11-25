import { RESOURCE_TAG } from './resources.ts';
import { currentInterruption, interruptions } from './interruption.ts';
import { readSettings, resolveRuntimeStatusRegistry, scanMutationSecrets, statusIsTerminal } from '@unbrained/pm-cli/sdk';
import { clientMutationSnapshot, inspectItems } from './inspection.ts';
import { withSwarmLease } from './lease.ts';
import type { Lease } from './lease.ts';
import { assertPrivatePathSafe, commitItemMutation, commitMutation } from './settings.ts';
import type { PmCliErrorDetails, RuntimeStatusRegistry } from '@unbrained/pm-cli/sdk';
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
interface CapacityPolicy { bands: string[]; otherwise: number }

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
export type CapacityRefusalCode = 'capacity_invalid' | 'capacity_undeclared' | 'capacity_forecast_exceeded' | 'capacity_exhausted';

/** Carry an actionable command and structured measurements through CLI and SDK refusals. */
export class CapacityRefusal extends Error {
  /** Stable refusal reason for automation. */
  readonly code: CapacityRefusalCode;
  /** Runnable recovery instruction or input correction. */
  readonly remedy: string;
  /** Portable measurement context when a capacity was resolved. */
  readonly details?: PmCliErrorDetails;
  /** Build a refusal without echoing invalid raw values. */
  constructor(code: CapacityRefusalCode, remedy: string, details?: PmCliErrorDetails) {
    super(code + ': ' + remedy);
    this.code = code;
    this.remedy = remedy;
    this.details = details;
  }
}

/** Keep capacity and resource control items outside both start engines. */
export function assertStartWorkItem(item: Record<string, unknown>): void {
  const tags = item.tags as string[];
  if (tags.includes(CAPACITY_TAG)) throw new Error('Capacity records require pm swarm capacity.');
  if (tags.includes(RESOURCE_TAG)) throw new Error('Resource items require swarm resource; use an ordinary work item for start.');
}

/** Normalize logical capacity names before matching their native records or rendering a retry command. */
export function capacityName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new CapacityRefusal('capacity_invalid', 'Use a capacity name of at most 40 letters, digits and hyphens, starting with a letter.');
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
  const time = typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw new CapacityRefusal('capacity_invalid', `Supply an ISO timestamp with a time zone for ${flag}.`);
  return new Date(time).toISOString();
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
function capacityPolicy(values: unknown, fallback: unknown): CapacityPolicy {
  const bands = Array.isArray(values) ? [...values] : values === undefined ? [] : [values];
  const otherwise = amount(fallback === undefined ? 0 : fallback, '--else');
  if (!Number.isSafeInteger(otherwise) || bands.length > 32) throw new CapacityRefusal('capacity_invalid', 'Use at most 32 bands and a nonnegative integer --else lane count.');
  let previous = -1;
  for (const band of bands) {
    const [threshold] = policyBand(band);
    if (threshold <= previous) throw new CapacityRefusal('capacity_invalid', 'Order bands by strictly increasing forecast thresholds.');
    previous = threshold;
  }
  return { bands: bands as string[], otherwise };
}

/** Parse a requested primary capacity and optional ordered retry capacities. */
export function capacityOrder(value: string | undefined): string[] {
  if (value === undefined) return [];
  const names = value.split(',').map(capacityName);
  if (names.length > 16 || new Set(names).size !== names.length) throw new CapacityRefusal('capacity_invalid', 'Supply up to 16 distinct comma-separated capacity names.');
  return names;
}

/** Capacity operations accept only their own input fields and the operator identity. */
const ACTION_FIELDS = new Map<string, readonly string[]>([
  ['status', []], ['declare', ['limit', 'unit', 'window', 'resetsAt']],
  ['observe', ['used', 'source', 'at']], ['policy', ['band', 'else']],
]);

/** Use the same validated values for CLI and embedded callers. */
export function capacityAction(options: Record<string, unknown>, now: number) {
  const action = options.action ?? 'status';
  const fields = typeof action === 'string' ? ACTION_FIELDS.get(action) : undefined;
  if (fields === undefined) throw new CapacityRefusal('capacity_invalid', 'Use --action declare, observe, policy or status.');
  for (const [field, value] of Object.entries(options)) {
    if (value !== undefined && field !== 'action' && field !== 'agent' && !fields.includes(field)) {
      throw new CapacityRefusal('capacity_invalid', 'Use only the options for the selected capacity action. Run pm swarm capacity --help.');
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
    case 'policy': return { action: 'policy', policy: capacityPolicy(options.band, options.else) } as const;
    default: throw new CapacityRefusal('capacity_invalid', 'Use --action declare, observe, policy or status.');
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
      policy: capacityPolicy(state.policy?.bands, state.policy?.otherwise ?? 0) };
  } catch {
    throw new CapacityRefusal('capacity_invalid', 'Inspect the native history of the capacity record before repairing its window.');
  }
}

/** Derive the read model at a single instant, retaining stale values only as labeled evidence. */
function capacityView(state: CapacityWindow, now: number, active_lanes: number, reported_exhausted: boolean) {
  const reset = Date.parse(state.resets_at);
  const start = reset - state.window;
  const observations = state.observations.map(entry => ({ ...entry, stale: now - Date.parse(entry.at) > OBSERVATION_MAX_AGE_MS }));
  const latest = observations.at(-1);
  const [first, second] = observations.filter(entry => !entry.stale && Date.parse(entry.at) <= now && now < reset);
  const burn_rate_per_hour = first === undefined || second === undefined ? null :
    Math.min(Number.MAX_VALUE, Math.max(0, (second.used - first.used) / (Date.parse(second.at) - Date.parse(first.at))) * 3_600_000);
  const forecast = burn_rate_per_hour === null ? null : Math.min(Number.MAX_VALUE, second!.used + burn_rate_per_hour * ((reset - Date.parse(second!.at)) / 3_600_000));
  const band = forecast === null ? undefined : state.policy.bands.map(policyBand).find(([threshold]) => forecast < threshold);
  const exhausted = reported_exhausted || now >= reset || latest !== undefined && !latest.stale && latest.used >= state.limit;
  const forecast_exceeded = forecast !== null && forecast >= state.limit;
  const admitted_lane_count = exhausted || forecast_exceeded ? 0 : band?.[1] ?? state.policy.otherwise;
  return {
    capacity: state.name, limit: state.limit, unit: state.unit, starts_at: new Date(start).toISOString(), resets_at: state.resets_at,
    window_seconds: state.window / 1000, elapsed_share: Math.max(0, Math.min(1, (now - start) / state.window)),
    seconds_to_reset: Math.max(0, (reset - now) / 1000), used: latest?.used ?? null, observation_stale: latest?.stale ?? null,
    observation_max_age_seconds: OBSERVATION_MAX_AGE_MS / 1000, observations, burn_rate_per_hour,
    forecast, reported_exhausted, policy: state.policy, exhausted, forecast_exceeded, admitted_lane_count, active_lanes,
    available_lanes: Math.max(0, admitted_lane_count - active_lanes),
  };
}

/** Compute the next window or observation with all time checks before the native write. */
function changeWindow(name: string, previous: CapacityWindow | undefined, change: Exclude<ReturnType<typeof capacityAction>, { action: 'status' }>, now: number): CapacityWindow {
  if (change.action === 'declare') {
    const reset = Date.parse(change.resets_at);
    if (reset <= now || reset - change.window > now) throw new CapacityRefusal('capacity_invalid', 'Declare a window that contains the current time.');
    if (previous !== undefined && now < Date.parse(previous.resets_at)) throw new CapacityRefusal('capacity_invalid', `The current window is active. Inspect it with pm swarm capacity ${name}.`);
    const { limit, unit, window, resets_at } = change;
    return { name, limit, unit, window, resets_at, observations: [], policy: previous?.policy ?? { bands: [], otherwise: 0 } };
  }
  if (previous === undefined) throw undeclared(name);
  if (change.action === 'policy') return { ...previous, policy: change.policy };
  const at = Date.parse(change.observation.at);
  const reset = Date.parse(previous.resets_at);
  if (at > now || at < reset - previous.window || at >= reset || now >= reset || at <= Date.parse(previous.observations.at(-1)?.at ?? '')) {
    throw new CapacityRefusal('capacity_invalid', `Supply a newer observation in the active window. Inspect it with pm swarm capacity ${name}.`);
  }
  return { ...previous, observations: [...previous.observations.slice(-1), change.observation] };
}

/** Point callers to the declaration contract for a missing capacity. */
function undeclared(name: string): CapacityRefusal {
  return new CapacityRefusal('capacity_undeclared', `Declare ${name} using the capacity options shown by pm swarm capacity --help.`, { capacity: name, used: null, forecast: null, resets_at: null, next_command: 'pm swarm capacity --help' });
}

/** One write-free SDK snapshot for capacity decisions. */
async function registry(engine: Swarm) {
  const items = await inspectItems(engine.pmRoot, engine.repo);
  if (items === null) throw new CapacityRefusal('capacity_invalid', 'Use a local tracker with shared SDK writer fencing for capacity coordination.');
  const statuses = resolveRuntimeStatusRegistry((await readSettings(engine.pmRoot)).schema);
  return { items, statuses };
}

/** Resolve the one active native item for this logical name. */
function recordFor(items: Record<string, unknown>[], statuses: RuntimeStatusRegistry, name: string) {
  const records = items.filter(item => (item.tags as string[]).includes(CAPACITY_TAG) && item.title === `Swarm capacity ${name}` && !statusIsTerminal(String(item.status), statuses));
  if (records.length > 1) throw new CapacityRefusal('capacity_invalid', `Inspect duplicate native records for ${name} before retrying.`);
  return records[0];
}

/** Count active ownership only, including across Git and shared lane modes. */
function occupancy(items: Record<string, unknown>[], statuses: RuntimeStatusRegistry, name: string, except?: string): number {
  return items.filter(item => item.id !== except && item[LANE_CAPACITY_FIELD] === name && typeof item.assignee === 'string' && item.assignee.trim() && !statusIsTerminal(String(item.status), statuses) && currentInterruption(item) === undefined).length;
}

/** Project both occupation and provider exhaustion from the same native registry snapshot. */
function registryView(state: CapacityWindow, now: number, items: Record<string, unknown>[], statuses: RuntimeStatusRegistry, except?: string) {
  const stopped = items.some(item => interruptions(item).some(stop => stop.capacity === state.name && stop.resets_at === state.resets_at && Date.parse(stop.resets_at) > now));
  return capacityView(state, now, occupancy(items, statuses, state.name, except), stopped);
}

/** Safely quote a value for the POSIX retry command. */
function shellArg(value: string): string {
  return /^[a-zA-Z0-9_,.-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Create the lane binding field only when a capacity was selected. */
export function capacityFields(binding: unknown): string[] {
  return typeof binding === 'string' ? [LANE_CAPACITY_FIELD + '=' + binding] : [];
}

/** Clear a prior assignment's binding when a fresh lane has no capacity. */
export function capacityUnset(item: Record<string, unknown>, binding: unknown, unset: string[] = []): string[] {
  return binding === undefined && item[LANE_CAPACITY_FIELD] !== undefined ? [...unset, LANE_CAPACITY_FIELD] : unset;
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

/** Evaluate the primary capacity under the caller's operation lease for writes. */
export async function admitCapacity(engine: Swarm, order: string[], itemId: string, command: 'next' | 'start' | 'brief', retryFlags: string[]): Promise<CapacityStatus | undefined> {
  const [name, ...fallback] = order;
  if (name === undefined) return undefined;
  const { items, statuses } = await registry(engine);
  const record = recordFor(items, statuses, name);
  const next = fallback[0];
  const args = [...(command === 'next' ? [] : [itemId]), ...retryFlags].map(shellArg);
  const nextCommand = next === undefined ? 'pm swarm capacity ' + name :
    ['pm swarm', command, ...args, '--agent', shellArg(engine.author), '--capacity', fallback.join(',')].join(' ');
  const recovery = { next_capacity: next ?? null, next_command: nextCommand };
  if (record === undefined) {
    const missing = undeclared(name);
    if (next === undefined) throw missing;
    throw new CapacityRefusal(missing.code, `Declare ${name} or try ${nextCommand}.`, { ...missing.details, ...recovery });
  }
  const view = registryView(parseWindow(record[CAPACITY_FIELD], name), Date.now(), items, statuses, itemId);
  if (view.available_lanes > 0) return view;
  const code = view.exhausted || view.admitted_lane_count > 0 ? 'capacity_exhausted' : 'capacity_forecast_exceeded';
  const message = `Capacity ${name} used ${view.used ?? 'unknown'}, forecast ${view.forecast ?? 'unknown'}, resets at ${view.resets_at}. Run ${nextCommand}.`;
  throw new CapacityRefusal(code, message, { ...capacityDiagnosis(view), ...recovery });
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
      const { items, statuses } = await registry(this.engine);
      const record = recordFor(items, statuses, name);
      if (change.action === 'status') {
        if (record === undefined) throw undeclared(name);
        return registryView(parseWindow(record[CAPACITY_FIELD], name), now, items, statuses);
      }
      const snapshot = record === undefined ? undefined : await clientMutationSnapshot(pmRoot, client, String(record.id));
      const state = changeWindow(name, snapshot === undefined ? undefined : parseWindow(snapshot.item[CAPACITY_FIELD], name), change, now);
      const field = [`${CAPACITY_FIELD}=${JSON.stringify(state)}`];
      const result = registryView(state, now, items, statuses);
      await lease!.write(async () => {
        if (snapshot === undefined) {
          await commitMutation({ id: `swarm-capacity-${name}`, title: `Swarm capacity ${name}`, type: 'Task', addTags: [CAPACITY_TAG], author, field }, admitted => client.create(admitted));
          return;
        }
        await commitItemMutation({ id: String(snapshot.item.id), item: snapshot.item, options: { author, field, message: `Swarm capacity ${change.action}` } }, admitted => client.update(admitted.id, admitted.options), { history: snapshot.historyHead });
      }, { announce: false });
      return result;
    };
    return change.action === 'status' ? mutate() : withSwarmLease(pmRoot, author, mutate);
  }
}
