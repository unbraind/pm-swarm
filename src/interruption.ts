import { capacityCommand } from './capacity-command.ts';
import { capacityInstant } from './capacity-time.ts';
import { resolveRuntimeStatusRegistry, readSettings, scanMutationSecrets, statusIsTerminal } from '@unbrained/pm-cli/sdk';
import { Capacities, capacityDiagnosis, capacityFields, capacityName, capacityUnset, CapacityRefusal, LANE_CAPACITY_FIELD } from './capacity.ts';
import { assertCloseIntentSettled } from './close.ts';
import { clientMutationSnapshot, inspectItem } from './inspection.ts';
import { StaleFenceError, withSwarmLease } from './lease.ts';
import { assertPrivatePathSafe, commitItemMutation } from './settings.ts';
import type { Swarm } from './swarm.ts';

/** Native item field preserving window exhaustion and the interrupted ownership generation. */
export const INTERRUPTION_FIELD = 'swarm_interruptions';

/** A stop observed by the holder of a particular lane generation. */
export interface CapacityInterruption {
  capacity: string;
  agent: string;
  token: string;
  reason: 'capacity_exhausted';
  at: string;
  resets_at: string;
  used: number | null;
  forecast: number | null;
}

/** Retired stops remain provider evidence without naming a live fence. */
type CapacityStop = Omit<CapacityInterruption, 'token'> & { token: string | null };

/** Check the canonical ISO timestamps used to compare window identities. */
function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && capacityInstant(value) === value;
}

/** Parse and project the native record without returning foreign fields. */
export function interruptions(item: Record<string, unknown>): CapacityStop[] {
  const raw = item[INTERRUPTION_FIELD];
  if (raw === undefined) return [];
  try {
    if (typeof raw !== 'string') throw new Error('Invalid interruption field');
    const rows = JSON.parse(raw) as CapacityStop[];
    if (!Array.isArray(rows)) throw new Error('Invalid interruptions');
    return rows.map(({ capacity, agent, token, reason, at, resets_at, used, forecast }) => {
      if (capacityName(capacity) !== capacity || typeof agent !== 'string' || !agent.trim() || scanMutationSecrets(agent).length > 0 ||
          token !== null && (typeof token !== 'string' || !/^\d+$/.test(token)) || reason !== 'capacity_exhausted' ||
          !isIsoInstant(at) || !isIsoInstant(resets_at) || at >= resets_at ||
          [used, forecast].some(value => value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))) {
        throw new Error('Invalid interruption');
      }
      const result = { capacity, agent, token, reason, at, resets_at, used, forecast };
      assertPrivatePathSafe(result);
      return result;
    });
  } catch {
    throw new CapacityRefusal('capacity_invalid', 'Inspect the native interruption history before making another lane decision.');
  }
}

/** A transfer advances the generation but deliberately leaves exhaustion evidence intact. */
export function currentInterruption(item: Record<string, unknown>) {
  return interruptions(item).filter((stop): stop is CapacityInterruption => stop.token !== null && stop.token === item.swarm_token && stop.agent === item.assignee).at(-1);
}

/** Publish capacity metadata with a new ownership generation and retire older live stops. */
export function advanceCapacity(item: Record<string, unknown>, binding: unknown, unset: string[] = []) {
  const stops = interruptions(item);
  const retired = stops.some(stop => stop.token !== null) ? [INTERRUPTION_FIELD + '=' + JSON.stringify(stops.map(stop => ({ ...stop, token: null })))] : [];
  return { field: [...capacityFields(binding), ...retired], unset: capacityUnset(item, binding, unset) };
}

/** Project the binding and the live stop of the same ownership generation at one instant. */
export function laneCapacityState(item: Record<string, unknown>, now: number) {
  const stop = currentInterruption(item);
  const interruption = stop !== undefined && Date.parse(stop.resets_at) > now ? stop : undefined;
  const binding = item[LANE_CAPACITY_FIELD];
  const capacity = interruption === undefined && typeof binding === 'string' && typeof item.assignee === 'string' && item.assignee.trim()
    ? binding : undefined;
  return { capacity, interruption };
}

