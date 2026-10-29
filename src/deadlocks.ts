import { AsyncLocalStorage } from 'node:async_hooks';
import { readSettings, resolveRuntimeStatusRegistry, statusIsTerminal } from '@unbrained/pm-cli/sdk';
import { collectOrderingCycles } from '@unbrained/pm-cli/sdk/graph';
import { inspectItem, inspectItems, mutationSnapshot } from './inspection.ts';
import { assertItemHistoryHead, commitItemMutation, documentFingerprint } from './settings.ts';
import { admitReceipt } from './receipts.ts';
import { withSwarmLease } from './lease.ts';
import { ResourceReservations, RESOURCE_TAG } from './resources.ts';
import { trackerResourceBackend } from './resource-tracker.ts';
import type { Swarm } from './swarm.ts';

/** Request-local diagnostic boundaries; callbacks never substitute SDK values. */
export const DEADLOCK_BOUNDARIES = ['validated', 'checked', 'committed', 'observed'] as const;
/** Trusted instrumentation remains scoped to one invocation and its actual writes. */
const OBSERVER = new AsyncLocalStorage<(boundary: typeof DEADLOCK_BOUNDARIES[number]) => void | Promise<void>>();
/** Observe interleavings without replacing native reads, mutations or graph algorithms. */
export function withDeadlockObserver<T>(observer: (boundary: typeof DEADLOCK_BOUNDARIES[number]) => void | Promise<void>, operation: () => T): T { return OBSERVER.run(observer, operation); }

/** Only this versioned extension field is written by pending-request declarations. */
export const RESOURCE_REQUEST_FIELD = 'swarm_resource_request';
/** Stable refusal categories with actionable recovery instructions. */
export type DeadlockRefusalCode = 'deadlock_invalid' | 'deadlock_stale' | 'deadlock_limit' | 'deadlock_backend';
/** A bounded diagnostic never includes raw input or tracker coordinates. */
export class DeadlockRefusal extends Error {
  /** Retain a typed code and concrete remedy for SDK and native CLI callers. */
  readonly code: DeadlockRefusalCode;
  /** Concrete next action before retrying. */
  readonly remedy: string;
  /** Construct a machine-readable refusal without echoing untrusted data. */
  constructor(code: DeadlockRefusalCode, remedy: string) { super(`${code}: ${remedy}`); this.name = 'DeadlockRefusal'; this.code = code; this.remedy = remedy; }
}
/** An empty resource list explicitly withdraws a request without releasing anything. */
export interface ResourceRequest { version: 1; token: string; resources: string[] }
/** One observed wait from a live requester generation to a live holder generation. */
export interface ResourceWait { requester: string; holder: string; anchor: string; anchor_token: string; resource: string; token: string }
/** SDK strongly connected components, exact wait edges and manual release alternatives. */
export interface DeadlockReport {
  resources: number; requests: number; edge_count: number; cycle_count: number; alternative_count: number; skipped_count: number; edges: ResourceWait[]; cycles: string[][];
  alternatives: { resource: string; owner: string; token: string }[];
  skipped: { id: string; reason: string }[]; truncated: boolean; read_only: true;
}

/** Apply one strict schema to declarations, stored envelopes and producer read-back. */
export function parseResourceRequest(input: unknown): ResourceRequest {
  const invalid = () => new DeadlockRefusal('deadlock_invalid', 'Supply version 1, a decimal fencing token and a dense array of at most 16 distinct resource ids (160 characters each).');
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw invalid();
  const record = input as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'resources,token,version' || record.version !== 1 || typeof record.token !== 'string' || record.token.length > 96 || !/^(0|[1-9][0-9]{0,79})$/.test(record.token.trim()) || !Array.isArray(record.resources) || record.resources.length > 16) throw invalid();
  const resources: string[] = [];
  for (let index = 0; index < record.resources.length; index++) {
    const id: unknown = record.resources[index];
    if (!Object.hasOwn(record.resources, index) || typeof id !== 'string' || id.length > 256 || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(id.trim())) throw invalid();
    resources.push(id.trim());
  }
  if (new Set(resources).size !== resources.length) throw invalid();
  return { version: 1, token: record.token.trim(), resources: resources.sort() };
}

/** Decode bounded stored input using the declaration schema; foreign records stay isolated. */
function storedRequest(value: unknown): ResourceRequest | null {
  try {
    if (typeof value !== 'string' || value.length > 4096) return null;
    return parseResourceRequest(JSON.parse(value));
  } catch { return null; }
}

