# Acquisition cleanup and the close recovery boundary

Git start retains the actual SDK `onWrite` commit receipt before a native
operation can lose its return and before post-write liveness publication. Its
cleanup encloses every following read, branch creation, worktree registration,
Git configuration update, item publication and receipt. Cleanup remains active
until outer receipt admission and final heartbeat succeed. Shared starts and
new resource reservations use the same rule. Independent owned releases are
attempted; nested locks release before the tracker pin.

Cleanup checks the exact acquired fencing generation and native history head
under the SDK item lock. Document equality cannot prove acquisition identity
because a peer can release, claim and restore identical bytes. Only successors
observed from this invocation's native commit hooks can advance its baseline.
A changed head returns `swarm_superseded` and preserves peer items and Git
resources. The no-op Git callback retains the lock across branch/worktree cleanup.
Git configuration removal additionally compares the expected value.

A native claim requires active package hooks in the host-bound SDK client. Its
identity read proves activation with a request-local probe; the authoritative
complete read follows the native history baseline. Disabled extensions or a
second SDK instance refuse before ownership changes. Native aliases resolve
before history selection, including service-capable trackers.

Runtime temporary ownership starts at exclusive open. Failed publication removes
only that owned temporary; request cleanup remains inside the pin cleanup scope.
Verification-worktree cleanup encloses creation and still removes its owned
temporary directory when worktree removal fails.

## Close admission and automatic recovery

The former `swarm-close/v2` prototype was retired before the current
native-field intent protocol. Commit `0157465` preserves the prototype
for the related [durable recovery Feature](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-durable-close-recovery.toon)
and [issue 34](https://github.com/unbraind/pm-swarm/issues/34). Its previous test
counts and recovery claims are historical evidence, not the current contract.

A fresh close delegates one native operation, retaining lifecycle changes
and warnings from core; retrying an existing pending episode compensates it
instead of delegating another native close. Retrying the exact original author,
token and note automatically restores the certified pre-close members and returns
`swarm_close_compensated`, so a supported retry or a compensating restore is
expected operator behavior, never evidence of corruption. A prior native close
from another request, an unowned terminal state, legacy marker or mismatched
history produces `swarm_close_recovery_unsupported`, naming the canonical item and
tracker-relative journal entry. Recovery never restores, rewrites or adopts a
close based on author equality, copied messages or document equality alone.
A durable committed receipt replays its saved result; a lost return after commit
reports `swarm_partial_commit` and never starts compensation.
See [native close](native-close.md) for the complete boundary. Configuration access
is separate from close recovery; [pm-cli#1580](https://github.com/unbraind/pm-cli/issues/1580)
records the historical SDK settings-reader gap.

## Behavioral evidence

Retained tests cover post-claim read failure, lost native returns, every acquisition
and heartbeat boundary, exact-generation cleanup, peer ABA, locked Git deletion,
foreign Git configuration, published legacy receipts and inactive SDK clients.
Their earlier behavioral revert evidence remains append-only in `pm-swarm-y972`.
The current [history fencing audit](native-history-cas.md) lists all item writers.

The split adds three disposable-source revert proofs. Reinstating the prototype
adopts an unrelated same-author native close and fails the required rejection.
Selecting history before native ID resolution fails the service-context short-ID
success case. Removing the prior-close guard permits another close after a peer
restores an open preimage. Each reverted probe exits 1 behaviorally; restored
source passes. Current tests kill real processes at every forward and reverse
boundary: owned interrupted prefixes compensate, while foreign-history refusals
preserve all item, dependent, journal and peer bytes.

Packed npm and Bun consumers exercise fresh close, saved-result replay,
automatic compensation and peer-preserving refusal on non-Git trackers. Full
release and four-dimensional coverage evidence belongs to the
final pushed-head CI run, with unchanged thresholds and at most two test workers.
