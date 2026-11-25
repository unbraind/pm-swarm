import { StaleFenceError } from './lease.ts';
import { assertPrivatePathSafe } from './settings.ts';

/** Decode receiver context only when its object shape and decimal fence are valid. */
export function parseHandoffContext(id: string, raw: string, token: unknown): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new StaleFenceError(id); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new StaleFenceError(id);
  const context = parsed as Record<string, unknown>;
  if (typeof context.token !== 'string' || !/^\d+$/.test(context.token) || context.token !== token) throw new StaleFenceError(id);
  assertPrivatePathSafe(context, 'context');
  return context;
}

/** Restore valid receiver context at the newer fence after a compensated Git attachment. */
export function reissueHandoff(item: Record<string, unknown>, token: string): string | undefined {
  if (typeof item.swarm_handoff !== 'string') return undefined;
  try {
    const context = parseHandoffContext(String(item.id), item.swarm_handoff, item.swarm_token);
    return JSON.stringify({ ...context, token });
  } catch (error) {
    if (error instanceof StaleFenceError) return undefined;
    throw error;
  }
}
