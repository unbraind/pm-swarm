# Native history fencing

Every item mutation captures the native SDK history head before reading its
complete decision document. The guard compares that monotonic length and prefix
hash again inside the same native writer lock that performs the mutation.
Document equality or a `swarm_token` alone cannot detect release/claim/restore
ABA: a peer can recreate the same bytes and token while history still advances.
A changed head produces `swarm_superseded` and preserves the peer's claim.

IDs are resolved through the exact host-bound native `get()` before selecting a
history stream, including short IDs and service-capable contexts. Identity-only
resolution is separate from the authoritative decision read after the baseline.
It never refreshes a baseline after reading a decision document.

| Mutation | Guard |
| --- | --- |
| Shared and Git start, sync, handoff | Native canonical identity, head-before-document snapshot and locked full-document admission |
| Resource reserve, renew, publish, release | Same canonical snapshot and native writer guard |
| Plan witness | Bound native identity plus the same admission; revision conflicts re-evaluate from a fresh decision |
| Acquired-claim release | Exact native acquisition version, observed own successors and current history head |
| Git cleanup | The native item lock spans the head check and branch/worktree deletion |
| Fresh close | One native close with primary and related-item admission; no automatic recovery |

Cleanup may advance only through successors this invocation observed from native
commit hooks. Unobserved history, copied messages or restored preimages never
prove ownership. Every deletion or release checks the exact fencing generation and
its native history while retaining the lock until the operation finishes. Private
or unreadable foreign records remain preserved with a reason.

All native receipt comparisons use the SDK `stableValueEquals` admission helper;
complete document fingerprints normalize read projections on both sides. Private
content is validated on the complete resulting document and history payload before
writes and before shared rendering. Operator tracker coordinates remain inputs.

The source inventory in `test/privacy-sinks.test.ts` enumerates **21 SDK/backend
writers**, including **15 item writers**, and checks their shared admission and
native history preconditions. New writers must join the inventory. There is no
swarm close workspace transaction, phase reconstruction, primary compensation or
dependent restore. [Native close](native-close.md) explains the read-only
`swarm_close_recovery_unsupported` contract and its deferred Feature.

Tests use real native SDK operations in one non-Git tracker. They inject peer
release/claim/restore sequences at admission boundaries, preserve byte-identical
peer state, verify the SDK lock excludes independent cleanup writers, and cover
native close separately from the retired recovery prototype. Installed SDK-copy,
privacy refusal/allow and packed npm/Bun acceptance remain part of the release
gates. Exact current counts and behavioral revert proofs live in `pm-swarm-y972`.
