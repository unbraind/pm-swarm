# Resource reservations

The resource model builds on PR #12 and must merge after it. A resource is one
canonical active tracker item tagged `swarm-resource`. Use its ID everywhere that
physical slot is shared. This is explicit coordination alongside work claims;
resources have no file footprint or Git lane.

```ts
import { PmClient } from '@unbrained/pm-cli/sdk';
import { Swarm, ResourceReservations, trackerResourceBackend } from 'pm-swarm';

const client = new PmClient({ cwd: workspace, pmRoot, author: 'worker' });
const engine = new Swarm(workspace, pmRoot, client, 'worker');
const resources = new ResourceReservations(trackerResourceBackend(engine), 'worker');
const lease = await resources.reserve(resourceId, 300);
try {
  // Run checks using the reserved slot. Renew before expiry during long work.
  await resources.renew(resourceId, lease.token, 600);
  await resources.publish(resourceId, lease.token, 'Checks passed; artifact digest recorded');
} finally {
  // A lost or expired lease refuses cleanup too; never force the old token.
  await resources.release(resourceId, lease.token);
}
```

`ResourceBackend` contains `read` and `transact`. A provider owns a single tracker
namespace for both work claims and resources. `transact` takes a fresh snapshot
under that tracker's renewable fenced operation lease, calls the synchronous
decision function, and commits owner, generation, expiry and optional note
atomically. Keep the operation writer pin until the commit completes, recheck the
operation fence at each write/retry, and propagate refusal. Do not coordinate
hosted data through a local tracker, or fall back after a backend failure.

The filesystem adapter uses #12's exact operation lease and SDK atomic update;
it requires a shared local filesystem with atomic hard links and rename. It
conservatively refuses service-capable extensions rather than guessing where
they persist data. The SDK model contains no filesystem or Git dependency.
Hosted adapters must implement this contract explicitly and have their own
acceptance evidence; none is implicitly selected by the CLI.

The resource fence lives in `swarm_token`; owner lives in native `assignee` and
expiry in `swarm_resource_expires_at`. Reserve and release advance the decimal
generation. Renew and publish require matching principal and token plus a future
expiry. A reservation that expires during an already admitted SDK commit retains
the operation pin until commit finishes; a successor cannot acquire until that
write completes. Publication is a tracker receipt; external sinks need their own
fence checks. Core PM mutations and deletion/recreation bypass this cooperative
protocol. Do not use them to change resource ownership.

No multi-resource atomic acquisition or automatic item-to-resource dependency
scheduler is provided. Acquire multiple resource IDs in a consistent sorted
order and release any partial acquisition on refusal.

`node --test test/resources.test.ts` uses real non-Git SDK trackers and a Git-free
CLI PATH, including three concurrent processes. For corpus validation, point
`PUBLIC_TRACKER_REPO` at a checkout of the public `unbraind/pm-ops` repository and
run `node --test test/resource-corpus.acceptance.ts`. It extracts only the
committed public tracker from `origin/main` into a non-Git temporary directory,
makes every baseline file read-only, mutates only newly created synthetic
resource records, and checks every baseline digest afterwards. Source checkout
and tracker bytes are never modified. See the verification receipt for measured
counts, revert evidence and CI gate provenance.
