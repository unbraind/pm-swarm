import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getItemPath } from '@unbrained/pm-cli/sdk';
import type { sharedFixture } from './shared-helpers.ts';
import type { ITEM_MUTATION_BOUNDARIES } from '../src/settings.ts';
import { historyPeerProcess, peerBytes } from './history-aba-helpers.ts';

/** Read native durable bytes, projecting only independent clocks and package-owned receipt fields. */
export function nativeBytes(pmRoot: string, id: string): string {
  return readFileSync(getItemPath(pmRoot, 'Task', id), 'utf8').split('\n').filter(line => !/^(?:updated_at|closed_at|completed_at|swarm_\w+):/.test(line)).join('\n');
}
/** Create and natively block a fresh dependent without imitating core close selection. */
export async function blockedDependent(f: Awaited<ReturnType<typeof sharedFixture>>, blocker: string): Promise<string> {
  const id = await f.item(); await f.client.update(id, { status: 'blocked', blockedBy: blocker, blockedReason: 'Public dependency' }); return id;
}
/** Prepare the ordinary fenced claim used by each close interleaving. */
export async function closeClaim(f: Awaited<ReturnType<typeof sharedFixture>>) {
  const id = await f.item(); return { id, claim: await f.shared.start(id) };
}
/** Inject a genuine independent SDK peer at exactly one nested admission boundary. */
export function closePeer(f: Awaited<ReturnType<typeof sharedFixture>>, id: string, stage: number, boundary: typeof ITEM_MUTATION_BOUNDARIES[number]) {
  const state = { index: -1, injected: false, bytes: [] as string[] };
  return { state, observe(step: typeof ITEM_MUTATION_BOUNDARIES[number]) {
    if (step === 'admitted') state.index++;
    if (state.injected || state.index !== stage || step !== boundary) return;
    state.injected = true;
    const worker = historyPeerProcess(f.repo, f.pmRoot, 'shared-test', id);
    assert.equal(worker.status, 0, worker.stdout + worker.stderr); state.bytes = peerBytes(f.pmRoot, id);
  } };
}
