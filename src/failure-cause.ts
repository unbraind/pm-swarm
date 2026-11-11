/** Preserve diagnostic provenance privately while retaining the authoritative recovery outcome and existing causes. */
export function retainFailureCause<T>(outcome: T, failure: unknown): T {
  if (outcome instanceof Error && outcome.cause === undefined) Object.defineProperty(outcome, 'cause', { value: failure, enumerable: false });
  return outcome;
}
