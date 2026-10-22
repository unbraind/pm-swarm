# Fenced shared-tracker leases

Tracked in [pm-swarm-shared-tracker](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-shared-tracker.toon). The package remains unreleased.

Selection, shared sync, close, handoff and reclaim serialize through an atomic process pin in the tracker's ignored runtime directory. Immutable requests enter an arrival-ordered queue; staged records are excluded and dead tickets are recovered. Only its head attempts to publish a process pin with a hard link; fifty contenders do not cycle through SDK lock creation on the admission path. The renewable operation record has a 30-second expiry and a five-second renewal interval. The live pin spans awaited SDK mutations. An expired living operation cannot be replaced while it is inside a write; a resumed stale operation refuses its next write. Killed processes are recovered under a separate SDK recovery lock after checking the exact pin generation. Linux start identity detects PID reuse; other platforms preserve ambiguous live pins conservatively. The local filesystem must support atomic hard links and rename. Hosted and cross-host filesystems are outside this acceptance proof.

Shared claims atomically persist assignee, decimal fencing token and claim timestamp. Shared writers verify principal and token under the same pin, before dispatching SDK mutations. Handoff and reclaim update ownership, generation, receiver packet and comment in one item mutation. The receiver's next operation returns its pending packet before selecting new work. A fresh transfer grants a heartbeat interval even when its recipient's old runtime heartbeat is stale. Reclaim returns stale nonterminal items to the configured open status, or assigns them to a specified receiver. A non-decimal swarm_token is preserved and reported in refused, and the rest of the batch continues. A Git lane is not returned to the pool; pass --to to keep that lane assigned. Explicit reassignment preserves swarm_branch. Close finishes and releases a fenced claim in one mutation. Git sync also validates ownership and any persisted swarm token under the tracker pin; other Git lane ownership and core pm writers retain their SDK contracts.

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


## PR 12 review round 6

All three unresolved findings from the CodeRabbit review submitted at 2026-10-21T21:11:06Z are valid. The complete thread/comment read has no pagination remaining; the review body has no additional Outside diff range findings. The subprocess timeout nitpick is included.

| Thread | Correction |
| --- | --- |
| PRRT_kwDOVLY-P86u9G2Q | The latency item's description distinguishes the earlier 599323 ms passing run from the later local exit 1 after the packed Git timeout. Existing CI receipts, assertions, deadlines and the separate cleanup follow-up remain intact. |
| PRRT_kwDOVLY-P86u9G2X | Git sync discovers lanes, reads authoritative ownership and linked files, validates the persisted token, and dispatches SDK writes under one tracker lease. Fenced mutations require a token; explicit stale tokens also fail on no-op applies. The real CLI returns typed exit 2. |
| PRRT_kwDOVLY-P86u9G2b | The shared synchronous CLI helper has a 300000 ms process timeout and includes spawn errors in its assertion diagnostic. The same timeout was added to the Git CLI helper. |

Same-class review additionally covers terminal Git sync writes, fresh linked-footprint deduplication, expired operation refusal and Git CLI asynchronous error conversion for sync. Other Git verbs' pre-existing asynchronous error conversion is tracked separately in [pm-swarm-git-errors](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/issues/pm-swarm-git-errors.toon). No SDK responses are mocked; subprocess tests run a real stalled child with only the launch boundary's timeout scaled to 25 ms.

`node --test test/review-r6.test.ts` passes **8/8** through the pinned PM runner, with zero failures, skips or cancellations. The targeted compatibility command `node --test --test-name-pattern="sync protects foreign|Git sync|shared planning retains" test/shared-tracker.test.ts` passes **6/6**, with zero failures, skips or cancellations. `npm run typecheck` and `npm run lint` pass. No local host-load timeout occurred this round. Full release gates run in CI under the task's local CPU restriction; no local full-gate or scale rerun is claimed. Dist is ignored and rebuilt by CI.

Every proof uses an isolated source copy, keeps the final tests, exits 1 by assertion and has zero cancellations. Commands below are `node --test --test-name-pattern="PATTERN" test/review-r6.test.ts`:

