import { readFileSync } from 'node:fs';
import { getItemPath } from '@unbrained/pm-cli/sdk';
import type { sharedFixture } from './shared-helpers.ts';

/** Read native durable bytes, projecting only independent native clocks. */
export function nativeBytes(pmRoot: string, id: string): string {
  return readFileSync(getItemPath(pmRoot, 'Task', id), 'utf8').split('\n').filter(line => !/^(?:updated_at|closed_at|completed_at):/.test(line)).join('\n');
}
/** Create and natively block a fresh dependent without imitating core close selection. */
export async function blockedDependent(f: Awaited<ReturnType<typeof sharedFixture>>, blocker: string): Promise<string> {
  const id = await f.item(); await f.client.update(id, { status: 'blocked', blockedBy: blocker, blockedReason: 'Public dependency' }); return id;
}
/** Prepare the ordinary fenced claim used by each close interleaving. */
export async function closeClaim(f: Awaited<ReturnType<typeof sharedFixture>>) {
  const id = await f.item(); return { id, claim: await f.shared.start(id) };
}
