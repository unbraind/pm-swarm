# Close and recovery state machine

Swarm coordinates writers on one tracker, including a plain directory without
Git. The operation lease serializes swarm commands; native item locks and
monotonic history checks protect against independent SDK and CLI writers.
Neither an author name nor a fencing token is an authentication credential.

| Durable state | Next action | Result after an interrupted process |
| --- | --- | --- |
| No intent | Resolve canonical ID, check complete document, ownership and history | A new request performs fresh admission |
| `applying` intent | Delegate to native close, admit actual successors and warnings | Compensate the certified committed prefix |
| `committed` intent | Replay the saved native warning/result receipt | No duplicate close or unblock |
| `compensating` intent | Restore pending dependents, then the primary | Skip certified restores and continue |
| Primary restored | Its native restore receipt certifies compensation | Return `swarm_close_compensated` without writes |
| Foreign history or unavailable storage | Preserve existing state | Return `swarm_compensation_partial` with restored/pending IDs |
| Legacy or unowned history | Require explicit inspection | Return `swarm_close_recovery_unsupported` |

The coordinator is the primary item's registered `swarm_close_intent` string.
Its immutable plan contains a random, SDK-validated `compensation_id`, canonical
primary ID, author, token, note and complete admitted member list. Each member
records its native restore version, pre-close item-byte digest, document hash
and native history head. No document body or history message is copied into the
intent. The final successful update also clears handoff/claim metadata and advances the
decimal fencing generation, while the journal retains the original request token.
Native item updates retain every intent revision in native history;
there are no extension-owned recovery side files or competing SDK journals.

The admitted corpus is a conservative member superset. Native close decides the
actual lifecycle domain, including Plan behavior and dependent auto-unblocking.
Actual history receipts identify which admitted members changed. Unreadable
foreign members remain unadmitted and native warnings report affected failures.
New or changed dependents that were not admitted cannot bypass the item guard.

Every native call has a distinct SDK episode, but caller-declared episodes alone
are never proof of ownership. A fresh close creates an ephemeral Ed25519 signer
and records only its public key in the immutable intent. Under each native item
writer lock, the same admission hook observes core's exact proposed before/after
documents and native history head. Before core persists the item, it signs the
canonical target, operation, compensation identity, before-head and document
hashes, then persists that public proof through the bound SDK's audited
`swarm.close_proofs` workspace settings subtree. Neither the document nor its
native lifecycle successor is predicted or replaced. The private key remains in
memory and is never serialized.

Recovery verifies those signatures against the original intent and matches the
exact native history entry, including its ordinal and complete before-prefix.
Copying a close episode onto an untouched member, or closing a primary through
another same-author call, supplies no valid signed native proposal. Restoration
additionally binds the member, original version/digest and frozen post-close
history head; copied later restore entries cannot replace that uninterrupted
chain. Journal updates may change only owned completion fields and the native
clock, and progress must advance monotonically.

Before the first restore, the coordinator persists the complete affected member
list, signed native proposals and post-close history heads. The audited workspace
proof cache is then retired; the complete proofs remain in native item history. Dependents restore in reverse order. Every
restore and progress write syncs native item and history files plus parent
directories. If a restore commits before its progress update, its immutable
native receipt supplies the missing progress on retry. If the final primary
restore removes the intent field, retained native history still supplies the
plan and final receipt. Item bytes, including timestamps, return exactly to the
pre-close version; successful history events and refusal evidence are retained.

Every restore compares its captured history head under that member's native
writer lock. The final primary restore also holds native locks on the restored
dependents while rechecking the domain, so a peer cannot race dependency state
between the final decision and reopening the blocker. Peer edits stop recovery;
compensation never overwrites them. A later claim with a larger token may begin
fresh work only after the earlier primary restore is independently certified.

A warning receipt that fails privacy admission is not copied into compensation; the original native audit remains intact.
A lost native return has no reliable warning receipt. Recovery compensates that
prefix rather than inventing success or rerunning native close on a terminal
primary, which could skip unfinished dependents. Once `committed` is durable,
the original request can replay its saved warnings without acquiring an operation
lease, even if post-commit lease cleanup failed. A lost proof-cache retirement is
finished through the native workspace audit writer before that replay returns. Native closes without this
protocol's proof, including legacy transaction markers, remain manual recovery.

Validation uses real non-Git trackers, OS-process SIGKILL at forward and reverse
boundaries with one to three dependents, independent peer ABA writers, copied
identity controls, exact native-byte oracles, and packed npm/Bun consumers.
Coverage and privacy admission thresholds remain unchanged.
