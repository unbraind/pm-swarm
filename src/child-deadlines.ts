import type { LinkedTest } from '@unbrained/pm-cli/sdk';

/** Bound coordinator overhead without truncating any declared per-test timeout. */
export function linkedTestDeadline(tests: readonly Pick<LinkedTest, 'timeout_seconds'>[]): number {
  return tests.reduce((total, test) => total + Math.max(3600, test.timeout_seconds ?? 0) * 1000, 300000);
}

