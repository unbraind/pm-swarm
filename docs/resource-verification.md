# Resource reservation verification

Tracked in [pm-swarm-resource-reservations](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-resource-reservations.toon).
This feature builds on PR #12 and must merge after it. No release is performed.

## Public corpus

`PUBLIC_TRACKER_REPO` selected a read-only checkout of public `unbraind/pm-ops`.
`node --test test/resource-corpus.acceptance.ts` extracted its committed tracker
at `eba7d5262fd75e67afce0caad29dae7dc7dfbaeb` into a non-Git temporary directory.
All baseline files were made read-only before the SDK read. The feature exercised
only one newly created synthetic resource. The original checkout was never
modified. The native CLI status check ran without Git in PATH.

| Measured observation | Result |
| --- | ---: |
| Certified public corpus items | 146 |
| Baseline files / bytes | 300 / 3,689,055 |
| Baseline SHA-256 digests changed | 0 |
| Synthetic resource records | 1 |
| Successful resource mutations | 7 |
| Exclusive refusal / stale publication refusal | 1 / 1 |
| Final released generation | 4 |
| Final compact JSON bytes | 89 |
| Coordination and read phase | 41,224 ms |
| Test case / total runner duration | 42,723 / 48,275 ms |
| Tests / failures / skips / cancellations | 1 / 0 / 0 / 0 |

Timing reflects the loaded development host, not a latency guarantee. Hosted
Postgres/MCP adapters, arbitrary core writers and external resource sinks are
outside this filesystem acceptance. An explicit backend must supply shared
fencing and atomic commits; refusal never chooses another backend.

## Behavioral revert proof

Each independent disposable source copy reused pinned dependencies and the final
real-tracker regressions. No PM SDK or tracker was mocked. Source imports need no
dist rebuild. The working implementation was never reverted.

| Behavior removed in isolation | Targeted test command | Result |
| --- | --- | --- |
| `ResourceReservations.reserve` exclusive-owner check | `node --test --test-name-pattern="resources on one non-Git tracker" test/resources.test.ts` | Exit 1; 0/1 pass, missing busy rejection |
| `ResourceReservations.fence` principal/token/expiry check | `node --test --test-name-pattern="expired resources admit" test/resources.test.ts` | Exit 1; 0/1 pass, missing stale-fence rejection |
| `trackerResourceBackend` unsupported-storage refusal | `node --test --test-name-pattern="resource backend refusal propagates" test/resources.test.ts` | Exit 1; 0/1 pass, missing backend refusal |

All three failures are assertions, with zero cancellations. Tests also check
same-author ABA, no history appended on refusal, one-update publication, renewal,
malformed state preservation, ordinary item protection, compact TOON/JSON,
Git-free commands and three real competing processes receiving one winner.

## Gate provenance

Full npm and Bun release checks are delegated to CI because the development CPU
is saturated. Thresholds and source scope are unchanged. CI receipts are recorded
after completion. Local targeted checks are recorded separately from full-gate
acceptance. An initial PM-linked aggregate suite hit its existing 120-second
limit under host contention after four passing cases; that run is failed timeout
evidence, not acceptance. No test deadline or gate threshold is increased.