| Reverted behavior | PATTERN | Result |
| --- | --- | --- |
| Only `Swarm.sync` from 177b7b4 | `Git sync` | 0/5; stale/missing tokens, fresh foreign/unassigned owner, missing pin, expired write |
| Only `sharedFixture` timeout/diagnostic | `^shared CLI helper` | 0/1; missing process timeout |
| Only `swarmCli` timeout | `^Git CLI helper` | 0/1; missing process timeout |
| Only the previous latency description | `^latency summary` | 0/1; missing chronology |
| Only the sync await in `runCommand` | `^Git sync fences` | 0/1; untyped CLI exit 1 instead of 2 |

The detailed proof and pass receipts are on pm-swarm-shared-tracker. Dependencies, source inventory, exclusions and all release thresholds remain unchanged. No thread was replied to or resolved.


The application/test head **4d6a708** is fully accepted by [CI run 39678612674](https://github.com/unbraind/pm-swarm/actions/runs/39678612674), without retry:

| Release execution | Source tests | Packed acceptance | Coverage |
| --- | ---: | ---: | --- |
| Node 22 npm release steps | 192/192 | 3/3 | 100/100/100/100 |
| Node 26 npm release steps | 192/192 | 3/3 | 100/100/100/100 |
| Full `bun run release:check` | 192/192 | 3/3 | 100/100/100/100 |

Every suite has zero failures, skips and cancellations. All 25 authored source files are measured; 74 declarations are documented. The unchanged duplication gate reports 0/4996 lines across 48 sources, zero clones, and production audit reports zero vulnerabilities. Strict clean-clone tracker health, identity/privacy, typecheck, lint, build, package contents, changelog and release-publish attestation pass. Fresh main remains an ancestor. The initial 7364d52 CI attempt failed on one duplicated new-test setup block; factoring only that setup into a helper corrected it, without threshold or assertion changes. The final PM-linked 8/8 regression run took 8339 ms including runner overhead.

The handoff commit adds only PM receipts, releases the claim without closing the item, and records this verification. Its full CI is verified separately before handoff. The latency profiling, packed cleanup and other-Git-command error conversion follow-ups remain open. No new PM CLI/SDK bug was observed.

## Review round on PR 12 after 2fadac3

The remote head was current, then origin main (one commit ahead, tracker reconciliation only) was merged before edits. All twelve review threads were fetched with their comments and no remaining pagination. Two threads are unresolved. The latest CodeRabbit review body, submitted 2026-10-22T00:13:40Z, contains those two findings and no Outside diff range section. Threads are left untouched.

| Thread | Verified disposition |
| --- | --- |
| PRRT_kwDOVLY-P86vADX2 | Valid. `swarm_token` is a free string field. `BigInt` throws `SyntaxError` for values such as `abc` and `1.5`, and it also accepts non-decimal values such as `-1`, `0x10`, `+3` and surrounding whitespace, which would rewind or jump a fencing generation. `decimalFencingGeneration` accepts only a decimal generation, with a missing value as zero. `start`, `next`, `handoff` and `close` name the item and refuse before writing. `reclaim` reports the item in `refused` and continues with the other items. |
| PRRT_kwDOVLY-P86vADX6 | Valid. `reclaim` is dispatched through `SharedTracker` even inside a Git workspace. Pool return clears assignee and sets the open status but leaves `swarm_branch`. Git `next` skips that field and Git `start` reports that the lane already exists, so the item cannot be resumed. Pool return of a truthy `swarm_branch` is refused. Explicit `--to` still transfers and preserves the branch and base. The guard reads the full item, which is the record `transfer` would write; certified corpus rows also retain `swarm_branch`. |

Whole-PR review of token parsing, batch mutation loops and assignee clearing found no other instance. `nextToken` is the only `BigInt` conversion of a stored generation. `handoff` cannot pool-return because it requires a recipient. `close` and Git `reap` are terminal paths, not open-pool returns, and were left unchanged. Dependencies, deadlines, coverage scope and all release thresholds remain unchanged. Dist is ignored and rebuilt by the release gates.

`node --test test/review-r7.test.ts` passes 4/4, with zero failures, skips or cancellations. Independent isolated copies retain the final tests and pinned SDK; source imports need no dist rebuild. Each mutant exits 1 by assertion with zero cancellations:

| Behavior reverted independently | Exact regression command | Result |
| --- | --- | --- |
| Only `decimalFencingGeneration`, restored to unconditional `BigInt` | `node --test --test-name-pattern="malformed swarm_token" test/review-r7.test.ts` | Exit 1, 0/2. Writers see `SyntaxError`; reclaim aborts on `Cannot convert 1.5 to a BigInt` |
| Only the reclaim malformed-token guard | `node --test --test-reporter=tap --test-name-pattern="does not abort reclaim" test/review-r7.test.ts` | Exit 1, 0/1. The batch throws from `nextToken` instead of refusing and continuing |
| Only `gitLanePoolRefusal`, restored to allow every pool return | `node --test --test-reporter=tap --test-name-pattern="Git lane pool return" test/review-r7.test.ts` | Exit 1, 0/1. The real Git lane and a manually stored branch are both returned to the pool |
| Only the new README refusal sentences | `node --test --test-reporter=tap --test-name-pattern="README defines reclaim token" test/review-r7.test.ts` | Exit 1, 0/1. The documentation regression no longer matches |

The continuation independently reproduced all four revert proofs and the 4/4 passing focused suite. No proof mutation was applied to the package worktree. Strict tracker health passes with a fresh global configuration, including integrity and append-only history. The default local configuration reports an externally installed `pm-github` host-version mismatch; no dependency pin or global extension was changed.

The pinned PM runner also passes the focused suite, 4/4 with zero test failures, skips or cancellations (`pm test pm-swarm-shared-tracker --run --only-last --progress --timeout 600`; 282252 ms including runner overhead). Test-result persistence is disabled by project policy, so the receipt is retained in the item comments.

The local `npm run release:check` used Node 26, a fresh home/global configuration and isolated Git configuration. Identity, types, lint, duplication (0/5148 lines across 49 sources), build and docstrings (25 files, 74 declarations) pass. Both unchanged watch-process tests fail during heavy host contention; the four new regression cases pass again within that full run. The already-failed gate was then interrupted, exit 130, so incomplete coverage and later package checks are not claimed as passing. No dependency pin, deadline, coverage scope or threshold changed. Complete npm and Bun acceptance is pending CI on the pushed candidate.

### Candidate CI acceptance

Application/test head **684ce997bde8f25a42fe23dbee78fafb76dd7e04** passes [CI run 39764229670](https://github.com/unbraind/pm-swarm/actions/runs/39764229670) on its first attempt:

| Gate | Source tests | Packed npm/Bun tests | Coverage |
| --- | --- | --- | --- |
| Node 22 npm pipeline | 196/196 | 3/3 | 100/100/100/100 |
| Node 26 npm pipeline | 196/196 | 3/3 | 100/100/100/100 |
| Node 26 `bun run release:check` | 196/196 | 3/3 | 100/100/100/100 |

Every successful suite has zero failures, skips and cancellations. Coverage reports all 25 authored source files; duplication is 0/5148 lines across 49 sources with zero clones; all 74 declarations are documented; production audit reports zero vulnerabilities. Strict clean-clone PM health, identity/privacy, types, lint, build, package contents, changelog and publish attestation pass. Both unchanged watch tests that missed initial output deadlines locally pass in CI without a retry. The interrupted local gate remains incomplete evidence.

The final review refresh retains exactly the original two unresolved threads, the same latest substantive review, complete pagination and no Outside diff range findings. Both findings are valid and fixed; no additional instance was found. No new PM CLI/SDK bug was observed. Existing packed latency, cleanup and other-Git-command error follow-ups remain open.

The handoff commit adds only PM receipts, releases the claim without closing the item, and records this verification. Its full CI is checked separately before handoff. Application source, tests and package inputs remain unchanged from the accepted candidate.

## Review round on 8fa9283

The worktree started clean with no unpushed commits. The remote head was pulled and fresh main was already an ancestor. The prior round remains accepted on its exact pushed head; its tests and evidence were retained. All unresolved threads and comments were fetched without remaining pagination. The latest CodeRabbit review, submitted 2026-10-22T11:10:00Z, has one finding and no Outside diff range section.

| Thread | Verified fix |
| --- | --- |
| PRRT_kwDOVLY-P86vKOZC | Valid. Receiver `next` parsed a free-string packet without checking JSON syntax or decoded shape. Invalid JSON leaked `SyntaxError`; `null` leaked `TypeError`. The decoder now rejects malformed JSON, non-object/array contexts and invalid or mismatched decimal generations with `StaleFenceError` before returning context or remembering a token. CLI classification remains exit 2 with structured `swarm_stale_fence`. |

Whole-PR review found only one reader of `swarm_handoff`; both handoff and reclaim construct its packet with `JSON.stringify`. Missing and malformed packet generations are refused even when the item generation is also missing or equally malformed, preventing an unusable receiver token. The other JSON readers handle runtime records, settings or an internal test-runner protocol, not receiver packets; their existing corruption contracts remain unchanged.

`node --test test/review-r8.test.ts` passes 2/2 with zero failures, skips or cancellations. The SDK case covers malformed JSON, null, string/number/boolean primitives, arrays, absent/numeric/non-decimal/mismatched packet generations, and both preview and claim modes. It verifies unchanged item snapshots and byte-identical histories after refusal. Restoring a valid packet preserves preview without granting ownership, then permits receiver continuation. Real CLI cases cover malformed JSON and null in both modes, inspect the structured error code, preserve history, and accept a repaired valid packet. All fixtures are non-Git trackers, use the pinned real SDK and host, and have no Git executable on the CLI path.

Type checking, lint and the unchanged zero-duplication gate pass (0/5235 lines, 50 sources, zero clones). Dependencies and all release thresholds remain unchanged. Dist remains ignored and is rebuilt by release validation.

The repo-pinned linked runner also passes 2/2, exit 0, zero test failures/skips/cancellations (`pm test pm-swarm-shared-tracker --run --only-last --progress --timeout 600`; 16358 ms including runner overhead).

Behavioral revert proof restores **only `SharedTracker.next` from 8fa9283** in an isolated copy while retaining the final parser helper, regression tests and pinned SDK. `node --test --test-reporter=tap test/review-r8.test.ts` exits 1: **0/2 pass, 2 failures, zero skips/cancellations**. The SDK case receives raw `SyntaxError` instead of `StaleFenceError`; the CLI case loses structured `swarm_stale_fence` classification. Source imports require no dist rebuild. No proof mutation entered the package worktree.

### Local release acceptance

Both full release gates pass on the final source/tests/package inputs with Node 26, fresh home/global configuration and isolated Git configuration:

| Exact gate command | Source tests | Packed npm/Bun tests | Coverage |
| --- | --- | --- | --- |
| `npm run release:check` | 198/198 | 3/3 | 100/100/100/100 |
| `bun run release:check` | 198/198 | 3/3 | 100/100/100/100 |

Every suite has zero failures, skips and cancellations. All 25 authored source files are reported, all 75 declarations are documented, duplication is 0/5235 lines across 50 sources with zero clones, and production audit reports zero vulnerabilities. Identity/privacy, types, lint, build, package contents, changelog and publish attestation pass. Isolated strict tracker health passes. No local timeout or retry occurred in this round; the prior round's interrupted gate remains separate historical evidence. Dist is ignored and rebuilt by both gates.

The source commit includes the code, regression, README clarification, these verification receipts and append-only PM history. The claim is released without closing the item; the complete pushed-head CI is checked before handoff. Existing packed latency, cleanup and other-Git-command error follow-ups remain open. No new PM CLI/SDK bug was observed. No review reply, resolution, mention, PR merge or package release is performed.
