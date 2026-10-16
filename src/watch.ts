import { encodeToon } from '@unbrained/pm-cli/sdk/testing';
import type { Swarm } from './swarm.ts';

/** The measured status shape shared with the normal status command. */
type Status = Awaited<ReturnType<Swarm['status']>>;
/** A portable change record emitted once when its measured state changes. */
export interface StatusEvent {
  event: string;
  data: unknown;
}

/** Compare observable lane state and conflicts, ignoring simulation object identities. */
export function statusChanges(previous: Status | undefined, current: Status): StatusEvent[] {
  const events: StatusEvent[] = [];
  const oldLanes = new Map(previous?.lanes.map(row => [row.id, row]));
  const newLanes = new Map(current.lanes.map(row => [row.id, row]));
  for (const row of current.lanes) {
    const old = oldLanes.get(row.id);
    if (JSON.stringify(old) !== JSON.stringify(row)) events.push({ event: old === undefined ? 'lane_added' : 'lane_changed', data: row });
  }
  for (const row of oldLanes.values()) if (!newLanes.has(row.id)) events.push({ event: 'lane_removed', data: row });
  /** Retain only meaningful conflict evidence, with stable pair keys. */
  const conflicts = (status: Status | undefined) => new Map(status?.predictions.filter(row => !row.clean).map(row => {
    const [left_id, right_id] = [row.left_id, row.right_id].sort();
    return [JSON.stringify([left_id, right_id]), { left_id, right_id, conflicts: [...row.conflicts].sort(), messages: [...row.messages].sort() }];
  }));
  const before = conflicts(previous); const after = conflicts(current);
  for (const [key, row] of after) if (JSON.stringify(before.get(key)) !== JSON.stringify(row)) events.push({ event: before.has(key) ? 'conflict_changed' : 'conflict_predicted', data: row });
  for (const [key, row] of before) if (!after.has(key)) events.push({ event: 'conflict_resolved', data: row });
  return events;
}

/** Reject unbounded timers and clamp short polling requests to two seconds. */
export function watchInterval(value = '2'): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw new Error('Watch interval must be positive and at most 86400 seconds');
  return Math.max(2, seconds) * 1000;
}

/** Wait once, releasing both timer and abort listener on either completion path. */
async function pause(interval: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>(resolve => {
    /** Finish an interruptible polling delay without leaving a live timer. */
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, interval);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Poll serially and emit only changes; an aborted signal releases a pending delay. */
export async function watchStatus(swarm: Swarm, interval: number, signal: AbortSignal, emit: (event: StatusEvent) => void): Promise<void> {
  let previous: Status | undefined;
  while (!signal.aborted) {
    const current = await swarm.status();
    for (const event of statusChanges(previous, current)) emit(event);
    previous = current;
    if (!signal.aborted) await pause(interval, signal);
  }
}

/** Stream native TOON blocks or JSON lines and restore the process signal listener. */
export async function runWatch(swarm: Swarm, interval: number, json: boolean): Promise<void> {
  const controller = new AbortController();
  /** Stop polling on SIGINT without leaving a timer or swallowing status errors. */
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  try {
    await watchStatus(swarm, interval, controller.signal, event => { process.stdout.write(json ? `${JSON.stringify(event)}\n` : `${encodeToon(event)}\n\n`); });
  } finally { process.removeListener('SIGINT', stop); }
}
