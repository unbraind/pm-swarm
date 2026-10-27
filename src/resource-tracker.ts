import { assertPrivatePathSafe, commitItemMutation, SettingsRefusal } from './settings.ts';
import { readSettings, resolveRuntimeStatusRegistry, statusIsTerminal, discoverExtensions } from '@unbrained/pm-cli/sdk';
import { historySnapshot, inspectItem } from './inspection.ts';
import { withSwarmLease } from './lease.ts';
import { RESOURCE_TAG, ResourceRefusal } from './resources.ts';
import type { ResourceBackend, ResourceRecord } from './resources.ts';
import type { Swarm } from './swarm.ts';

/** Bind the existing filesystem tracker lease to portable resource transactions.
 * Service-capable storage extensions require their own ResourceBackend; refusing
 * them before taking a local pin prevents accidentally coordinating remote data
 * through a process-local shadow. No provider failure is retried on another backend.
 */
export function trackerResourceBackend(engine: Swarm): ResourceBackend {
  /** Verify storage ownership conservatively without activating extension code again. */
  const supported = async () => {
    const settings = await readSettings(engine.pmRoot);
    const discovered = await discoverExtensions({ pmRoot: engine.pmRoot, cwd: engine.repo, settings });
    if (discovered.effective.some(extension => extension.capabilities === undefined || extension.capabilities.length === 0 || extension.capabilities.includes('services'))) {
      throw new ResourceRefusal('resource_backend_refused', 'This storage configuration needs an explicit ResourceBackend with tracker-wide fencing; configure that backend instead of local coordination.');
    }
    return settings;
  };
  /** Read only resource metadata; reject terminal items and preserve ordinary claims. */
  const snapshot = async (id: string) => {
    const settings = await supported();
    const local = await inspectItem(engine.pmRoot, engine.repo, id);
    if (local === null) throw new ResourceRefusal('resource_backend_refused', 'Storage ownership changed during admission; configure its explicit ResourceBackend before retrying.');
    const item = local.item;
    return { item: { ...item, body: local.body }, record: { id: String(item.id), resource: (item.tags as string[]).includes(RESOURCE_TAG) && !statusIsTerminal(String(item.status), resolveRuntimeStatusRegistry(settings.schema)), token: String(item.swarm_token ?? '0'), owner: typeof item.assignee === 'string' && item.assignee.trim() ? item.assignee : null, expires_at: typeof item.swarm_resource_expires_at === 'string' ? item.swarm_resource_expires_at : null } };
  };
  return {
    read: async (id: string): Promise<ResourceRecord> => (await snapshot(id)).record,
    /** Serialize with #12 claims and hold its live writer pin across the SDK commit. */
    async transact(id, author, decide) {
      await supported();
      return withSwarmLease(engine.pmRoot, author, lease => lease.write(async () => {
        const { item, record: currentRecord } = await snapshot(id);
        assertPrivatePathSafe(item, 'document');
        const next = decide(currentRecord);
        lease.assert();
        const initial = await historySnapshot(engine.pmRoot, String(item.id));
        let publication: Record<string, unknown> | undefined;
        lease.onFailure(async () => {
          if (publication === undefined || next.owner !== author || next.token === currentRecord.token) return;
          const current = await engine.acquisitionSnapshot(String(item.id), initial.version + 1, publication);
          if (current.document.metadata.swarm_token !== next.token || current.document.metadata.swarm_resource_expires_at !== next.expires_at) throw new SettingsRefusal('swarm_document_changed', 'A peer changed the acquired reservation; preserve its state and inspect resource history before retrying.');
          await lease.write(() => commitItemMutation({ id: next.id, item: { ...current.document.metadata, body: current.document.body }, options: { author, unset: ['assignee', 'swarm_resource_expires_at'], message: 'Release failed reservation acquisition' } }, admitted => engine.client.update(admitted.id, admitted.options), { generation: { token: next.token } }), { announce: false });
        });
        await commitItemMutation({ id: next.id, options: {
          author, force: true,
          ...(next.owner === null ? { unset: ['assignee', 'swarm_resource_expires_at'] } : { assignee: next.owner }),
          field: [`swarm_token=${next.token}`, ...(next.expires_at === null ? [] : [`swarm_resource_expires_at=${next.expires_at}`])],
          comment: [next.note === undefined ? `Swarm resource generation ${next.token}: ${next.owner === null ? 'released' : 'reserved until ' + next.expires_at}` : `Swarm resource generation ${next.token}: ${next.note}`],
        }, item }, async admitted => { const result = await engine.client.update(admitted.id, admitted.options); publication = result.item; return result; }, { onCommitted: (_before, after) => { publication = after.metadata; } });
        const { note: _note, ...record } = next; return record;
      }));
    },
  };
}
