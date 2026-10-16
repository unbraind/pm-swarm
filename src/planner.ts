import { posix } from 'node:path';
import type { Candidate, Separation } from './types.ts';

/** Normalize portable repository paths and refuse host paths or parent escapes. */
export function footprintPath(path: string): string {
  const clean = posix.normalize(path.replaceAll('\\', '/')).replace(/\/$/, '');
  if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean === '..' || clean.startsWith('../') || clean.includes('\0')) throw new Error('Footprints must be repository-relative paths');
  return clean;
}
/** Treat omitted SDK file collections as unknown footprints on every lane path. */
export function itemFootprint(item: { files?: readonly { path: string }[] }): string[] {
  return (item.files ?? []).map(file => footprintPath(file.path));
}
/** Equality and directory containment both imply intersecting footprints. */
export function overlaps(left: string, right: string): boolean {
  const a = footprintPath(left); const b = footprintPath(right);
  return a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
/** Explain every reason two candidates must be separated. */
export function separation(left: Candidate, right: Candidate): string[] {
  const reasons: string[] = [];
  if (left.files.length === 0 || right.files.length === 0) reasons.push('unknown footprint');
  if (left.dependencies.includes(right.id) || right.dependencies.includes(left.id)) reasons.push('dependency');
  for (const a of left.files) for (const b of right.files) if (overlaps(a, b)) reasons.push(`footprint overlap: ${a} <> ${b}`);
  return reasons;
}
/** Partition ready work into safe waves; unknown footprints receive a solitary wave. */
export function partition(candidates: Candidate[], limit: number) {
  const lanes: Candidate[][] = []; const separations: Separation[] = [];
  for (const [i, left] of candidates.entries()) for (const right of candidates.slice(i + 1)) {
    const reasons = separation(left, right);
    if (reasons.length > 0) separations.push({ left: left.id, right: right.id, reasons });
  }
  for (const item of candidates) {
    const lane = lanes.find(group => group.length < limit && group.every(other => separation(item, other).length === 0));
    if (lane === undefined) lanes.push([item]); else lane.push(item);
  }
  for (const [i, left] of candidates.entries()) for (const right of candidates.slice(i + 1)) {
    if (!lanes.some(group => group.includes(left) && group.includes(right)) && separation(left, right).length === 0) separations.push({ left: left.id, right: right.id, reasons: ['assigned to a separate wave'] });
  }
  return {
    lanes: lanes.map((items, index) => ({ lane: index + 1, items: items.map(item => ({ id: item.id, footprint: item.files.length === 0 ? 'unknown' : 'known', files: item.files })) })),
    separations,
    capacity: limit,
    suggested_start_set: (lanes[0] ?? []).map(item => item.id),
  };
}
