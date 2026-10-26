import { readItem } from './inspection.ts';
import type { PmClient } from '@unbrained/pm-cli/sdk';
import { commitMutation } from './settings.ts';

/** Preserve recovery decisions only while ownership, lifecycle and item revision match. */
export function recoverySnapshotMatches(snapshot: Record<string, unknown>, current: Record<string, unknown>): boolean {
  return ['parent', 'assignee', 'status', 'updated_at', 'swarm_token', 'swarm_claimed_at', 'swarm_branch', 'swarm_base', 'swarm_base_ref'].every(field => snapshot[field] === current[field]);
}

/** Admit freshly read recovery state before either tracker release or local lane deletion. */
export async function recoveryItem(client: Pick<PmClient, 'get'>, snapshot: Record<string, unknown>, refused: { id: string; reason: string }[]): Promise<Record<string, unknown> | undefined> {
  const item = (await readItem(client, String(snapshot.id))).item;
  if (!recoverySnapshotMatches(snapshot, item)) return undefined;
  try { return commitMutation(item, admitted => admitted); }
  catch { refused.push({ id: String(item.id), reason: 'Unsafe foreign context; preserve this claim and lane for explicit privacy review' }); return undefined; }
}
