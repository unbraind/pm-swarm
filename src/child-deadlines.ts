import type { LinkedTest } from '@unbrained/pm-cli/sdk';

/** Bound coordinator overhead without truncating any declared per-test timeout. */
export function linkedTestDeadline(tests: readonly Pick<LinkedTest, 'timeout_seconds'>[]): number {
  return tests.reduce((total, test) => total + (test.timeout_seconds ?? 3600) * 1000, 300000);
}

