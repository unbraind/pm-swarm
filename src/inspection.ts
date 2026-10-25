import { createMutationGuardSdk, discoverExtensions, readSettings, resolveItemTypeRegistry } from '@unbrained/pm-cli/sdk';

/** Inspect current local metadata through the public SDK guard without client cache or usage writes.
 * Service-backed reads remain owned by the host: a null result tells callers to
 * use their bound client, never to interpret a local shadow as provider state.
 */
export async function inspectItem(pmRoot: string, cwd: string, id: string) {
  const settings = await readSettings(pmRoot);
  const discovered = await discoverExtensions({ pmRoot, cwd, settings });
  if (discovered.effective.some(extension => extension.capabilities === undefined || extension.capabilities.length === 0 || extension.capabilities.includes('services'))) return null;
  return createMutationGuardSdk({ pmRoot, settings, typeToFolder: resolveItemTypeRegistry(settings).type_to_folder }).get(id);
}
