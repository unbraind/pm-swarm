# Native lifecycle close with revision admission

`swarm close` keeps the two SDK workspace-transaction steps: its fenced metadata
update, followed by `PmClient.close`, the native operation used by `pm close`.
The complete dependency admission corpus is read before the first journal or item
write, so even a lost read cannot leave a compensated history mutation. Core
selects and auto-unblocks dependents, clears terminal blocker fields,
completes eligible Plans, and produces lifecycle warnings. Swarm does not copy
that policy into a predicted successor document.

The native close runs with separate admitted documents and native history heads
for the primary item and each readable related item. Each actual core write
checks its own document and history under its native item lock. Unreadable foreign
rows remain unadmitted. If core attempts to update one, its ordinary dependent
failure warning is returned; unrelated foreign rows do not block closure.
Warnings from native close are returned unchanged in SDK, JSON and TOON receipts.
The SDK journal retains them in the close-step result when that result is recorded.
If a crash follows native close but precedes that checkpoint, or a legacy result
has no warning receipt, recovery returns `warnings_unavailable: true` and a
`required` instruction to inspect dependent items. It preserves that notice on
replay and does not invent native warnings or repeat the close. Native item and
history bytes remain unchanged during recovery. The pinned SDK defines
`step_applied` before result journaling and exports no durable native-close
warning receipt. The package reports this SDK limit explicitly; the follow-up is
`pm-swarm-close-warning-receipt`.
An `auto_unblock_failed` warning means the primary closed and that dependent was
preserved; it is not an assertion that every dependent reopened.

After native close returns, swarm reads the exact native history version it wrote
and records its version/hash in the SDK journal. Interrupted-close recovery and
replay use that read-back, including all core field removals and future lifecycle
changes. A hand-built `closeSuccessor` no longer exists. Ownership remains bound
to the deterministic SDK transaction identity and its journal, never to copied
history messages or mutable marker text. Compensation uses the same native
revision guard before restore, and follows the SDK's removal of completed
compensation checkpoints.

All item mutations now require either an explicit snapshot history head or a
tracker root from which the common admission helper captures one before emitting
an admission boundary. The source inventory asserts this at all **18 item writer
sites**, within the unchanged **24 total SDK/backend writer sites**. A historical
snapshot carries the hash of its exact history prefix rather than today's head.
Close retains its admission head through preparation and advances it only after
reading back its own successful write or compensation. A peer release/claim/
restore cannot establish a new accepted baseline by recreating identical bytes.
Advanced history yields `swarm_superseded` with field `history` and a preserve/
refresh remedy. Progress may refresh its complete validation after that refusal;
it never retries a previously approved witness without checking its revision and
role again.

| Mutation family | Native history precondition |
| --- | --- |
| Git native claim | Initial SDK snapshot head |
| Git lane metadata publication | Exact native claim history prefix |
| Shared claim and resource reserve/renew/publish/release | Initial SDK snapshot head |
| Git/shared file linking; ordinary handoff | Common helper captures admission head |
| Progress declaration | Common helper captures admission head; full semantic revalidation on retry |
| Git metadata rollback, failed acquisition release, terminal release/deletion | Verified acquisition/recovery head |
| Stale recovery transfer | Verified recovery head |
| Close transaction admission and forward metadata | Original admitted head |
| Native close and native dependent updates | Each item's admitted head |
| Close compensation restore | Journal-verified current head |

The new real non-git tests compare native and swarm durable lifecycle bytes,
projecting only independent clock values and swarm-owned receipt fields. Both
legacy `blocked_by` and typed `dependencies` are exercised. Seven SDK transaction
interruptions with blocker fields resume and replay without duplicate item writes.
The seeded ABA suite adds nine forward-close admissions, three dependent
admissions, and all seven native writer kinds at three admission boundaries
(**21** cases). The seed remains `0xaba47129`. Existing privacy refuse/allow
corpora, fleet relative paths, acquisition/recovery matrices, copied-marker
protections and byte-preservation assertions remain in place.

Packed npm and Bun consumers exercise dependent unblocking, native blocker-field
cleanup, interrupted-close recovery, replay and forward-close ABA alongside all
previous command and ownership checks. Full release evidence comes from the CI
npm/Bun gates with at most two workers and unchanged coverage thresholds.

Measured round-5 verification: the final pinned `pm test` command passes **12/12**
(122929.283936 ms), including the 24/18 writer inventory, foreign rows, SDK preimage
corruption, native read interleaving, compensation, historical prefix, unavailable
warning receipt, and warning-sink **85 private refusals / 34 benign admissions**.
The installed-layout rerun passes all **22** interleavings on one non-git tracker
(420197.443007 ms). A separate native-writer grid passes **21** interleavings plus
its parent result (**22/22**); the seven forward close interruptions and warning
recovery command passes **10/10** with no duplicate item mutations or lost fields.

The broader preliminary command reports 88 passes, zero failed assertions and one
installed-matrix timeout; the complete rebuilt standalone matrix above replaces
that missing evidence. Its CPU-time limits were raised without dropping a case
or byte/receipt assertion. The final static gates pass with zero duplication and
unchanged coverage thresholds. Thirteen isolated behavioral revert probes report
**53 results: 47 expected failures and six passing compatibility controls**, with
zero skips or cancellations; every source byte is restored afterward. Exact
commands and each revert proof are recorded in `pm-swarm-y972`. Full release,
packed npm/Bun, and coverage counts must come from the current CI run.