/** Current observations only; no cache, journal, graph persistence or automatic release. */
export class ResourceDeadlocks {
  /** Bind the exact host-injected SDK client and the existing reservation adapter. */
  readonly engine: Swarm;
  /** Retain the host SDK without acquiring it through executable or package paths. */
  constructor(engine: Swarm) { this.engine = engine; }

  /** Read local authority through the SDK guard; never fall back from a service backend. */
  private async local(id: string): Promise<Record<string, unknown>> {
    const value = await inspectItem(this.engine.pmRoot, this.engine.repo, id);
    if (value === null) throw new DeadlockRefusal('deadlock_backend', 'Use a filesystem tracker with native history; service storage needs a tracker-wide revision-aware request adapter.');
    return { ...value.item, body: value.body };
  }

  /** Return a revision for an explicit subsequent declaration, without changing history. */
  async inspect(id: string) {
    const item = await this.local(id);
    const snapshot = await mutationSnapshot(this.engine.pmRoot, String(item.id), () => this.local(String(item.id)));
    const revision = `${snapshot.historyHead.length}:${snapshot.historyHead.hash}`;
    return admitReceipt({ id: String(item.id), revision, request: storedRequest(snapshot.item[RESOURCE_REQUEST_FIELD]) });
  }

  /** Preview and apply share all validation; each retry must supply the current target revision. */
  async request(id: string, input: unknown, revision: string, apply = false) {
    const request = parseResourceRequest(input);
    if (typeof apply !== 'boolean') throw new DeadlockRefusal('deadlock_invalid', 'Supply apply as a boolean; omit it to preview.');
    if (typeof revision !== 'string' || !/^[1-9][0-9]{0,14}:[a-f0-9]{64}$/.test(revision)) throw new DeadlockRefusal('deadlock_invalid', 'Inspect the anchor and supply its complete revision; refresh after any peer edit or replay.');
    const decide = async () => {
      const identity = await this.local(id);
      const snapshot = await mutationSnapshot(this.engine.pmRoot, String(identity.id), () => this.local(String(identity.id)));
      if (`${snapshot.historyHead.length}:${snapshot.historyHead.hash}` !== revision) throw new DeadlockRefusal('deadlock_stale', 'The anchor revision advanced; inspect current ownership and request state, then explicitly reconsider the declaration.');
      const reservations = new ResourceReservations(trackerResourceBackend(this.engine), this.engine.author);
      const anchor = await reservations.status(String(identity.id));
      if (!anchor.held || anchor.owner !== this.engine.author || anchor.token !== request.token) throw new DeadlockRefusal('deadlock_stale', 'Reserve the anchor as this agent and use its current live token; old generations cannot declare waits.');
      const targets = new Map<string, Awaited<ReturnType<typeof mutationSnapshot<Record<string, unknown>>>>>();
      for (const target of request.resources) {
        const targetItem = await this.local(target);
        const canonical = String(targetItem.id);
        const paired = await mutationSnapshot(this.engine.pmRoot, canonical, () => this.local(canonical));
        await reservations.status(canonical);
        if (canonical !== target || canonical === anchor.id) throw new DeadlockRefusal('deadlock_invalid', 'Use distinct canonical resource ids other than the anchor.');
        targets.set(canonical, paired);
      }
      const value = JSON.stringify(request);
      const receipt = admitReceipt({ id: anchor.id, revision, request, changed: JSON.stringify(storedRequest(snapshot.item[RESOURCE_REQUEST_FIELD])) !== value, applied: apply });
      /** Recheck all decision heads and expiry immediately before the native target write. */
      const revalidate = async () => {
        await assertItemHistoryHead(this.engine.pmRoot, anchor.id, snapshot.historyHead);
        for (const [target, paired] of targets) await assertItemHistoryHead(this.engine.pmRoot, target, paired.historyHead);
        await OBSERVER.getStore()?.('checked');
        const fresh = await reservations.status(anchor.id);
        if (!fresh.held || fresh.token !== request.token || fresh.owner !== this.engine.author) throw new DeadlockRefusal('deadlock_stale', 'The anchor expired or changed; reserve again and reconsider its pending resources.');
      };
      await OBSERVER.getStore()?.('validated');
      await revalidate();
      if (apply && receipt.changed) {
        await commitItemMutation({ id: anchor.id, item: snapshot.item, options: { author: this.engine.author, field: [`${RESOURCE_REQUEST_FIELD}=${value}`] } }, admitted => this.engine.client.update(admitted.id, admitted.options), { history: snapshot.historyHead, generation: { token: request.token }, beforeWrite: revalidate });
        await OBSERVER.getStore()?.('committed');
        const written = await this.local(anchor.id);
        if (written[RESOURCE_REQUEST_FIELD] !== value) throw new DeadlockRefusal('deadlock_stale', 'A peer superseded the declaration; inspect current request state before retrying.');
        parseResourceRequest(JSON.parse(String(written[RESOURCE_REQUEST_FIELD])));
      }
      return receipt;
    };
    return apply ? withSwarmLease(this.engine.pmRoot, this.engine.author, lease => lease.write(decide)) : decide();
  }

