import { RESOURCE_TAG } from './resources.ts';
import { readSettings, resolveRuntimeStatusRegistry, scanMutationSecrets, statusIsTerminal } from '@unbrained/pm-cli/sdk';
import { clientMutationSnapshot, inspectItems } from './inspection.ts';
import { withSwarmLease } from './lease.ts';
import type { Lease } from './lease.ts';
import { assertPrivatePathSafe, commitItemMutation, commitMutation } from './settings.ts';
import type { Swarm } from './swarm.ts';

/** Native capacity records are reserved for swarm coordination. */
export const CAPACITY_TAG = 'swarm-capacity';
/** Registered native field holding the current window and forecast inputs. */
export const CAPACITY_FIELD = 'swarm_capacity_window';
/** Both forecast inputs must be no more than 24 hours old. */
export const OBSERVATION_MAX_AGE_MS = 86_400_000;

/** A caller-reported cumulative measurement. */
export interface CapacityObservation { at: string; used: number; source: string }
/** One declared window, with the latest inputs retained in the native item projection. */
interface CapacityWindow {
  name: string;
  limit: number;
  unit: string;
  window: number;
  resets_at: string;
  observations: CapacityObservation[];
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
  readonly details?: Record<string, unknown>;
  /** Build a refusal without echoing invalid raw values. */
  constructor(code: CapacityRefusalCode, remedy: string, details?: Record<string, unknown>) {
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

/** Use the same validated values for CLI and embedded callers. */
export function capacityAction(options: Record<string, unknown>, now: number) {
  switch (options.action ?? 'status') {
    case 'status': return { action: 'status' } as const;
    case 'declare': {
      const limit = amount(options.limit, '--limit');
      if (limit === 0) throw new CapacityRefusal('capacity_invalid', 'Supply a positive --limit.');
      return { action: 'declare', limit, unit: label(options.unit, '--unit'), window: windowLength(options.window), resets_at: instant(options.resetsAt, '--resets-at') } as const;
    }
    case 'observe': return { action: 'observe', observation: { used: amount(options.used, '--used'), source: label(options.source, '--source'), at: instant(options.at ?? new Date(now).toISOString(), '--at') } } as const;
    default: throw new CapacityRefusal('capacity_invalid', 'Use --action declare, observe or status.');
  }
}

/** Decode persisted projections before using their values in a scheduling decision. */
function parseWindow(raw: unknown): CapacityWindow {
  try {
    if (typeof raw !== 'string') throw new Error('Missing capacity data');
    const state = JSON.parse(raw) as CapacityWindow;
    if (typeof state.limit !== 'number' || capacityName(state.name) !== state.name || amount(state.limit, '--limit') === 0 || label(state.unit, '--unit') !== state.unit ||
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
      observations: state.observations.map(({ at, used, source }) => ({ at, used, source })) };
  } catch {
    throw new CapacityRefusal('capacity_invalid', 'Inspect the native history of the capacity record before repairing its window.');
  }
}

/** Derive the read model at a single instant, retaining stale values only as labeled evidence. */
function capacityView(state: CapacityWindow, now: number) {
  const reset = Date.parse(state.resets_at);
  const start = reset - state.window;
  const observations = state.observations.map(entry => ({ ...entry, stale: now - Date.parse(entry.at) > OBSERVATION_MAX_AGE_MS }));
  const latest = observations.at(-1);
  const [first, second] = observations.filter(entry => !entry.stale && Date.parse(entry.at) <= now && now < reset);
  const burn_rate_per_hour = first === undefined || second === undefined ? null :
    Math.max(0, (second.used - first.used) / (Date.parse(second.at) - Date.parse(first.at))) * 3_600_000;
  return {
    capacity: state.name, limit: state.limit, unit: state.unit, starts_at: new Date(start).toISOString(), resets_at: state.resets_at,
    window_seconds: state.window / 1000, elapsed_share: Math.max(0, Math.min(1, (now - start) / state.window)),
    seconds_to_reset: Math.max(0, (reset - now) / 1000), used: latest?.used ?? null, observation_stale: latest?.stale ?? null,
    observation_max_age_seconds: OBSERVATION_MAX_AGE_MS / 1000, observations, burn_rate_per_hour,
    forecast: burn_rate_per_hour === null ? null : second!.used + burn_rate_per_hour * (reset - Date.parse(second!.at)) / 3_600_000,
  };
}

/** Compute the next window or observation with all time checks before the native write. */
function changeWindow(name: string, previous: CapacityWindow | undefined, change: Exclude<ReturnType<typeof capacityAction>, { action: 'status' }>, now: number): CapacityWindow {
  if (change.action === 'declare') {
    const reset = Date.parse(change.resets_at);
    if (reset <= now || reset - change.window > now) throw new CapacityRefusal('capacity_invalid', 'Declare a window that contains the current time.');
    if (previous !== undefined && now < Date.parse(previous.resets_at)) throw new CapacityRefusal('capacity_invalid', `The current window is active. Inspect it with pm swarm capacity ${name}.`);
    const { limit, unit, window, resets_at } = change;
    return { name, limit, unit, window, resets_at, observations: [] };
  }
  if (previous === undefined) throw undeclared(name);
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
    const { pmRoot, repo, author, client } = this.engine;
    assertPrivatePathSafe(author);
    if (scanMutationSecrets(author).length) throw new CapacityRefusal('capacity_invalid', 'Supply a public operator identity.');
    /** Re-read the selected window while the writer lease is held. */
    const mutate = async (lease?: Lease) => {
      const now = this.clock();
      const items = await inspectItems(pmRoot, repo);
      if (items === null) throw new CapacityRefusal('capacity_invalid', 'Use a local tracker with shared SDK writer fencing for capacity coordination.');
      const statuses = resolveRuntimeStatusRegistry((await readSettings(pmRoot)).schema);
      const records = items.filter(item => (item.tags as string[]).includes(CAPACITY_TAG) && item.title === `Swarm capacity ${name}` && !statusIsTerminal(String(item.status), statuses));
      if (records.length > 1) throw new CapacityRefusal('capacity_invalid', `Inspect duplicate native records for ${name} before retrying.`);
      const record = records[0];
      if (change.action === 'status') {
        if (record === undefined) throw undeclared(name);
        return capacityView(parseWindow(record[CAPACITY_FIELD]), now);
      }
      const snapshot = record === undefined ? undefined : await clientMutationSnapshot(pmRoot, client, String(record.id));
      const state = changeWindow(name, snapshot === undefined ? undefined : parseWindow(snapshot.item[CAPACITY_FIELD]), change, now);
      const field = [`${CAPACITY_FIELD}=${JSON.stringify(state)}`];
      const result = capacityView(state, now);
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
