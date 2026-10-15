import { chain, predict } from './git.ts';
import type { Lane } from './types.ts';

/** Search actual sequential merges, backtracking when a clean prefix leads to a dead end. */
export function cleanOrder(repo: string, base: string, lanes: Lane[]): Lane[] | null {
  if (lanes.length === 0) return [];
  for (const lane of lanes) {
    const result = predict(repo, base, lane.sha);
    if (result.conflicts.length > 0) continue;
    const next = chain(repo, base, lane.sha, result.tree);
    const tail = cleanOrder(repo, next, lanes.filter(other => other.id !== lane.id));
    if (tail !== null) return [lane, ...tail];
  }
  return null;
}
/** Enumerate subsets by cardinality to return a smallest unlandable group. */
export function minimalConflict(repo: string, base: string, lanes: Lane[]): string[] {
  for (let size = 1; size <= lanes.length; size++) {
    const subsets = combinations(lanes, size);
    for (const subset of subsets) if (cleanOrder(repo, base, subset) === null) return subset.map(lane => lane.id);
  }
  return [];
}
/** Preserve deterministic input order while enumerating fixed-cardinality subsets. */
function combinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  return items.flatMap((item, index) => combinations(items.slice(index + 1), size - 1).map(tail => [item, ...tail]));
}

/** Select the largest clean subset; sorted IDs break equal-size order ties deterministically. */
export function maximalCleanOrder(repo: string, base: string, lanes: Lane[]): Lane[] {
  const sorted = [...lanes].sort((left, right) => left.id.localeCompare(right.id));
  for (let size = sorted.length; size > 0; size--) {
    for (const subset of combinations(sorted, size)) {
      const order = cleanOrder(repo, base, subset);
      if (order !== null) return order;
    }
  }
  return [];
}
