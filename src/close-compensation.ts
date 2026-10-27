import { closeEffects } from './close-journal.ts';
import type { CloseEffect } from './close-journal.ts';
import { SettingsRefusal, assertPrivatePathSafe, readItemHistoryHead } from './settings.ts';

/** A native close changed more than the primary item, so automatic rollback requires explicit review. */
export class CompensationPartialRefusal extends SettingsRefusal {
  /** Members whose rollback is certified by durable progress; this limited implementation restores none. */
  readonly restored: readonly string[] = Object.freeze([]);
  /** Members requiring reconciliation; membership is never inferred from matching document content. */
  readonly pending: readonly string[];
  /** The existing SDK transaction identifies the interrupted lifecycle operation. */
  readonly transaction_id: string;
  /** Older journals may lack enough data to enumerate all affected dependents. */
  readonly scope_unknown: boolean;
  /** Refuse before any restore, preserving the native close and every peer mutation. */
  constructor(transactionId: string, primary: string, pending: readonly string[], scopeUnknown = false) {
    const members = [...new Set([primary, ...pending])];
    assertPrivatePathSafe({ transactionId, members });
    const receipt = JSON.stringify({ restored: [], pending: members, transaction_id: transactionId, scope_unknown: scopeUnknown });
    super('swarm_compensation_partial', `Automatic multi-item compensation is deferred. Preserve the items and SDK journal; inspect native close and dependent history before explicitly reconciling them. Compensation receipt: ${receipt}`, 'compensation');
    this.name = 'CompensationPartialRefusal'; this.pending = Object.freeze(members); this.transaction_id = transactionId; this.scope_unknown = scopeUnknown;
  }
}

/** Limit compensation to primary-only operations until durable per-member progress is implemented. */
export async function requirePrimaryOnlyCompensation(pmRoot: string, primary: string, transactionId: string, result: unknown, data: unknown, observed?: readonly CloseEffect[]): Promise<void> {
  const effects = closeEffects(result) ?? observed;
  if (effects !== undefined) {
    if (effects.length > 0) throw new CompensationPartialRefusal(transactionId, primary, effects.map(effect => effect.id));
    return;
  }
  const domain = closeEffects(data);
  if (domain === undefined) throw new CompensationPartialRefusal(transactionId, primary, [], true);
  const changed: string[] = []; let unknown = false;
  for (const member of domain) {
    try {
      const head = await readItemHistoryHead(pmRoot, member.id);
      if (head.length !== member.before.historyHead.length || head.hash !== member.before.historyHead.hash) changed.push(member.id);
    } catch { changed.push(member.id); unknown = true; }
  }
  if (changed.length > 0) throw new CompensationPartialRefusal(transactionId, primary, changed, unknown);
}
