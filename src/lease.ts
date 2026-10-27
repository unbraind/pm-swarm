import { commitMutation, SettingsRefusal } from './settings.ts';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock } from '@unbrained/pm-cli/sdk';

/** A refused writer must refresh ownership instead of retrying its old token. */
export class StaleFenceError extends Error {
  /** Stable error code for embedded callers and CLI diagnostics. */
  readonly code = 'swarm_stale_fence';
  /** Identify the stale operation without revealing storage paths. */
  constructor(id: string) { super(`swarm_stale_fence: stale or missing fencing token for ${id}`); this.name = 'StaleFenceError'; }
}

/** Read runtime state strictly; absent state is distinct from damaged state. */
export function readRuntime<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; }
  catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
}

/** Replace one runtime record atomically, without truncating readers' data. */
function publish(path: string, value: unknown): void {
  commitMutation(value, admitted => publishAdmitted(path, admitted));
}
/** Publish only an admitted runtime record; temporary coordinates never become record content. */
function publishAdmitted(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}`;
  let owned = false; let descriptor: number;
  try {
    for (;;) {
      try { descriptor = openSync(temporary, 'wx'); owned = true; break; }
      catch (error) {
        const failure = error as NodeJS.ErrnoException;
        if (failure.code === 'EEXIST' && failure.path !== undefined && lstatSync(failure.path).isDirectory()) throw Object.assign(new Error('EISDIR: runtime publication requires a file'), { code: 'EISDIR' });
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(dirname(path), { recursive: true });
      }
    }
    try { writeFileSync(descriptor, JSON.stringify(value)); } finally { closeSync(descriptor); }
    renameSync(temporary, path);
  } finally { if (owned) rmSync(temporary, { force: true }); }
}

/** Remove only empty infrastructure directories this invocation created, preserving every peer record. */
function removeEmptyRuntime(root: string, created: string | undefined): void {
  if (created === undefined) return;
  const boundary = dirname(created);
  for (let directory = root; directory !== boundary; directory = dirname(directory)) {
    try { rmdirSync(directory); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (['ENOTEMPTY', 'EEXIST'].includes(String(code))) return;
      if (code !== 'ENOENT') throw error;
    }
  }
}

/** Retry only the SDK's explicit pre-write contention refusal, with bounded jitter. */
export async function retryLock<T>(operation: () => Promise<T>, budgetMs = 300000): Promise<T> {
  const until = Date.now() + budgetMs; let backoff = 25;
  for (;;) {
    try { return await operation(); }
    catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'lock_conflict' || Date.now() >= until) throw error;
      await delay(Math.min(until - Date.now(), backoff * (0.5 + Math.random()))); backoff = Math.min(backoff * 2, 1000);
    }
  }
}

/** Runtime files live in the host's ignored, tracker-local runtime directory. */
export function swarmRuntime(pmRoot: string): string {
  const root = join(pmRoot, 'runtime/swarm'); mkdirSync(root, { recursive: true }); return root;
}

/** Hash principals to prevent path traversal through agent names. */
export function heartbeatPath(pmRoot: string, author: string): string {
  return join(swarmRuntime(pmRoot), `agent-${createHash('sha256').update(author).digest('hex')}.json`);
}

/** Renew a principal's liveness without changing item history on each timer tick. */
export function touchHeartbeat(pmRoot: string, author: string): string {
  return commitMutation({ author, heartbeat: new Date().toISOString() }, admitted => { publish(heartbeatPath(pmRoot, admitted.author), { heartbeat: admitted.heartbeat }); return admitted.heartbeat; });
}

/** One process-owned operation lease, never stolen from a living writer. */
interface Owner { pid: number; process_start?: string; locality?: string; token: string; heartbeat: number }

/** Hash host-boot and PID-namespace identity; unavailable probes disable automatic recovery. */
export function leaseLocality(): string | undefined {
  try {
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8');
    const namespace = readlinkSync('/proc/self/ns/pid');
    return createHash('sha256').update(JSON.stringify([hostname(), boot, namespace])).digest('hex');
  } catch { return undefined; }
}

/** Distinguish reused Linux process IDs; unavailable platforms retain conservative live pins. */
export function processStart(pid: number): string | undefined {
  try { const raw = readFileSync(`/proc/${pid}/stat`, 'utf8'); return raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19]; }
  catch { return undefined; }
}

/** Keep live process pins conservative, including permission-denied probes and PID reuse. */
function alive(owner: Owner, locality: string | undefined): boolean {
  if (locality === undefined || owner.locality !== locality) return true;
  try {
    process.kill(owner.pid, 0);
    const birth = processStart(owner.pid);
    return owner.process_start === undefined || birth === undefined || owner.process_start === birth;
  }
  catch (error) { return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'); }
}

/** Revalidate an abandoned pin under the recovery lock before removing its generation. */
export async function recoverLeasePin(pmRoot: string, author: string, locality: string | undefined, observed: Owner): Promise<void> {
  const pin = join(swarmRuntime(pmRoot), 'operation-pin.json');
  const release = await retryLock(() => commitMutation({ resource: 'swarm-recovery', author }, admitted => acquireLock(pmRoot, admitted.resource, 30, admitted.author, false, false, 0)));
  try {
    const current = readRuntime<Owner>(pin);
    if (current?.token === observed.token && !alive(current, locality)) unlinkSync(pin);
  } finally { await release(); }
}

/** Tune durations; Git callers may retain the live process pin across synchronous work. */
export interface LeaseOptions {
  leaseMs?: number; renewMs?: number; waitMs?: number; allowBlocking?: boolean;
  /** Project a local Git worktree coordinate exactly as the command does before admitting shared content. */
  receiptWorkspace?: string;
}

/** Assertions and retriable writes bound to the current operation generation. */
export interface Lease {
  /** Refuse a resumed operation whose lease expired or was superseded. */
  assert(): void;
  /** Check the still-owned generation during cleanup, without requiring liveness renewal. */
  assertOwned(): void;
  /** Recheck the generation before every SDK write attempt. */
  write<T>(operation: () => Promise<T>, options?: { announce?: boolean }): Promise<T>;
  /** Retain rollback until receipt admission and the final heartbeat have succeeded. */
  onFailure(cleanup: () => Promise<void>): void;
  /** Release nested locks after all registered rollback actions, before the tracker pin. */
  onRelease(release: () => Promise<void>): void;
}

/** Attempt all nested releases in reverse acquisition order, retaining each failure. */
async function releaseAll(releases: (() => Promise<void>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const release of releases.reverse()) { try { await release(); } catch (failure) { failures.push(failure); } }
  if (failures.length > 0) throw new AggregateError(failures, 'Owned nested locks could not all be released; inspect the remaining resources.');
}

/** Serialize multi-item decisions, renew liveness, and recover killed processes safely.
 * The process pin prevents expiry during an awaited SDK mutation from admitting
 * another writer. Time expiry alone never steals that pin from a live process.
 */
export async function withSwarmLease<T>(pmRoot: string, author: string, operation: (lease: Lease) => Promise<T>, options: LeaseOptions = {}): Promise<T> {
  const leaseMs = options.leaseMs ?? 30000; const renewMs = options.renewMs ?? 5000; const waitMs = options.waitMs ?? 300000;
  const root = join(pmRoot, 'runtime/swarm'); const created = mkdirSync(root, { recursive: true }); let admitted = false;
  try {
    const path = join(root, 'operation.json'); const pin = join(root, 'operation-pin.json');
    const identity = { pid: process.pid, process_start: processStart(process.pid), locality: leaseLocality() }; const token = randomUUID(); const started = Date.now();
    const candidate = join(root, `request-${String(started).padStart(16, '0')}-${token}.json`);
    let timer: ReturnType<typeof setInterval> | undefined; let outcome: T;
    const rollbacks: (() => Promise<void>)[] = []; const releases: (() => Promise<void>)[] = [];
    try {
    publish(candidate, { ...identity, token });
    try {
      for (;;) {
        if (readRuntime<Owner>(candidate)?.token !== token) throw new StaleFenceError('operation request');
        const name = readdirSync(root).filter(name => name.startsWith('request-') && name.endsWith('.json')).sort()[0];
        if (name === undefined) throw new StaleFenceError('operation request');
        const first = join(root, name);
        const head = readRuntime<Owner>(first);
        if (head?.token === token) {
          try { linkSync(candidate, pin); break; }
          catch (error) { if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error; }
          const owner = readRuntime<Owner>(pin);
          if (owner !== undefined && !alive(owner, identity.locality)) {
            await recoverLeasePin(pmRoot, author, identity.locality, owner);
          }
        } else if (head !== undefined && !alive(head, identity.locality)) {
          rmSync(first, { force: true });
        }
        if (Date.now() - started >= waitMs) throw new Error('swarm_busy: live or unverifiable owner holds the tracker; retry after it finishes or inspect abandoned runtime records with all writers stopped');
        await delay(50 + Math.random() * 150);
      }
    } finally { if (readRuntime<Owner>(candidate)?.token === token) unlinkSync(candidate); }
    let failure: unknown;
    /** Always validate both generations; synchronous Git work retains its live pin past expiry. */
    const generation = () => {
      const owner = readRuntime<Owner>(path);
      if (owner?.token !== token || readRuntime<Owner>(pin)?.token !== token) throw new StaleFenceError('operation');
      return owner;
    };
    const assert = () => {
      if (failure !== undefined) throw failure;
      const owner = generation();
      if (!options.allowBlocking && Date.now() - owner.heartbeat >= leaseMs) throw new StaleFenceError('operation');
    };
    /** Announce principal liveness only after a successful write or completed operation. */
    const announce = () => { touchHeartbeat(pmRoot, author); admitted = true; };
    const lease: Lease = { assert, assertOwned: generation, write: (operation, options) => retryLock(async () => { if (options?.announce === false) generation(); else assert(); const result = await operation(); if (options?.announce !== false) announce(); return result; }), onFailure: cleanup => { rollbacks.push(cleanup); }, onRelease: release => { releases.push(release); } };
      publish(path, { ...identity, token, heartbeat: Date.now() });
      timer = setInterval(() => {
        try { assert(); publish(path, { ...identity, token, heartbeat: Date.now() }); if (admitted) announce(); }
        catch (error) { failure = error; }
      }, renewMs);
      assert(); const result = await operation(lease);
      try { assert(); }
      catch (error) {
        // Legacy coordination probes may consume a fence refusal and return no receipt.
        if (error instanceof StaleFenceError && result === undefined && rollbacks.length === 0) return result;
        throw error;
      }
      const content = options.receiptWorkspace !== undefined && typeof result === 'object' && result !== null && 'worktree' in result && typeof result.worktree === 'string'
        ? { ...result, worktree: relative(options.receiptWorkspace, result.worktree) } : result;
      outcome = commitMutation(content, () => { announce(); return result; });
    } catch (error) {
      const failures: unknown[] = [];
      for (const rollback of rollbacks.reverse()) { try { await rollback(); } catch (failure) { failures.push(failure); } }
      const refusal = failures.find(failure => failure instanceof SettingsRefusal || failure instanceof StaleFenceError);
      if (refusal !== undefined) throw refusal;
      if (failures.length > 0) throw new AggregateError([error, ...failures], 'Operation failed and owned rollback could not be completed; preserve peer state and inspect the remaining resources.');
      throw error;
    }
    finally {
      clearInterval(timer);
      try { await releaseAll(releases); } finally {
      try { if (readRuntime<Owner>(candidate)?.token === token) unlinkSync(candidate); }
      finally {
        try { if (readRuntime<Owner>(path)?.token === token) unlinkSync(path); }
        finally { if (readRuntime<Owner>(pin)?.token === token) unlinkSync(pin); }
      }
      }
    }
    return outcome;
  } finally { if (!admitted) removeEmptyRuntime(root, created); }
}
