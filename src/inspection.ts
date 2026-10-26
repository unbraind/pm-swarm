import { createMutationGuardSdk, discoverExtensions, isReadOutputBudgetExceeded, readSettings, resolveItemTypeRegistry } from '@unbrained/pm-cli/sdk';
import type { GetResult, PmClient, PmReadOutputBudgetExceeded } from '@unbrained/pm-cli/sdk';
import { SettingsRefusal } from './settings.ts';

/** Internal decisions must compare complete values rather than agent-facing budget projections. */
const COMPLETE_READ_OUTPUT = { outputBudget: 'unbounded', outputLimit: 'unbounded' } as const;
/** Every mutation snapshot includes the entire SDK document and body. */
const FULL_ITEM_READ = { depth: 'full', ...COMPLETE_READ_OUTPUT } as const;
/** Reject the SDK's budget-refusal envelope instead of treating it as a partial item snapshot. */
export function requireItemRead(value: GetResult | PmReadOutputBudgetExceeded): GetResult {
  if (isReadOutputBudgetExceeded(value)) throw new SettingsRefusal('swarm_input_invalid', 'The host refused the complete item read; remove read limits or adjust its read policy before retrying this mutation.');
  return value;
}
/** Read complete internal values through the caller's exact host client; only explicit ownership queries project fields. */
export async function readItem(client: Pick<PmClient, 'get'>, id: string, fields?: string): Promise<GetResult> {
  return requireItemRead(await client.get(id, fields === undefined ? FULL_ITEM_READ : { fields, ...COMPLETE_READ_OUTPUT }));
}

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
