import { createMutationGuardSdk, discoverExtensions, isReadOutputBudgetExceeded, readSettings, resolveItemTypeRegistry, runWithActiveExtensions, getItemAt, readHistoryEntries, getHistoryPath, hashHistoryStream } from '@unbrained/pm-cli/sdk';
import type { GetResult, GetItemAtResult, PmClient, PmReadOutputBudgetExceeded } from '@unbrained/pm-cli/sdk';
import type { ItemHistoryHead } from './settings.ts';
import { SettingsRefusal, documentFingerprint, assertItemHistoryHead, assertSdkInstance } from './settings.ts';

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
async function localGuard(pmRoot: string, cwd: string) {
  const settings = await readSettings(pmRoot);
  const discovered = await discoverExtensions({ pmRoot, cwd, settings });
  if (discovered.effective.some(extension => extension.capabilities === undefined || extension.capabilities.length === 0 || extension.capabilities.includes('services'))) return null;
  return createMutationGuardSdk({ pmRoot, settings, typeToFolder: resolveItemTypeRegistry(settings).type_to_folder });
}
/** Inspect local metadata without client usage receipts; providers always retain their bound client. */
export async function inspectItem(pmRoot: string, cwd: string, id: string) { return (await localGuard(pmRoot, cwd))?.get(id) ?? null; }
/** Preflight receiver metadata through the SDK guard; this is never a selection or provider fallback. */
export async function inspectItems(pmRoot: string, cwd: string) { return runWithActiveExtensions({ cwd, path: pmRoot }, async () => (await localGuard(pmRoot, cwd))?.list() ?? null); }

/** Reconstruct an exact SDK history version, including a stable latest head without timestamp guessing. */
export async function historySnapshot(pmRoot: string, id: string, version?: number): Promise<GetItemAtResult & { version: number; historyHead: ItemHistoryHead }> {
  try {
    const history = await readHistoryEntries(getHistoryPath(pmRoot, id), id);
    const target = version === undefined ? history.at(-1)?.ts : String(version);
    if (target === undefined) throw new Error('Empty history');
    const view = await getItemAt(id, target, { pmRoot });
    if (view.as_of_version === null || (view.history_length !== history.length || version === undefined && view.target.historyIndex !== history.length - 1)) throw new Error('Unstable history version');
    return { ...view, version: view.as_of_version, historyHead: { length: view.target.historyIndex + 1, hash: hashHistoryStream(history.slice(0, view.target.historyIndex + 1)) } };
  } catch { throw new SettingsRefusal('swarm_document_changed', 'The item history could not be verified; preserve its document and inspect its native history before retrying.', 'document'); }
}

/** Pair the decision document with a native head captured before its read; never refresh a stale baseline. */
export async function mutationSnapshot<Item extends Record<string, unknown>>(pmRoot: string, id: string, read: () => Promise<Item>) {
  assertSdkInstance();
  const native = await historySnapshot(pmRoot, id);
  const item = await read();
  assertSdkInstance();
  await assertItemHistoryHead(pmRoot, String(item.id), native.historyHead);
  if (documentFingerprint(item) !== documentFingerprint({ ...native.document.metadata, body: native.document.body })) throw new SettingsRefusal('swarm_document_changed', 'The native history does not describe the checked document; refresh the complete item and its history before retrying.', 'document');
  return { item, historyHead: native.historyHead, version: native.version };
}
