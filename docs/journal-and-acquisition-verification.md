# Journal ownership and acquisition cleanup

Close recovery binds its deterministic `swarm-close/v2` identity to the canonical
item, actor, original fence and exact note. `validateWorkspaceTransactionIdentity`
validates the journal coordinate. `commitWorkspaceTransaction` alone owns its
journal, ordered metadata update/close, resume and reverse compensation. Package
step data stores the native version and a SHA-256 of the complete document.
`readHistoryEntries` and `getItemAt` verify the exact native version sequence;
free-text messages never authorize recovery. Unknown or changed journals fail
closed. The public SDK supplies Plan completion semantics too.

The pinned SDK has no typed journal-inspection API; that limitation is already
tracked in [pm-cli#1597](https://github.com/unbraind/pm-cli/issues/1597). The adapter
uses public `readFileIfExists` at the documented SDK journal location and never
writes a journal or implements a second coordinator. Native settings registration
remains split into [pm-swarm-native-settings](../.agents/pm/issues/pm-swarm-native-settings.toon),
blocked on [pm-cli#1580](https://github.com/unbraind/pm-cli/issues/1580).

Git start retains the actual SDK `onWrite` commit receipt before a native
operation can lose its return and before any post-write liveness publication. Its cleanup includes the following SDK read, branch CAS, worktree,
Git configuration, item publication and receipt. Cleanup remains registered until
outer receipt admission and final heartbeat succeed. Shared starts and newly
acquired resource reservations follow the same rule. Every independent owned
release is attempted. Native version/lineage checks preserve peer replacements,
including same-author ABA; full-document CAS preserves peer content edits.
Cleanup does not announce liveness and still checks its pin generation when a
renewal failed. Nested locks release before the tracker pin.

Admission and cleanup bind to the native history head even when a peer restores
an identical document. The recorded claim version comes from the actual native
commit, including legacy assignment migration. A native no-op can skip SDK
mutation hooks: its complete fresh document is therefore read and checked before
the claim write scope announces liveness or creates any Git resource. Independent
peer title, body and file changes survive a refusal with unchanged heartbeat and
lease bytes. Final receipts recheck their generation. Dirty peer worktrees keep
their attached branches, and successful acquisition performs no fallible
empty-directory removal after releasing its cleanup scope.

A core SDK claim requires the bound client's package hooks to be active. The
existing preclaim read carries a request-local probe marked by the SDK `onRead`
hook; it neither changes the result nor adds a read. A client that disables
extensions receives `swarm_sdk_mismatch` before ownership changes. Tests cover
Git `start`, `next` and `schedule`, plus an existing native claim, preserving the
complete durable tracker and its old heartbeat. This also retains the original
inactive-extension cleanup regression unchanged.

Runtime temporary files retain ownership immediately on exclusive open; failed publication removes only
an owned temporary. Request cleanup is inside the pin cleanup scope. Verification
worktree cleanup also encloses worktree creation, and temporary directory cleanup
runs even if worktree removal fails.

## Behavioral revert proofs

The previous continuation’s 27 negative probes exited 1; production sources were restored immediately.
The probes produced 55 expected failures and six passing controls across 61 results.

| Reverted behavior | Exact probe | Result |
| --- | --- | --- |
| Message-based close recovery | `node --test --test-concurrency=1 --test-name-pattern='copied same-author' test/close-journal-ownership.test.ts` | 0/4 pass; copied messages let retries erase peer fields |
| Old `startLane` acquisition scope | `node --test --test-concurrency=1 --test-name-pattern='following real SDK read fails' test/start-cleanup.test.ts` | 0/1 pass; failed read retains the claim |
| Late receipt rollback registration | `node --test --test-concurrency=1 --test-name-pattern='retains cleanup through every post-write' test/start-cleanup.test.ts` | 6/12 pass; three receipt failures retain claims and lanes |
| Pin cleanup scope | `node --test --test-concurrency=1 --test-name-pattern='failure removing the request after pin' test/privacy-lease.test.ts` | 0/1 pass; request cleanup fault retains the pin |
| Exclusive temporary publication | `node --test --test-concurrency=1 --test-name-pattern='failed atomic runtime rename\|foreign temporary collision' test/privacy-lease.test.ts` | 0/2 pass; orphan temporary or overwritten foreign record |

Additional probes use the same `node --test --test-concurrency=1` prefix:

| Reverted behavior | Probe arguments | Result |
| --- | --- | --- |
| Typed Git cleanup transport | `--test-name-pattern='replaced Git configuration' test/start-peer-cleanup.test.ts` | 0/1 pass |
| Shared acquisition cleanup | `--test-name-pattern='shared .* releases only' test/claim-lifecycle.test.ts` | 0/3 pass |
| Reservation acquisition cleanup | `test/reservation-cleanup.test.ts` | 0/2 pass |
| Cleanup after renewal failure | `--test-name-pattern='cleanup writes retain generation' test/claim-lifecycle.test.ts` | 0/1 pass |
| SDK Plan completion predicate | `--test-name-pattern='SDK Plan completion' test/close-journal-adversarial.test.ts` | 0/1 pass |
| No Git lookup after acquisition | `--test-name-pattern='receipt projection performs' test/start-peer-cleanup.test.ts` | 0/1 pass |

Native-boundary probes use the same test runner prefix:

| Reverted behavior | Probe arguments | Result |
| --- | --- | --- |
| Native `onWrite` acquisition receipt | `--test-name-pattern='onWrite receipt\|shared and resource acquisitions' test/acquisition-receipts.test.ts` | 0/3 pass; a lost return retains claims or lane metadata |
| Journal-owned native failure handling | `--test-name-pattern='SDK-journaled close compensates' test/acquisition-receipts.test.ts` | 0/1 pass; compensated close incorrectly returns a partial-commit refusal |
| Typed late cleanup conflicts | `--test-name-pattern='late receipt cleanup' test/start-peer-cleanup.test.ts` | 0/1 pass |
| Stable native history reads | `--test-name-pattern='native history snapshot' test/close-journal-adversarial.test.ts` | 0/1 pass; a real independent peer append goes unnoticed |
| Immediate temporary-file ownership | `--test-name-pattern='runtime cleanup owns the file immediately' test/privacy-lease.test.ts` | 0/1 pass; failure after the real exclusive write leaves an orphan |

Final native and completion boundaries use the same test runner prefix:

| Reverted behavior | Probe arguments | Result |
| --- | --- | --- |
| Superseded generation transport | `--test-name-pattern='Git lane (publication\|rollback) never' test/review-r9.test.ts` | 0/2 pass |
| Final generation admission | `--test-name-pattern='final receipt checks\|void acquisition' test/cleanup-boundaries.test.ts` | 0/2 pass |
| Attached branch ownership | `--test-name-pattern='peer-changed dirty worktree' test/cleanup-boundaries.test.ts` | 0/1 pass |
| Native legacy blank assignment | `--test-name-pattern='cleanup treats imported blank' test/legacy-claim-cleanup.test.ts` | 0/2 pass |
| No fallible cleanup after success | `--test-name-pattern='successful claim receipts' test/cleanup-boundaries.test.ts` | 0/1 pass |
| Legacy migration commit version | `--test-name-pattern='legacy existing claim' test/legacy-claim-cleanup.test.ts` | 0/1 pass |
| Fresh no-op admission before liveness | `--test-name-pattern='peer-owned native claim no-op' test/start-admission-race.test.ts` | 0/4 pass |
| Locked native history head | `--test-name-pattern='different native history head' test/start-admission-race.test.ts` | 0/1 pass |
| Complete large-patch identity audit | `--test-name-pattern='complete large patches' test/tooling.test.ts` | 0/1 pass; default subprocess buffer rejects a valid public patch |
| Active hooks before native acquisition | `--test-name-pattern='without active hooks\|start refuses terminal' test/start-admission-race.test.ts test/edges.test.ts` | 0/6 pass; inactive clients acquire ownership without a usable native receipt |
| Complete document after native claim | `--test-name-pattern='public peer edit after native claim' test/start-admission-race.test.ts` | 0/4 pass; removing the comparison accepts a changed claim document |

Positive source checks exercise real SDK trackers and Git, including seven start
boundaries for each of `start`, `next` and `schedule`, three heartbeat boundaries
per command, retained pre-existing claims, peer ABA and fresh peer-content cleanup.
Four copied-message field edits each survive three retries. Journal corruption,
foreign step data, forged hints and unrelated same-author mutations refuse without
item/history changes. Existing seven forward and four compensation crash
boundaries remain covered. Packed npm and Bun consumers independently repeat the
copied-message ownership proof in their installed module graph.

The broad pinned-pm linked integration command passes **127/127** with zero
failures, skips, cancellations or todo results (203597 ms in the native test
runner), including the release-approval tests merged from main. The earlier
journal and acquisition run passed **126/126**. Typecheck, lint, zero duplication and all declarations across 36
authored files pass. Source coverage of the new journal verifier is 100 in all
four dimensions; complete package coverage remains a separate CI gate.

The final activation-admission linked run passes **16/16**, including the
unchanged inactive-extension edge test, post-claim read cleanup, private peer
no-ops, native history-head ABA and all four inactive-client cases. Typecheck,
lint, zero duplication, identity and all 164 declarations pass after this change.
Public peer title, body and linked-file edits between native claim and the next
read are also refused before heartbeat publication; their content survives the
owned claim release. These cases cover the complete-document comparison itself,
in addition to read failures, private content and changed native history heads.

The identity gate audits the complete synthetic PR merge, whose accumulated
tracker changes can exceed the default subprocess pipe buffer. Owned temporary
file output removes that ceiling without changing the audited commit range or
identity/privacy policy. A public patch larger than 2 MiB passes; a forbidden
path at its tail still fails without disclosing the value. Descriptor and
directory cleanup cover both successful and failed Git calls. The linked
identity regressions pass **6/6**, and the actual synthetic merge audits with
zero violations.

Full release evidence comes from CI at the final pushed head, with at most two
test workers and unchanged 100/100/100/100 source coverage thresholds. The PR and
pm item retain exact run URLs and counts; focused local checks precede each gate.

The subsequent portable-receipt and fencing-generation audit is documented in
[receipt-and-generation-verification.md](receipt-and-generation-verification.md),
including same-author successors and the SDK-locked Git cleanup gate.