  /** Project all bounded live waits; SDK components retain their documented SCC semantics. */
  async detect(limit = 10): Promise<DeadlockReport> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new DeadlockRefusal('deadlock_invalid', 'Set limit to an integer from 1 through 50.');
    const items = await inspectItems(this.engine.pmRoot, this.engine.repo);
    if (items === null) throw new DeadlockRefusal('deadlock_backend', 'Select a filesystem tracker; do not project remote leases from a local shadow.');
    const resources = items.filter(item => (item.tags as string[]).includes(RESOURCE_TAG));
    if (resources.length > 128) throw new DeadlockRefusal('deadlock_limit', 'This witness supports at most 128 resources; partition resource coordination into smaller trackers.');
    const registry = resolveRuntimeStatusRegistry((await readSettings(this.engine.pmRoot)).schema);
    const now = Date.now();
    const live = new Map<string, Record<string, unknown>>();
    const skipped: DeadlockReport['skipped'] = [];
    for (const item of resources) {
      if (statusIsTerminal(String(item.status), registry) || typeof item.assignee !== 'string' || !item.assignee.trim() || typeof item.swarm_token !== 'string' || !/^(0|[1-9][0-9]{0,79})$/.test(item.swarm_token) || typeof item.swarm_resource_expires_at !== 'string' || !(Date.parse(item.swarm_resource_expires_at) > now)) {
        skipped.push({ id: String(item.id), reason: 'inactive_or_expired' }); continue;
      }
      live.set(String(item.id), item);
    }
    const edges: ResourceWait[] = []; let requests = 0;
    for (const [id, item] of live) {
      if (item[RESOURCE_REQUEST_FIELD] === undefined) continue;
      const request = storedRequest(item[RESOURCE_REQUEST_FIELD]);
      if (request === null) { skipped.push({ id, reason: 'invalid_or_foreign_request' }); continue; }
      if (request.token !== item.swarm_token) { skipped.push({ id, reason: 'stale_request_generation' }); continue; }
      if (request.resources.length === 0) continue;
      requests++;
      for (const target of request.resources) {
        const holder = live.get(target);
        if (holder === undefined) { skipped.push({ id: target, reason: 'no_live_holder' }); continue; }
        if (holder.assignee === item.assignee) continue;
        edges.push({ requester: String(item.assignee), holder: String(holder.assignee), anchor: id, anchor_token: request.token, resource: target, token: String(holder.swarm_token) });
      }
    }
    // Bound topology before invoking the SDK; never silently analyze a partial graph.
    if (edges.length > 512) throw new DeadlockRefusal('deadlock_limit', 'This witness supports at most 512 wait edges; withdraw surplus declarations or partition coordination.');
    const successors = new Map<string, string[]>();
    for (const edge of edges) successors.set(edge.requester, [...new Set([...(successors.get(edge.requester) ?? []), edge.holder])].sort());
    const cycles = collectOrderingCycles(successors);
    const cyclicEdges = edges.filter(edge => cycles.some(cycle => cycle.includes(edge.requester) && cycle.includes(edge.holder)));
    const alternatives = [...new Map(cyclicEdges.map(edge => [edge.resource, { resource: edge.resource, owner: edge.holder, token: edge.token }])).values()];
    await OBSERVER.getStore()?.('observed');
    const fresh = await inspectItems(this.engine.pmRoot, this.engine.repo);
    if (fresh === null || documentFingerprint({ resources: fresh.filter(item => (item.tags as string[]).includes(RESOURCE_TAG)) }) !== documentFingerprint({ resources }) || [...live.values()].some(item => Date.parse(String(item.swarm_resource_expires_at)) <= Date.now())) throw new DeadlockRefusal('deadlock_stale', 'Resource state changed during observation; rerun detection on current generations.');
    return admitReceipt({ resources: resources.length, requests, edge_count: edges.length, cycle_count: cycles.length, alternative_count: alternatives.length, skipped_count: skipped.length, edges: edges.slice(0, limit), cycles: cycles.slice(0, limit), alternatives: alternatives.slice(0, limit), skipped: skipped.slice(0, limit), truncated: [edges, cycles, alternatives, skipped].some(rows => rows.length > limit), read_only: true });
  }
}
