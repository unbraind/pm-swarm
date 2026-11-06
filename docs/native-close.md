# Durable native close

`swarm close` resolves short and full IDs through the bound native `get()` before
selecting history, including service-capable layouts. It captures history before
reading the complete decision document and checks that same head under the
native item writer lock. Legitimate handoff/reclaim receipts select the current
owner and generation; stale tokens, bodies and peer ABA histories still refuse.

The close protocol and transition table are specified in
[ARCHITECTURE](../ARCHITECTURE.md). The primary item's registered
`swarm_close_intent` holds the immutable plan, unique compensation identity and
monotonic progress. All persistence uses the bound SDK; native files and parent
directories are synced before the next recovery step on POSIX; Windows file-flush
and power-loss limits are documented in ARCHITECTURE. No package side journal
or independently edited SDK transaction journal exists.

Fresh close delegates lifecycle policy to native core. It preserves Plan policy,
blocker-field removal, dependent unblocking and native warnings. Actual native
read-back defines successors; swarm does not predict native documents. Both the
full current document and proposed complete document pass privacy admission.

Retry with the original author, token and note. Pending recovery is selected
before terminal status and current ownership checks because native close may
already have removed the assignee. A committed result replays its saved warning
receipt without waiting for an operation pin, completing any lost native proof-cache
retirement first. Its final guarded native update
clears handoff/claim metadata and advances the generation; the intent retains
the original request token for replay. An interrupted forward call compensates dependents before the primary,
then returns `swarm_close_compensated`. The exact pre-close item bytes, including
native timestamps, are restored with append-only compensation history.

A restored member's exact native operation receipt survives SIGKILL before the
next progress write. Recovery skips that certified restore, records its missing
progress and continues. The primary restores last; its native history retains
the plan even after restoring away the intent field. Retrying completed
compensation produces no duplicate history. A newer claim generation can start
a fresh close after the prior primary restore is verified.

`swarm_compensation_partial` includes restored and pending IDs. A peer edit or
ABA stops recovery before overwriting the peer. Storage failures retain pending
intent for another retry. The final blocker restore holds native locks on already
restored dependents while validating the domain. Legacy markers, unowned native
closes, malformed intents and mismatched recovery requests still require explicit
inspection with `swarm_close_recovery_unsupported`.

Native episodes are attribution, not ownership proof. The admission hook signs
each exact SDK proposal under its native writer lock and persists the signed
receipt through audited `swarm.close_proofs` workspace settings before the item
commit. Only the public key is retained in the intent; the private key exists
only during fresh forward execution. Before compensation, all signed receipts
are frozen into native item history and their workspace cache is retired. Recovery verifies native stream prefixes,
operation kind, immutable record hashes, exact restore target and progress order.
The original fresh invocation separately signs the complete final result and its
warnings; copying a `committed` phase cannot certify a partial native prefix.
An unrelated same-author close and later writes copying messages or identities
cannot be adopted. A lost warning/result receipt is never manufactured.

Tests cover every diagnostic forward/reverse boundary with one to three native
dependents, ordinary failures, real-process SIGKILL, lost progress writes, peer
writes after decision reads, copied identities, current transfer workflows,
non-Git trackers, canonical short IDs and packed npm/Bun consumers. Revert proofs
and exact gate results are recorded in the linked pm items and PR.
