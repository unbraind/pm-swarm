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

Runtime temporary files retain ownership immediately on exclusive open; failed publication removes only
an owned temporary. Request cleanup is inside the pin cleanup scope. Verification
worktree cleanup also encloses worktree creation, and temporary directory cleanup
runs even if worktree removal fails.

## Behavioral revert proofs

All sixteen negative probes exited 1; production sources were restored immediately.

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

Positive source checks exercise real SDK trackers and Git, including seven start
boundaries for each of `start`, `next` and `schedule`, three heartbeat boundaries
per command, retained pre-existing claims, peer ABA and fresh peer-content cleanup.
Four copied-message field edits each survive three retries. Journal corruption,
foreign step data, forged hints and unrelated same-author mutations refuse without
item/history changes. Existing seven forward and four compensation crash
boundaries remain covered. Packed npm and Bun consumers independently repeat the
copied-message ownership proof in their installed module graph.

The final pinned-pm linked integration command passes **126/126** with zero
failures, skips, cancellations or todo results (264287 ms including runner
overhead). Typecheck, lint, zero duplication and all 161 declarations across 36
authored files pass. Source coverage of the new journal verifier is 100 in all
four dimensions; complete package coverage remains a separate CI gate.

Full release evidence comes from CI at the final pushed head, with at most two
test workers and unchanged 100/100/100/100 source coverage thresholds. The PR and
pm item retain exact run URLs and counts; focused local checks precede each gate.
