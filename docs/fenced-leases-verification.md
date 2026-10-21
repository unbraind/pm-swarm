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

### Review-round release receipts

Application source and package inputs remain those of `1b35d9e`. The final test-only history-verifier caller is in `a7a6ff0`; [CI run 39647105771](https://github.com/unbraind/pm-swarm/actions/runs/39647105771) passes both Node 22 and Node 26, including the complete `bun run release:check`. Both matrices run 179/179 source tests and 3/3 packed acceptance with zero failures, skips or cancellations. The full Bun command also reports 179/179 and 3/3. All 25 authored source files retain all four unchanged 100 percent coverage thresholds.

| Execution | Source suite | Packed acceptance | Disposition |
| --- | --- | --- | --- |
| Local isolated-HOME `npm run release:check`, Node 24.19.0/npm 11.17.0 | 179/179, no failures/skips/cancellations | 2/3 plus one timeout cancellation | Command exits 1; its Git npm/native Bun case hits the unchanged 600000 ms deadline. The identical case passes in both final CI matrices and full Bun release. This is the task's explicit CI-confirmed local-timeout exception, not an uninterrupted local pass. |
| Final CI Node 22 and Node 26 release steps, `a7a6ff0` | 179/179 each | 3/3 each | Pass |
| Full `bun run release:check`, final CI Node 26 | 179/179 | 3/3 | Pass |

The local source run loaded tests from `1b35d9e`; its eight-process diagnostic independently reports all nine histories. Final CI validates the added count assertion from `a7a6ff0`. Application source and package inputs do not change between these snapshots. Local coverage totals are statements/lines 1812/1812, functions 112/112 and branches 988/988. Identity/privacy, typecheck, lint, zero duplication, docstrings, production audit, package contents, changelog and publish attestation pass. The production audit reports zero vulnerabilities.

Local source duration is 1155804 ms. The local Git packed case reports 676497 ms including completion and cleanup before its timeout receipt; the non-Git packed case passes in 173239 ms. The complete packed suite takes 855573 ms. No timeout or threshold is relaxed. The existing `pm-swarm-packed-latency` item is enriched with this receipt; no duplicate follow-up is created. Local and both CI matrices' package dry-runs share shasum `d4bd106a8f49155a1593413b09832765a2112bc6`.

The local eight-process proof retains eight distinct claims, nine valid histories and strict fixture health; its claim batch takes 26234 ms. Core tracker strict health passes with six pre-existing stale-item advisories. No new PM CLI/SDK defect is observed. Hosted and cross-host coordination remain outside the local filesystem proof.

### Review-round scale rerun

The final harness at `a7a6ff0` passes through the registered PM runner, `npm run test:scale`: 1/1, exit 0, zero failures, skips or cancellations. It uses the actual built tarball, pinned host and a real non-Git tracker. The corrected process monitor preserves intentional post-readiness SIGKILL while the task-plus-project history count is now enforced.

| Observation | Result |
| --- | ---: |
| Initial agents / distinct initial owners with heartbeats | 50 / 50 |
| SIGKILL owners / recovered tasks | 13 / 13 |
| Original tasks completed exactly once | 87 / 87 |
| Valid histories, explicitly asserted | 88 |
| Double ownership / lost sync and close writes | 0 / 0 |
| Managed-extension strict health | clean |

| Phase | Milliseconds |
| --- | ---: |
| Setup | 50,759 |
| Initial claims and heartbeats | 215,418 |
| Survivor loops from contention start | 806,229 |
| Reclaim | 24,097 |
| Recovery and final verification from recovery start | 184,271 |
| Total application proof | 1,041,268 |

The whole node test invocation takes 1,049,671 ms including imports and runner overhead. No scale deadline is changed. This full run complements the negative process-exit and missing-history regressions; progress snapshots are not used as acceptance evidence. The final review refresh still has exactly the original four unresolved threads and one comment each, with no remaining pagination or separate Outside diff range findings.

The scale rerun uses Node 26.12.0/npm 11.20.0; its PM runner takes 1059000 ms including the build. The final PM-linked `node --test test/review-r4.test.ts` repetition passes 13/13, exit 0, zero failures/skips/cancellations, in 58412 ms of source-test time. Its strengthened barrier assertions are included.

The final handoff changes only append-only PM evidence and this verification note. Both original history files remain byte-identical prefixes after the final writes and claim release. The private-path check passes all added tracked lines, generated changelog is current, and strict core tracker health passes with the six existing stale-item advisories. Origin main remains an ancestor. The feature stays in progress with its claim released; the enriched latency follow-up stays open. No review thread is replied to or resolved, no PR is merged and no release is performed.

### Final fixture-cleanup correction

The later metadata-head [CI run on 5dbac6c](https://github.com/unbraind/pm-swarm/actions/runs/39653884453) exposes one Node 22 hook failure: 178/179 source tests pass, but disposing the shared fixture encounters `ENOTEMPTY` in its temporary telemetry runtime directory. This is a failed cleanup attempt, not a timeout or a passing gate; the behavioral assertion in that test does not fail. Node 26 passes its full release checks on that head.

`fd018b4` gives the shared fixture and the scale fixture's verified-root disposal the existing Git fixture policy: at most ten retries, with a 100 ms retry delay. Telemetry configuration, assertions, worker protocol and all existing test deadlines are unchanged. This changes disposal after verification; the successful scale run above executes the identical packaged application and all the same ownership, write and history checks.

[CI run 39654833752 on fd018b4](https://github.com/unbraind/pm-swarm/actions/runs/39654833752) passes Node 22 and Node 26: 179/179 source tests and 3/3 packed acceptance on each. The complete Bun release gate also passes 179/179 plus 3/3. All four coverage dimensions remain at 100 percent across all 25 authored files, and package shasum remains `d4bd106a8f49155a1593413b09832765a2112bc6`.

The PM-linked command `node --test --test-name-pattern="no-git plan uses readiness" test/shared-tracker.test.ts` passes the exact formerly failing case, 1/1, in 28724 ms including imports. The PM-linked review suite again passes 13/13 in 38891 ms including imports. Both have zero failures, skips or cancellations. The five review-round revert proofs and the two SDK invariant tests are unchanged. This receipt supersedes the failed metadata-head CI attempt and includes the final fixture disposal policy. The final handoff releases the feature claim again, preserves in-progress status, and adds only append-only evidence and this note after the cleanup correction.

## Review round on beb4d62

The remote PR branch was pulled before editing; origin main was already an ancestor. All seven review threads and every comment were read with no remaining pagination. Three threads are unresolved. The latest substantive CodeRabbit review, 5604898599, contains these same three findings, including the README nitpick, and no separate Outside diff range findings. Threads are left untouched.

| Thread | Verified disposition |
| --- | --- |
| PRRT_kwDOVLY-P86u6gIl | Documented the existing per-item staleness snapshot: eligibility is fixed when reclaim reads the claim and heartbeat evidence; a later heartbeat does not change that decision in the current invocation. Agent-wide heartbeats remain independent of the operation lease. A documentation regression requires this boundary to remain explicit. |
| PRRT_kwDOVLY-P86u6gIp | Declined with pinned-SDK evidence. Full reads include claim state. In `sdk/query/get.js`, `resolveClaimStateContext` derives `claimed` from the nonblank assignee, independently of claim events; `last_claim` alone is historical provenance. Two real non-Git tracker cases assign a foreign owner directly, with either no claim history or a previously released claim. Both return `claimed: true`; the existing `claimLane` guard rejects start, preserves the entire item history, retains the foreign owner and issues no token. No duplicate ownership guard was added. |
| PRRT_kwDOVLY-P86u6gIz | Reclaim trims its optional recipient before validation and transfer, matching handoff. SDK and actual CLI regressions verify the canonical response, durable owner, packet destination and evidence note, then receive the packet as the canonical agent and perform a fenced sync. Whitespace-only recipients still fail. |

Whole-PR review checked ownership reads and writes in shared and Git lanes, identity resolution and recipient handling, reclaim evidence selection, handoff reception, operation leases, scale worker barriers and the changed acceptance call sites. Git lanes retain the SDK claim contract; the new shared ownership tests also demonstrate why assignment-only ownership is already protected. No additional valid instance of these defect classes was found. Dependencies, deadlines, coverage scope and all release thresholds remain unchanged. Dist is ignored and is rebuilt by CI.

`node --test test/review-r5.test.ts` passes 5/5, with zero failures, skips or cancellations. `npm run typecheck` and `npm run lint` pass. Full release gates are delegated to CI as requested because of host load.

Independent disposable source copies retain the final tests and reuse the pinned dependencies; no SDK response or tracker is mocked, and source imports need no dist rebuild:

| Behavior reverted independently | Exact regression command | Result |
| --- | --- | --- |
| Only `SharedTracker.reclaim`, restored from beb4d62 | `node --test --test-name-pattern="reclaim normalizes receiver identity" test/review-r5.test.ts` | Exit 1, 0/2 passing, both fail on the padded recipient |
| Only README, restored from beb4d62 | `node --test --test-name-pattern="README defines" test/review-r5.test.ts` | Exit 1, 0/1 passing, missing snapshot boundary |
| Existing `claimLane` ownership guard removed, to validate the declined finding's protection | `node --test --test-name-pattern="start preserves a foreign assignment" test/review-r5.test.ts` | Exit 1, 0/2 passing, both fail with missing expected rejection |

All three proofs fail by assertion with zero cancellations. They change only the stated behavior in their own copies and never modify the package worktree. CI release receipts follow after completion.

### Release receipts for the beb4d62 review round

Application head `1ec0e7c` passes [CI run 39665163625](https://github.com/unbraind/pm-swarm/actions/runs/39665163625). The Node 26 job succeeds on the unchanged second attempt; Node 22 succeeds on its first attempt.

| Execution | Source suite | Packed acceptance | Coverage |
| --- | --- | --- | --- |
| Node 22 npm release steps | 184/184 | 3/3 | 100/100/100/100 percent |
| Node 26 npm release steps, attempt 2 | 184/184 | 3/3 | 100/100/100/100 percent |
| Complete `bun run release:check`, Node 26, attempt 2 | 184/184 | 3/3 | 100/100/100/100 percent |

All successful suites report zero failures, skips and cancellations. All 25 authored files remain measured at unchanged thresholds; 74 declarations have docstrings. Clean-clone strict tracker health, identity/privacy, typecheck, lint, zero duplication, build, production audit, package contents, changelog and publish attestation pass. Production audit reports zero vulnerabilities. Every package dry-run has shasum `573c122d9b0583f413a6fa5fbf23cde8fdbdfcf4`.

Attempt 1 is failed evidence: Node 26 passes 184/184 source tests, then packed acceptance reports 2/3 because its non-Git fixture disposal encounters `ENOTEMPTY` in the disposable global tracker locks directory. This is not a timeout; the full Bun gate is not reached in that attempt. The existing [pm-swarm-packed-cleanup](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/chores/pm-swarm-packed-cleanup.toon) item records this recurrence and remains open. No source changes or relaxed deadlines precede the successful retry.

The PM-selected focused suite also passes 5/5, zero failures/skips/cancellations, in 12753 ms of test time. Its exact invocation is `pm test pm-swarm-shared-tracker --run --match review-r5.test.ts --progress`, using the repo-pinned CLI and the registered `node --test test/review-r5.test.ts` command. Existing project policy disables automatic test-result tracking, so the result is retained in a PM comment. Changelog generation and checking pass after PM writes, and existing history records remain an unchanged byte prefix. No local test timeout occurs in this round.

Local strict health with the ignored managed `pm-github` installation enabled reports host-version skew: that installation was built with 2026.10.21 while the package pins 2026.10.17. Core strict health with extensions disabled and required merge drivers passes, including integrity and history drift, with six existing stale-item advisories. Both clean CI matrices pass strict health with extensions enabled. The local managed installation, dependency pins and telemetry settings remain untouched. No new PM CLI/SDK defect is observed.

The final handoff adds only PM evidence, claim release and this verification note. Package source and tarball inputs remain identical to `1ec0e7c`; the final head is independently checked by CI. The shared-tracker feature remains in progress and the cleanup follow-up remains open, with both claims released. Review threads remain untouched. Prior scale measurements retain their historical source-head provenance; no new local scale or full release workload is run under the host-load constraint.
