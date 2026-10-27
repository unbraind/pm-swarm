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

All item mutations require an explicit snapshot history head. `mutationSnapshot`
captures the native head before reading the complete decision document, verifies
history did not advance during the read, and retains that exact head through the writer
lock. The commit helper refuses a missing head instead of capturing a later one. The source inventory asserts this at all **19 item writer
sites**, within **25 total SDK/backend writer sites** (including dependent restore). A historical
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
| Git/shared file linking; ordinary handoff | Head captured before the decision document |
| Progress declaration | Head captured before the decision document; full semantic revalidation on retry |
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

Round 6 closes the snapshot-to-history ABA window across Git/shared claims,
resource updates, file linking, handoff, progress, and close. Historical acquisition
and recovery receipts retain their exact prefixes. Read-only previews retain their
existing behavior rather than requiring new history validation.

Native dependent writes are observed through the same host admission hook as the
primary close. Their exact preimages and committed version/hash/history heads are
saved in the SDK close-step result. Ordinary failures compensate those writes in
reverse order before restoring the primary item. Each restore compares the native
head again under its item lock; a peer's advanced head refuses compensation before
reopening the blocker. Successful compensation refreshes only its own restored
version for a subsequent native-close retry. Audit history remains append-only.
Crash recovery preserves those receipts. A lost restore return is reconciled only
from this invocation's native commit hook and exact history head; matching content
after an unobserved history advance never proves compensation ownership. Native close remains the only lifecycle policy.

If the process loses the close result before the SDK saves it, there is no durable
proof of which secondary writes belonged to that call. Recovery never invents such
ownership from messages or matching content: a compensation attempt requires all
pre-admitted secondary heads to remain unchanged, otherwise it refuses and leaves
the native lifecycle state for explicit journal review. The existing SDK receipt
gap item tracks this boundary together with unavailable native warning receipts.

Round-6 verification passes **116/116** in the linked pm regression command
(133755.233549 ms), plus all **22** installed-layout interleavings on one non-Git
tracker. Both dependency representations compensate completely after an ordinary
`committing` failure; four SDK compensation boundaries and two lost restore returns
resume without duplicate restores. A copied preimage from a peer's single restore
and a full peer ABA both refuse compensation. Missing dependent receipts preserve
the native lifecycle state and require explicit journal review.

The unchanged privacy oracle/fuzz command passes **5/5**: **5,000** home inputs
produce **95,000** registered-mutator refusals and **10,000** renderer refusals,
with zero tracker changes; **2,500** relative paths plus **2,500** web URLs produce
**95,000** admissions with zero false refusals. The fixed embedded corpus refuses
**31/31**, and benign prose admits **34/34**. Seeds remain `0x51a7c0de` and
`0x6a09e667`. Reverting history-before-read produces **9** expected failures;
removing secondary compensation produces **5**. The fixed source is restored in
`finally` and the linked passing run follows restoration. Typecheck, lint, build,
docstrings and the zero-duplication gate pass; CI owns full npm/Bun and coverage
evidence for the pushed head.

The fresh read-only fleet oracle passes **1/1** across **35** checkouts,
**18122** tracked relative paths and **163098** presentations, with zero
false refusals or source writes. The inventory is generated at test time and is
never committed.

The completed prior CI run exposed stale cleanup expectations and a lost metadata
return. The close metadata step now retains its native commit observation even
when the caller loses the return, so compensation uses the exact owned revision.
Git acquisition cleanup accepts later versions only when this invocation observed
their commits; arbitrary same-author updates no longer refresh its baseline.
Tests now require preservation of peer claims, history and Git resources, including
superseded leases. The independent-peer loss fixture leaves the caller's admission
scope before performing its real SDK mutation; all state assertions remain.

Forward admission captures the raw SDK history stream head before its authoritative
item read, without requiring historical document reconstruction. Publication uses
`readHistorySnapshot` and `resolveHistoryTarget` for the exact history prefix. The
unchanged legacy start/next positive cases pass without rewriting audit records.
Additional behavioral reverts produce five expected failures: one lost metadata
return, two foreign-update cleanup cases, and both legacy positive cases.
