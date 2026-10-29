import { commitMutation, assertPrivatePathSafe } from './settings.ts';
import { resolveClaimPrincipal } from '@unbrained/pm-cli/sdk';

/** Explicit opt-in prevents ordinary work from becoming a resource accidentally. */
export const RESOURCE_TAG = 'swarm-resource';

/** Stable refusals shared by SDK callers and native CLI diagnostics. */
export type ResourceRefusalCode = 'resource_invalid' | 'resource_busy' | 'resource_stale_fence' | 'resource_backend_refused';

/** A resource refusal always supplies a concrete recovery action. */
export class ResourceRefusal extends Error {
  /** Stable machine-readable refusal category. */
  readonly code: ResourceRefusalCode;
  /** Concrete action needed before the refused operation can succeed. */
  readonly remedy: string;
  /** Preserve a bounded diagnostic without exposing backend storage coordinates. */
  constructor(code: ResourceRefusalCode, remedy: string) {
    super(`${code}: ${remedy}`); this.name = 'ResourceRefusal'; this.code = code; this.remedy = remedy;
  }
}

/** Refuse absent or noncanonical resource tokens before acquiring a backend lease. */
export function validateResourceToken(token: unknown): asserts token is string {
  if (typeof token !== 'string' || !/^(0|[1-9][0-9]*)$/.test(token)) throw new ResourceRefusal('resource_stale_fence', 'Supply the decimal --token returned by reserve; discard an invalid token and reserve again.');
}
/** Preserve the native reservation adapter's default generation for legacy optional fields. */
export function resourceGeneration(value: unknown): string { return String(value ?? '0'); }

/** Portable snapshot of an explicit resource item on the selected tracker. */
export interface ResourceRecord {
  id: string;
  resource: boolean;
  token: string;
  owner: string | null;
  expires_at: string | null;
}

/** Single atomic ownership change and optional bounded publication receipt. */
export interface ResourceChange extends ResourceRecord {
  note?: string;
}

/** Backend contract: serialize with item claims on the SAME tracker, never a local shadow.
 * Invoke decide on a fresh record under a renewable fenced operation lease, then
 * persist the change and note atomically. Keep the writer pin through commit;
 * recheck operation ownership before each retry. Refusals must propagate.
 */
export interface ResourceBackend {
  read(id: string): Promise<ResourceRecord>;
  transact(id: string, author: string, decide: (record: ResourceRecord) => ResourceChange): Promise<ResourceRecord>;
}

/** Agent-sized receipt; no corpus, history, storage location or publication body. */
export interface ResourceReceipt extends ResourceRecord {
  held: boolean;
}

/** Coordinate exclusive non-file resources independently of Git or storage technology. */
export class ResourceReservations {
  /** Sole authority for reads and fenced mutations. */
  readonly backend: ResourceBackend;
  /** Canonical claim principal bound to this worker. */
  readonly author: string;
  /** Use exactly the supplied tracker backend; there is no fallback backend. */
  constructor(backend: ResourceBackend, author: string) { this.backend = backend; this.author = resolveClaimPrincipal(author); }

  /** Validate durable state before comparing tokens or admitting a successor. */
  private validate(record: ResourceRecord): ResourceRecord {
    if (!record.resource || !/^(0|[1-9][0-9]*)$/.test(record.token) || (record.owner === null ? record.expires_at !== null : record.expires_at === null || !Number.isFinite(Date.parse(record.expires_at)))) {
      throw new ResourceRefusal('resource_invalid', 'Use an active item tagged swarm-resource with intact token, owner and expiry fields; inspect its history before repairing state.');
    }
    assertPrivatePathSafe(record);
    return record;
  }

  /** Bound reservation lifetimes and reject nonintegral, infinite or empty durations. */
  private duration(seconds: number): number {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) throw new ResourceRefusal('resource_invalid', 'Set --ttl to integer seconds from 1 through 86400.');
    return seconds * 1000;
  }

  /** Check both principal and generation; expiry invalidates even the current owner. */
  private fence(record: ResourceRecord, token: string): void {
    this.validate(record);
    if (record.owner !== this.author || record.token !== token || record.expires_at === null || Date.parse(record.expires_at) <= Date.now()) {
      throw new ResourceRefusal('resource_stale_fence', 'Discard the old token and uncommitted result; reserve again and recompute before publishing.');
    }
  }

  /** Project current ownership without returning unbounded item context. */
  private receipt(record: ResourceRecord): ResourceReceipt {
    return { ...record, held: record.owner !== null && Date.parse(record.expires_at!) > Date.now() };
  }

  /** Admit backend arguments and the freshly decided change inside the backend's own transaction. */
  private transact(id: string, decide: (record: ResourceRecord) => ResourceChange): Promise<ResourceRecord> {
    return commitMutation({ id, author: this.author }, admitted => this.backend.transact(admitted.id, admitted.author, record => commitMutation(decide(record), change => change)));
  }

  /** Read one resource without taking a writer lease or invoking Git. */
  async status(id: string): Promise<ResourceReceipt> { return this.receipt(this.validate(await this.backend.read(id))); }

  /** Reserve an available resource with a strictly increasing durable generation. */
  async reserve(id: string, seconds = 300): Promise<ResourceReceipt> {
    assertPrivatePathSafe(id); assertPrivatePathSafe(this.author);
    const duration = this.duration(seconds);
    return this.receipt(await this.transact(id, record => {
      this.validate(record);
      if (record.owner !== null && Date.parse(record.expires_at!) > Date.now()) throw new ResourceRefusal('resource_busy', 'Inspect resource status; wait for expiry or ask the current owner to release. Use renew with its token to extend your own reservation.');
      return { ...record, owner: this.author, token: (BigInt(record.token) + 1n).toString(), expires_at: new Date(Date.now() + duration).toISOString() };
    }));
  }

  /** Extend a still-live reservation; a stale worker cannot resurrect an expired lease. */
  async renew(id: string, token: string, seconds = 300): Promise<ResourceReceipt> {
    assertPrivatePathSafe({ id, token }); assertPrivatePathSafe(this.author);
    const duration = this.duration(seconds);
    validateResourceToken(token);
    return this.receipt(await this.transact(id, record => {
      this.fence(record, token); return { ...record, expires_at: new Date(Date.now() + duration).toISOString() };
    }));
  }

  /** Release and invalidate the generation without deleting its durable history. */
  async release(id: string, token: string): Promise<ResourceReceipt> {
    assertPrivatePathSafe({ id, token }); assertPrivatePathSafe(this.author);
    validateResourceToken(token);
    return this.receipt(await this.transact(id, record => {
      this.fence(record, token); return { ...record, token: (BigInt(record.token) + 1n).toString(), owner: null, expires_at: null };
    }));
  }

  /** Publish a bounded tracker receipt only while the reservation is still owned. */
  async publish(id: string, token: string, note: string): Promise<ResourceReceipt> {
    assertPrivatePathSafe({ id, token, note }); assertPrivatePathSafe(this.author);
    if (!note.trim() || note.length > 4096) throw new ResourceRefusal('resource_invalid', 'Supply a nonempty --note of at most 4096 characters.');
    validateResourceToken(token);
    return this.receipt(await this.transact(id, record => {
      this.fence(record, token); return { ...record, note };
    }));
  }
}
