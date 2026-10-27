import type { ItemHistoryHead } from './settings.ts';
import { historySnapshot, readItem } from './inspection.ts';
import type { PmClient } from '@unbrained/pm-cli/sdk';
import { commitMutation, documentFingerprint } from './settings.ts';

/** Preserve recovery decisions only while ownership, lifecycle and item revision match. */
export function recoverySnapshotMatches(snapshot: Record<string, unknown>, current: Record<string, unknown>): boolean {
  return ['parent', 'assignee', 'status', 'updated_at', 'swarm_token', 'swarm_claimed_at', 'swarm_branch', 'swarm_base', 'swarm_base_ref'].every(field => snapshot[field] === current[field]);
}

/** Admit freshly read recovery state before either tracker release or local lane deletion. */
export async function recoveryItem(client: Pick<PmClient, 'get'>, snapshot: Record<string, unknown>, refused: { id: string; reason: string }[], pmRoot: string): Promise<{ item: Record<string, unknown>; historyHead: ItemHistoryHead } | undefined> {
  let native: Awaited<ReturnType<typeof historySnapshot>>;
  try { native = await historySnapshot(pmRoot, String(snapshot.id)); }
  catch { refused.push({ id: String(snapshot.id), reason: 'Native history is unavailable; preserve this foreign claim and lane for explicit history review' }); return undefined; }
  try {
    const item = (await readItem(client, String(snapshot.id))).item;
    if (!recoverySnapshotMatches(snapshot, item)) return undefined;
    return commitMutation(item, admitted => {
      if (documentFingerprint({ ...native.document.metadata, body: native.document.body }) !== documentFingerprint(admitted)) {
        refused.push({ id: String(item.id), reason: 'Native history does not describe the current document; preserve this foreign claim and lane for explicit history review' }); return undefined;
      }
      return { item: admitted, historyHead: native.historyHead };
    });
  } catch { refused.push({ id: String(snapshot.id), reason: 'Unsafe foreign context; preserve this claim and lane for explicit privacy review' }); return undefined; }
}
