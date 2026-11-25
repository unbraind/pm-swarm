/** Normalize an explicit-zone timestamp after checking its local calendar fields round-trip. */
export function capacityInstant(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if (match === null) return undefined;
  const local = match[1] + '.' + (match[2] ?? '').padEnd(3, '0') + 'Z';
  const localTime = Date.parse(local);
  if (!Number.isFinite(localTime) || new Date(localTime).toISOString() !== local) return undefined;
  const utcTime = Date.parse(value);
  if (!Number.isFinite(utcTime)) return undefined;
  const normalized = new Date(utcTime).toISOString();
  return normalized.length === 24 ? normalized : undefined;
}
