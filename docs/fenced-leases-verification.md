# Fenced shared-tracker leases

Tracked in [pm-swarm-shared-tracker](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-shared-tracker.toon). The package remains unreleased.

Selection, shared sync, close, handoff and reclaim serialize through an atomic process pin in the tracker's ignored runtime directory. Immutable requests enter an arrival-ordered queue; staged records are excluded and dead tickets are recovered. Only its head attempts to publish a process pin with a hard link; fifty contenders do not cycle through SDK lock creation on the admission path. The renewable operation record has a 30-second expiry and a five-second renewal interval. The live pin spans awaited SDK mutations. An expired living operation cannot be replaced while it is inside a write; a resumed stale operation refuses its next write. Killed processes are recovered under a separate SDK recovery lock after checking the exact pin generation. Linux start identity detects PID reuse; other platforms preserve ambiguous live pins conservatively. The local filesystem must support atomic hard links and rename. Hosted and cross-host filesystems are outside this acceptance proof.

Shared claims atomically persist assignee, decimal fencing token and claim timestamp. Shared writers verify principal and token under the same pin, before dispatching SDK mutations. Handoff and reclaim update ownership, generation, receiver packet and comment in one item mutation. The receiver's next operation returns its pending packet before selecting new work. A fresh transfer grants a heartbeat interval even when its recipient's old runtime heartbeat is stale. Reclaim returns stale nonterminal items to the configured open status, or assigns them to a specified receiver. Close finishes and releases a fenced claim in one mutation. Core pm writers and optional Git lane ownership retain their SDK contracts and do not consume shared fencing tokens.

Only typed pre-write SDK `lock_conflict` refusals are retried, with exponential jitter whose base delay caps at one second and a five-minute total budget. Other failures propagate. Exhausted contention is an explicit failure. An initial fifty-worker experiment using an SDK admission lock stalled under cleanup-gate contention; that attempt failed and is not counted as acceptance. The final process-pin design removes that hot path.

## Regressions

Tests use real SDK trackers outside Git and a Git-free CLI PATH. They cover expired-start history preservation, renewal beyond lease duration, stale and missing token refusal, same-author ABA, one-transaction handoff with bounded context, pool and targeted reclaim, legacy SDK claim recovery, typed CLI error transport, actual SDK lock contention, and killed lease-holder recovery. No SDK responses are mocked.

`npm run test:scale` builds and packs the package, installs it with the real pinned host into one non-Git tracker, and launches fifty process agents. Each agent invokes real CLI next/heartbeat/sync/close commands. After all fifty hold distinct claims and complete an agent heartbeat, thirteen are killed with SIGKILL before sync. The thirty-seven survivors run two full cycles. Reclaim must recover exactly those thirteen items, then thirteen recovery agents finish them. All eighty-seven item histories, explicit file markers and close reasons are checked, followed by full `pm health --strict-exit` with the managed extension active. Git is absent from PATH during the entire agent loop. Thirteen of fifty is 26 percent, the nearest whole-worker quarter rounded up.

The following receipts distinguish the scale proof from full package gates. This proof concerns one local shared directory, not hosted Postgres/MCP, authenticated principals, arbitrary core SDK writers or visitor workloads.


## Process proof

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

The final registered PM fencing suite passes 11/11 with zero failures, skips or cancellations, including parent scoping and mismatched stored context. Its runner elapsed 104,373 ms. The earlier focused coverage run measured all four lease-module dimensions at 100 percent. Packed non-Git Node and native Bun acceptance passes with Git absent from PATH.


## Package gates

The application source is unchanged since the process proof. The final test corrections are in `cdb895e`. Dependency pins, measured source scope, exclusions and thresholds are unchanged.

| Command and execution | Behavioral suite | Packed acceptance | Statements / branches / functions / lines |
| --- | --- | --- | --- |
| `npm run release:check`, local Node 24.19.0 with isolated HOME and Git configuration | 166/166 | 3/3 | 100 / 100 / 100 / 100 percent |
| `bun run release:check`, Node 26 CI at `cdb895e` | 166/166 | 3/3 | 100 / 100 / 100 / 100 percent |

