import assert from 'node:assert/strict';
import { isPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Fingerprint every directory, file byte and symlink in the tracker, including runtime and history. */
export function snapshot(root: string): string {
  const entries = readdirSync(root, { recursive: true, encoding: 'utf8' }).sort().map(name => {
    const path = join(root, name); const stat = lstatSync(path);
    return [name, stat.isSymbolicLink() ? ['link', readlinkSync(path)] : stat.isDirectory() ? ['directory'] : ['file', createHash('sha256').update(readFileSync(path)).digest('hex')]];
  });
  return JSON.stringify(entries);
}
/** Exclude only SDK-owned ignored cache/usage files while retaining every package runtime/lease record. */
export function durableSnapshot(root: string): string {
  return JSON.stringify((JSON.parse(snapshot(root)) as [string, unknown][]).filter(([name]) => !name.startsWith('runtime/') || name.startsWith('runtime/swarm')));
}
/** Refusal must have no returned receipt, stream bytes or partial tracker write. */
export async function unchanged(root: string, action: () => Promise<unknown>, label: string, accepts: (error: unknown) => boolean = () => true): Promise<void> {
  const before = snapshot(root); let writes = 0; const original = process.stdout.write;
  process.stdout.write = new Proxy(original, { apply() { writes++; return true; } });
  try { await assert.rejects(action, accepts, label); }
  finally { process.stdout.write = original; }
  assert.equal(writes, 0, `${label}: partial output`);
  assert.equal(snapshot(root), before, `${label}: tracker changed`);
}


/** Verify the real SDK refusal and collect its stable category without accepting arbitrary errors. */
export function matchesRefusal(error: unknown, code: string | undefined, codes: Set<string>): boolean {
  assert.ok(isPmCliExpectedError(error));
  if (code !== undefined) assert.equal(error.code, code, String(error));
  if (typeof error.code === 'string') codes.add(error.code);
  return true;
}
