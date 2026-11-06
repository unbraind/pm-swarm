import { readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { getItemPath, PmClient } from '@unbrained/pm-cli/sdk';
import type { sharedFixture } from './shared-helpers.ts';

/** Compare native lifecycle bytes separately from clocks and the explicit package-owned completion fields. */
export function nativeBytes(pmRoot: string, id: string): string {
  return readFileSync(getItemPath(pmRoot, 'Task', id), 'utf8').split('\n').filter(line => !/^(?:updated_at|closed_at|completed_at|swarm_close_intent|swarm_token|swarm_claimed_at|swarm_handoff):/.test(line)).join('\n');
}
/** Create and natively block a fresh dependent without imitating core close selection. */
export async function blockedDependent(f: Awaited<ReturnType<typeof sharedFixture>>, blocker: string): Promise<string> {
  const id = await f.item(); await f.client.update(id, { status: 'blocked', blockedBy: blocker, blockedReason: 'Public dependency' }); return id;
}
/** Prepare the ordinary fenced claim used by each close interleaving. */
export async function closeClaim(f: Awaited<ReturnType<typeof sharedFixture>>) {
  const id = await f.item(); return { id, claim: await f.shared.start(id) };
}
/** Run native lifecycle policy on an identical SDK tracker, independently of swarm's coordinator. */
export async function nativeCloseOracle(f: Awaited<ReturnType<typeof sharedFixture>>, id: string, note: string) {
  const root = join(f.repo, 'native-oracle'); cpSync(f.pmRoot, root, { recursive: true });
  const client = new PmClient({ cwd: f.repo, pmRoot: root, author: 'shared-test' });
  return { root, client, result: await client.close(id, note) };
}
