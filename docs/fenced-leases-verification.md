# Fenced shared-tracker leases

Tracked in [pm-swarm-shared-tracker](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-shared-tracker.toon). The package remains unreleased.

Selection, shared sync, close, handoff and reclaim serialize through an atomic process pin in the tracker's ignored runtime directory. Immutable requests enter an arrival-ordered queue; staged records are excluded and dead tickets are recovered. Only its head attempts to publish a process pin with a hard link; fifty contenders do not cycle through SDK lock creation on the admission path. The renewable operation record has a 30-second expiry and a five-second renewal interval. The live pin spans awaited SDK mutations. An expired living operation cannot be replaced while it is inside a write; a resumed stale operation refuses its next write. Killed processes are recovered under a separate SDK recovery lock after checking the exact pin generation. Linux start identity detects PID reuse; other platforms preserve ambiguous live pins conservatively. The local filesystem must support atomic hard links and rename. Hosted and cross-host filesystems are outside this acceptance proof.

Shared claims atomically persist assignee, decimal fencing token and claim timestamp. Shared writers verify principal and token under the same pin, before dispatching SDK mutations. Handoff and reclaim update ownership, generation, receiver packet and comment in one item mutation. The receiver's next operation returns its pending packet before selecting new work. A fresh transfer grants a heartbeat interval even when its recipient's old runtime heartbeat is stale. Reclaim returns stale nonterminal items to the configured open status, or assigns them to a specified receiver. Close finishes and releases a fenced claim in one mutation. Core pm writers and optional Git lane ownership retain their SDK contracts and do not consume shared fencing tokens.

Only typed pre-write SDK `lock_conflict` refusals are retried, with exponential jitter whose base delay caps at one second and a five-minute total budget. Other failures propagate. Exhausted contention is an explicit failure. An initial fifty-worker experiment using an SDK admission lock stalled under cleanup-gate contention; that attempt failed and is not counted as acceptance. The final process-pin design removes that hot path.

## Regressions

Tests use real SDK trackers outside Git and a Git-free CLI PATH. They cover expired-start history preservation, renewal beyond lease duration, stale and missing token refusal, same-author ABA, one-transaction handoff with bounded context, pool and targeted reclaim, legacy SDK claim recovery, typed CLI error transport, actual SDK lock contention, and killed lease-holder recovery. No SDK responses are mocked.

`npm run test:scale` builds and packs the package, installs it with the real pinned host into one non-Git tracker, and launches fifty process agents. Each agent invokes real CLI next/heartbeat/sync/close commands. After all fifty hold distinct claims and complete an agent heartbeat, thirteen are killed with SIGKILL before sync. The thirty-seven survivors run two full cycles. Reclaim must recover exactly those thirteen items, then thirteen recovery agents finish them. All eighty-seven item histories, explicit file markers and close reasons are checked, followed by full `pm health --strict-exit` with the managed extension active. Git is absent from PATH during the entire agent loop. Thirteen of fifty is 26 percent, the nearest whole-worker quarter rounded up.

The following receipts distinguish the scale proof from full package gates. This proof concerns one local shared directory, not hosted Postgres/MCP, authenticated principals, arbitrary core SDK writers or visitor workloads.


## Committed-source process proof

The application source in `2c8d8e9` passed the registered `npm run test:scale` command: one test, zero failures, skips or cancellations. Its application source remains unchanged by the subsequent CI regression and fixture cleanup corrections. Node 24.19.0, npm 11.17.0 and the pinned pm host 2026.10.17 were used; the registry reported pm CLI 2026.10.21. Dependency pins are unchanged.

| Observation | Result |
| --- | ---: |
| Concurrent initial agents / unique owners | 50 / 50 |
| SIGKILL owners / recovered items | 13 / 13 |
| Original tasks finished exactly once | 87 / 87 |
| Valid JSONL history files | 88 |
| Double ownership / lost file or close writes | 0 / 0 |
| Full managed-extension strict health | clean |

| Phase | Milliseconds |
| --- | ---: |
| Setup | 11,763 |
| Initial claims and agent heartbeats | 112,582 |
| Survivor work after the ownership barrier | 346,170 |
| Reclaim thirteen killed owners | 9,848 |
| Recovery loops and final verification after reclaim | 103,456 |
| Total application proof | 583,821 |

The PM runner reports 587,564 ms including the build and runner overhead. Timings include real CLI startup and local contention; no latency target is asserted. An earlier ordered-pin run also passed in 701,436 ms. Earlier failed or interrupted experiments are not acceptance evidence.

## Behavioral revert proof

Each isolated source copy reused the pinned SDK and real temporary trackers. Only the named function's behavior was removed; source imports require no dist rebuild. Every mutant failed its targeted test, zero of one passing, exit 1:

| Function behavior removed | Regression |
| --- | --- |
| Operation assertion in `withSwarmLease` | Expired start changes no history |
| `SharedTracker.assertFence` | Missing/stale token and same-author ABA |
| Ownership change in `SharedTracker.transfer` | Receiver gets its assigned context |
| `retryLock` retries | Actual SDK lock refusal is retried |
| Stale item recovery in `SharedTracker.reclaim` | Stale work returns to the pool |
| Ordered queue-head admission in `withSwarmLease` | Only the oldest live request attempts the pin |

The final focused fencing suite passes 10/10 with all four lease-module coverage dimensions at 100 percent. A further handoff regression verifies parent scoping and mismatched stored context; it passes independently. Packed non-Git Node and native Bun acceptance passes with Git absent from PATH. Full npm/Bun gate receipts follow once those complete.
