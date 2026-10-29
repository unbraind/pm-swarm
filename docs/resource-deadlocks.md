# Resource deadlock witnesses

A pending request describes what a worker still needs while holding a reserved
resource. It does not acquire those resources, queue a reservation or change
claims. The held resource is the request's **anchor**: its owner, fencing token,
active status and expiry determine whether the request participates. Any release,
expiry or successor generation makes the old request ineligible.

```sh
# Assume resource-a and resource-b are active items tagged swarm-resource.
pm swarm resource resource-a --action reserve --agent alpha
pm swarm resource resource-b --action reserve --agent beta
pm swarm deadlocks resource-a --json
# Copy revision from the inspection above; the initial reservation token is 1.
pm swarm deadlocks resource-a --action request --agent alpha --token 1 \
  --resources resource-b --revision '<inspection revision>'
# Review the preview, then repeat with --apply and the same revision.
pm swarm deadlocks resource-a --action request --agent alpha --token 1 \
  --resources resource-b --revision '<inspection revision>' --apply
# Inspect resource-b, then declare its wait for resource-a as beta.
pm swarm deadlocks resource-b --action request --agent beta --token 1 \
  --resources resource-a --revision '<resource-b inspection revision>' --apply
pm swarm deadlocks --json
```

The result has two exact edges: alpha waits for beta on resource-b, and beta waits
for alpha on resource-a. `cycles` is `[["alpha","beta"]]`. These are the SDK
`collectOrderingCycles` strongly connected components, sorted by the SDK; for a
larger component the members are **not** an ordered simple path. Each edge carries
both the anchor generation and the requested resource generation. `alternatives`
lists resources, owners and current tokens for manual review. An owner can choose
`pm swarm resource <resource> --action release --agent <owner> --token <token>`
after ensuring that its work can stop. This removes a wait edge, and may leave
other cycles; rerun detection after every decision. Detection revokes nothing.

Withdraw a request with `--action request --clear`, the current anchor token and a
fresh `--revision`, adding `--apply` after review. This retains the reservation.
Every declaration, including retry or replay, checks the current native history
revision. Identical input at a stale revision refuses; identical input at the
current revision returns `changed: false` without another history event.

## SDK

```ts
import { ResourceDeadlocks, Swarm } from 'pm-swarm';
// client is the host-injected PmClient with pm-swarm activated.
const witnesses = new ResourceDeadlocks(new Swarm(workspace, pmRoot, client, 'alpha'));
const { revision } = await witnesses.inspect('resource-a');
const input = { version: 1, token: '1', resources: ['resource-b'] } as const;
const preview = await witnesses.request('resource-a', { ...input, resources: [...input.resources] }, revision);
const applied = await witnesses.request('resource-a', { ...input, resources: [...input.resources] }, revision, true);
const report = await witnesses.detect(10);
```

The sole request schema admits version 1, a decimal generation of at most 80
digits and a dense array of up to 16 distinct canonical resource ids (160
characters; letters, digits, dots, underscores and hyphens). Surrounding whitespace
is normalized by the same schema for producers, validators and stored records.
Unknown fields, sparse arrays and unusable values refuse before writes. Empty
arrays withdraw waits. Foreign or damaged stored request records are skipped with
a reason, individually; inspection never emits their raw payload.

## Limits, concurrency and storage

Detection reads through the SDK mutation guard, without Git, usage bookkeeping,
graph writes, reservation changes or history changes. The SDK may populate ignored
derived metadata caches on a cold writable tracker; cache persistence is best
effort and detection also works with the entire tracker read-only. It supports at most 128 resources
and 512 projected edges. Larger topology yields `deadlock_limit` with a remedy,
rather than an incomplete negative result. Each returned collection has a default
10-row limit, configurable from 1 through 50. `requests` counts live, nonempty declarations. `truncated` announces omitted rows;
a cycle can involve edges omitted from the compact edge collection. All counts
are bounded integers. No import/export/sync format or replay journal is added;
request persistence and read-back use native SDK item fields and history.

Two reads detect resource changes during observation. The result is an
observation, not permission to publish or release: ownership may change immediately
after the last read. Declarations serialize with other swarm operations, compare
the full anchor document and append-only history head inside the SDK's native item
write hook, and re-read every dependent resource's history and anchor expiry just
before writing. Ordinary writers do not honor `commitWorkspaceTransaction`'s
workspace lock (pm-cli#1620). Related resources can still change after that final
check; a request is only intent and every detection reprojects current holders.
There is no claim of multi-item transaction isolation. No recovery path blindly
replays a saved plan and no automatic compensation deletes or releases resources.

This adapter supports filesystem trackers with native history, including plain
non-git directories. It refuses service-backed storage with `deadlock_backend`
instead of projecting a local shadow. `deadlock_stale` requires fresh inspection
and a reconsidered declaration; `deadlock_invalid` identifies the supported input;
`deadlock_limit` requires partitioning coordination. Native admission refusals
retain their typed `swarm_superseded`/`swarm_document_changed` remedies.