/** Report exactly why a stopped ownership generation cannot be taken from the pool. */
export function interruptionRefusal(item: Record<string, unknown>, now = Date.now()): CapacityRefusal | undefined {
  const { interruption: stop } = laneCapacityState(item, now);
  if (stop === undefined) return undefined;
  const next = capacityCommand('capacity', '--help');
  const message = 'Capacity ' + stop.capacity + ' used ' + (stop.used ?? 'unknown') + ', forecast ' + (stop.forecast ?? 'unknown') +
    ', resets at ' + stop.resets_at + '. Take a continuation or run ' + next + '.';
  return new CapacityRefusal('capacity_exhausted', message, { ...stop, next_command: next });
}

/** Pause one fenced lane and record its window exhaustion in the same native mutation. */
export async function interruptLane(engine: Swarm, id: string, token: string | undefined, inputCapacity: string, reason: string) {
  const name = capacityName(inputCapacity);
  assertPrivatePathSafe({ id, token, agent: engine.author });
  if (scanMutationSecrets(engine.author).length > 0) throw new CapacityRefusal('capacity_invalid', 'Supply a public agent identity.');
  if (reason !== 'capacity_exhausted' || token === undefined || !/^\d+$/.test(token)) {
    throw new CapacityRefusal('capacity_invalid', 'Supply --reason capacity_exhausted and the current decimal --token.');
  }
  /** Reject a token or principal from a different native generation. */
  const checkOwner = (item: Record<string, unknown>) => {
    if (item.assignee !== engine.author || item.swarm_token !== token) throw new StaleFenceError(String(item.id));
  };
  const local = await inspectItem(engine.pmRoot, engine.repo, id);
  if (local !== null) checkOwner(local.item);
  return withSwarmLease(engine.pmRoot, engine.author, async lease => {
    const { item, historyHead } = await clientMutationSnapshot(engine.pmRoot, engine.client, id);
    const canonicalId = String(item.id);
    checkOwner(item);
    assertCloseIntentSettled(engine, item);
    const statuses = resolveRuntimeStatusRegistry((await readSettings(engine.pmRoot)).schema);
    const view = await new Capacities(engine).run(name);
    const next = capacityCommand('capacity', name);
    const details = { ...capacityDiagnosis(view), next_command: next };
    if (statusIsTerminal(String(item.status), statuses) || item[LANE_CAPACITY_FIELD] !== name || view.seconds_to_reset === 0) {
      throw new CapacityRefusal('capacity_invalid', 'Use an active lane bound to this capacity in its current window. Run ' + next + '.', details);
    }
    const at = new Date().toISOString();
    if (at < view.starts_at) throw new CapacityRefusal('capacity_invalid', 'The capacity window has not started. Run ' + next + '.', details);
    if (at >= view.resets_at) throw new CapacityRefusal('capacity_exhausted', 'The capacity window has ended. Run ' + next + '.', details);
    const previous = interruptions(item).filter(stop => stop.resets_at > at);
    const replay = previous.find((stop): stop is CapacityInterruption => stop.token === token && stop.capacity === name && stop.resets_at === view.resets_at && stop.at >= view.starts_at && stop.agent === engine.author);
    if (replay !== undefined) return { id: canonicalId, interruption: replay };
    const interruption: CapacityInterruption = { capacity: name, agent: engine.author, token, reason, at, resets_at: view.resets_at, used: view.used, forecast: view.forecast };
    const field = [INTERRUPTION_FIELD + '=' + JSON.stringify([...previous, interruption])];
    await lease.write(() => commitItemMutation({ id: canonicalId, item, options: { author: engine.author, field, message: 'Swarm capacity interruption' } },
      admitted => engine.client.update(admitted.id, admitted.options), { history: historyHead, generation: { token } }), { announce: false });
    return { id: canonicalId, interruption };
  });
}