All 25 authored source files are measured. Local npm totals are 1,809/1,809 statements and lines, 112/112 functions and 978/978 branches. Production audit reports zero vulnerabilities; identity, typecheck, lint, zero duplication, docstrings, package contents, generated changelog and release attestation pass. Both full suites have zero failures, skips or cancellations. The [completed CI job](https://github.com/unbraind/pm-swarm/actions/runs/39630570800/job/119327404201) contains the complete Bun command and receipts; Node 22 CI also passes. The redundant local Bun repetition was stopped after verifying this completed same-head CI receipt and is excluded from acceptance evidence.

The local packed Git npm/native Bun test passed in 599,323 ms against its existing 600,000 ms deadline; the non-Git packed test passed in 231,514 ms. [pm-swarm-packed-latency](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/chores/pm-swarm-packed-latency.toon) tracks investigation of resource sensitivity. This passing near-deadline observation is separate from the existing Bun-cache cleanup follow-up. No deadline or coverage threshold was raised.

Automated review supplies no approval receipt: CodeRabbit skips automatic reviews by repository policy, Sourcery is quota-limited, and Cubic reports neutral. Published inline review comments are absent. These statuses are not approval. The pull request remains unmerged, auto-merge is disabled, and no release or tag was created.

## Review round on 6c0c050

All four unresolved threads and all comments were fetched with complete pagination. The latest CodeRabbit review has no separate Outside diff range findings; its history-count nitpick is included below. Origin main is already an ancestor. Review threads remain untouched.

| Thread | Disposition |
| --- | --- |
| PRRT_kwDOVLY-P86u3W9K | Refused as unreachable with the pinned SDK: both handoff, through `fence`, and reclaim fetch `client.get(id, { depth: 'full' })` before calling `transfer`. In the pinned SDK's `sdk/query/get.js`, full normalizes to deep and `projectItemForDepth` supplies `comments: item.comments ?? []`. Reclaim does not pass a corpus row into transfer. Two real non-Git tracker tests verify that canonical legacy records omit comments, full SDK reads return an empty array, and both unchanged transfer paths succeed in one history transaction. |
| PRRT_kwDOVLY-P86u3W9b | Reclaim parses claim and runtime timestamps independently, uses the newest finite result, and preserves claims with no usable evidence. Its `refused` result identifies those items and gives repair guidance. Tests cover fresh and stale runtime evidence with malformed claim timestamps, malformed or absent runtime evidence, both timestamp orderings, CLI reporting and unchanged histories for preserved claims. |
| PRRT_kwDOVLY-P86u3W9i | A shared scale worker monitor rejects readiness and completion on process errors, explicit worker failures and unexpected exits. An explicit kill method requires readiness before allowing SIGKILL. Tests launch real processes for pre-readiness nonzero and clean exits, post-readiness failure, spawn failure, reported failure, completion before the barrier, normal completion and intentional SIGKILL. |
| PRRT_kwDOVLY-P86u3W9p | The scale history verifier now asserts the task count plus the project history. A real non-Git tracker test removes one disposable history and verifies refusal, alongside the positive count check. |

Whole-PR same-class review inspected optional collections, timestamp arithmetic, all worker exit/readiness barriers and retained-history checks. Shared status also used malformed claim timestamps in arithmetic; it now returns null age instead of NaN. Its regression exercises the embedded result directly. Other command helpers await process closure or use bounded output loops without an unresolved readiness barrier. Dependency pins, coverage inventory, exclusions, thresholds and existing deadlines remain unchanged. Dist is ignored and regenerated by release gates.

The corrected focused command, `node --test test/review-r4.test.ts`, passes 13/13. The registered PM runner also passes all thirteen tests. No SDK response is mocked. Independent copies retain the final tests and pinned dependencies; source imports require no dist rebuild.

| Behavior removed independently | Exact regression command |
| --- | --- |
| Only the previous `SharedTracker.reclaim` method | `node --test --test-name-pattern="reclaim selects the newest" test/review-r4.test.ts` |
| Only the previous `SharedTracker.status` method | `node --test --test-name-pattern="status reports an unknown" test/review-r4.test.ts` |
| Unexpected-exit settlement inside `monitorScaleWorker` | `node --test --test-name-pattern="scale worker settles barriers on early failure\|scale worker settles barriers on early clean exit\|scale worker settles barriers on after ready" test/review-r4.test.ts` |
| Process-error barrier settlement inside `monitorScaleWorker` | `node --test --test-name-pattern="scale worker settles barriers on spawn error" test/review-r4.test.ts` |
| History-count assertion inside `verifyScaleHistories` | `node --test --test-name-pattern="scale history proof" test/review-r4.test.ts` |

The lifecycle regressions require each barrier's rejection before the process-exit receipt can win, so a reverted barrier fails by assertion instead of waiting for a test deadline. Full release and scale receipts for this round are recorded after completion below.

All five final mutations exit 1 by assertion, with zero cancellations: reclaim 0/1, status 0/1, unexpected worker exits 0/3, spawn error 0/1, and missing history 0/1. The corrected suite passes 13/13. Earlier lifecycle proof experiments reproduced pending-promise cancellations; the final assertions above replace those deadline-dependent proofs.

A later complete count-loop scan found the same missing-count assertion in the older eight-process acceptance test. It now uses the same checked history verifier, requiring nine histories. The existing disposable-history negative regression and count-assertion revert proof cover that shared verifier. Earlier CI receipts on `1b35d9e` predate this test-only call-site correction; final CI must validate it too. Application source and packed package inputs are unchanged.
