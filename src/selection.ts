import { overlaps } from './planner.ts';
import type { Candidate } from './types.ts';

/** Declared paths and optional measured changes for one owned lane. */
export interface ActiveFootprint {
  id: string;
  files: string[];
  branch?: string;
  changed?: string[];
}
/** Ready work ranked consistently in either coordination mode. */
export type RankedCandidate = Candidate & { priority: number; created_at: string };

/** Name intersecting paths and conservatively block unmeasured active lanes. */
export function footprintOverlaps(files: string[], active: ActiveFootprint[]) {
  const result: { lane_id: string; branch?: string; path: string; lane_path: string }[] = [];
  for (const lane of active) {
    const paths = [...new Set([...lane.files, ...(lane.changed ?? [])])].sort();
    const identity = { lane_id: lane.id, ...(lane.branch === undefined ? {} : { branch: lane.branch }) };
    if (paths.length === 0 && files.length > 0) result.push({ ...identity, path: '*', lane_path: 'unknown footprint' });
    for (const path of files) for (const lanePath of paths) if (overlaps(path, lanePath)) result.push({ ...identity, path, lane_path: lanePath });
  }
  return result;
}

/** Select known safe work before unknown footprints, retaining every skip reason. */
export function selectNext(candidates: RankedCandidate[], active: ActiveFootprint[], rank = defaultRank, strictUnknown = false) {
  candidates.sort(rank);
  const evaluated = candidates.map(item => ({ item, overlaps: footprintOverlaps(item.files, active) }));
  const safe = evaluated.find(row => row.overlaps.length === 0 && (row.item.files.length > 0 || (strictUnknown && active.length === 0)));
  const chosen = safe ?? (strictUnknown && active.length > 0 ? undefined : evaluated.find(row => row.item.files.length === 0));
  const unknown = chosen !== undefined && chosen.item.files.length === 0;
  const warnings = unknown ? ['Unknown footprint: no known conflict-free candidate exists; inspect the lane before editing.'] : [];
  const skipped = evaluated.filter(row => row !== chosen).map(row => ({ id: row.item.id, reasons: row.overlaps.length > 0 ? row.overlaps.map(overlap => `Overlap with lane ${overlap.lane_id} on path ${overlap.path} (${overlap.lane_path})`) : [row.item.files.length === 0 ? 'Unknown footprint deferred' : 'Lower rank: priority, then oldest creation time, then id'], overlaps: row.overlaps }));
  const reason = chosen === undefined ? 'No ready unclaimed candidate can start safely' : unknown ? 'Unknown footprint fallback after checking all known candidates' : 'Best non-overlapping candidate by priority, then oldest creation time, then id';
  return { chosen, unknown, warnings, skipped, reason };
}

/** Preserve next's original priority ordering unless an explicit policy is supplied. */
function defaultRank(a: RankedCandidate, b: RankedCandidate): number {
  return a.priority - b.priority || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}
