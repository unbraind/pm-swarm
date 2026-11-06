import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getHistoryPath, getItemPath } from '@unbrained/pm-cli/sdk';
import { sharedFixture } from './shared-helpers.ts';
import { blockedDependent } from './close-native-helpers.ts';
import { CLOSE_INTENT } from '../src/close-journal.ts';
import type { CloseJournal } from '../src/close-journal.ts';

/** Capture actual bytes and immutable audit prefixes for all native close members. */
export function closeBytes(f: Awaited<ReturnType<typeof sharedFixture>>, ids: string[]) {
  return { items: ids.map(id => readFileSync(getItemPath(f.pmRoot, 'Task', id), 'utf8')), histories: ids.map(id => readFileSync(getHistoryPath(f.pmRoot, id), 'utf8')) };
}
/** Run an actual OS process with an optional SIGKILL or ordinary failure at a diagnostic boundary. */
export function closeProcess(f: Awaited<ReturnType<typeof sharedFixture>>, id: string, token: string, options: { kill?: number | { boundary: string; occurrence?: number }; fail?: string; author?: string; note?: string } = {}) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./close-recovery-worker.ts', import.meta.url)), JSON.stringify({ repo: f.repo, pmRoot: f.pmRoot, id, token, ...options })], { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 90000 });
  assert.equal(result.error, undefined);
  const rows = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { boundary?: string; id?: string; code?: string; result?: unknown });
  return { ...result, rows, boundaries: rows.filter(row => row.boundary !== undefined).map(row => row.boundary!), outcome: rows.at(-1) };
}
/** Prepare one non-Git tracker through the same real SDK path used by the supported workflow. */
export async function recoveryFixture(t: Parameters<typeof sharedFixture>[0], count: number) {
  const f = await sharedFixture(t); const id = await f.item(); const claim = await f.shared.start(id);
  const ids = [id]; for (let index = 0; index < count; index++) ids.push(await blockedDependent(f, id));
  return { f, id, token: claim.token, ids, before: closeBytes(f, ids) };
}
/** Assert exact native rollback and strictly append-only histories, including repeated recovery. */
export function assertCompensated(f: Awaited<ReturnType<typeof sharedFixture>>, ids: string[], before: ReturnType<typeof closeBytes>) {
  const after = closeBytes(f, ids); assert.deepEqual(after.items, before.items);
  for (const [index, history] of after.histories.entries()) assert.ok(history.startsWith(before.histories[index]));
}
/** Return a real interrupted native close and its durable public intent for ownership controls. */
export async function pendingClose(t: Parameters<typeof sharedFixture>[0], count = 1, boundary = 'before_commit') {
  const fixture = await recoveryFixture(t, count);
  const killed = closeProcess(fixture.f, fixture.id, fixture.token, { kill: { boundary } });
  assert.equal(killed.signal, 'SIGKILL', killed.stdout + killed.stderr);
  const native = await fixture.f.client.get(fixture.id, { depth: 'full' });
  const journal = JSON.parse(String(native.item[CLOSE_INTENT])) as CloseJournal;
  return { ...fixture, journal };
}
/** A refused recovery must preserve every native item byte and every audit-stream byte. */
export function assertRefusedClosePreserves(f: Awaited<ReturnType<typeof sharedFixture>>, id: string, token: string, ids: string[]): void {
  const original = closeBytes(f, ids); const attempt = closeProcess(f, id, token);
  assert.equal(attempt.outcome?.code, 'swarm_compensation_partial', attempt.stdout + attempt.stderr);
  assert.deepEqual(closeBytes(f, ids), original);
}
