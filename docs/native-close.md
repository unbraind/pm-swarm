# Native close with bounded compensation

`swarm close` uses one SDK `commitWorkspaceTransaction`: a fenced metadata update,
then native `PmClient.close`. Core owns lifecycle policy, dependent unblocking,
blocker-field removal, Plan completion and native warnings. Swarm reads back the
actual native versions; it does not predict a close successor.

Forward admission captures each native history head before reading the complete
current item, and rechecks that head under the native item lock. Full resulting
documents pass privacy admission. Historical prefixes use public SDK history APIs;
forward admission does not require replaying legacy documents. A peer's history
advance produces `swarm_superseded` and preserves its claim and Git resources.

## Automatic compensation scope

Automatic rollback is supported only when native close changed the primary item
alone. SDK journal identity and checkpoints retain the two reverse mutations and
allow primary-only recovery after interruption or a lost return. Audit history
remains append-only. Ordinary metadata failures before native close also retain
this behavior.

If native close changed a dependent, compensation stops **before any restore**.
The SDK and CLI report `swarm_compensation_partial` with:

- `restored`: members certified by durable rollback progress; empty in this scope.
- `pending`: the primary item and recorded dependents requiring reconciliation.
- `transaction_id`: the existing SDK transaction to inspect.
- `scope_unknown`: true when old or unreadable receipts cannot establish membership.

SDK callers receive typed properties on `CompensationPartialRefusal`. The native
CLI keeps its supported `code` and actionable `required` fields. `required` ends
with `Compensation receipt: ` followed by the same JSON object, preserving a
machine-readable list through the pinned host's error transport.

Pending means uncertified rollback, not a claim about an item's current status.
The native close remains intact, including its reopened dependents. A peer edit is
preserved. Repeated SDK/JSON/TOON retries return the refusal without another item
or history write. A crash before compensation also returns this refusal on retry;
a partial dependent restore from an older package is never silently adopted as
progress. Inspect the native item histories and SDK journal before explicitly
reconciling the affected work.

This intentionally smaller scope replaces the unsafe member-restore loop. The SDK
coordinator persists compensation progress at step boundaries; its current
`compensate(data): Promise<void>` callback has no member-checkpoint operation.
Writing the same journal independently would race its in-memory state. This is a
design constraint, not a claim that durable member steps cannot be implemented.

[Issue 32](https://github.com/unbraind/pm-swarm/issues/32) and
[pm-swarm-durable-compensation](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/issues/pm-swarm-durable-compensation.toon)
own the expanded protocol: unique compensation identity, complete member domain,
pre-close byte digests and post-close heads, fsynced progress, exact restore
ownership checks, and the SIGKILL matrix after every member boundary with 1–3
dependents. Full multi-item restoration is not delivered by this PR.

## Receipts and native warnings

Native warnings are surfaced unchanged. If a crash occurs after native close but
before its result is saved, recovery reports `warnings_unavailable` and asks the
caller to inspect dependent items. Missing secondary receipts never authorize a
restore. SDK identity validation and its journal establish transaction ownership;
free-text messages and matching content do not substitute for a checkpoint.

The source inventory enumerates 24 SDK/backend write sites, including 18 item
writers. Each actual item write uses the shared full-document/history admission
helper. Dependent restoration is absent from the implementation.

## Validation

Real non-Git tracker tests cover native lifecycle equivalence, primary-only crash
and lost-return recovery, 1–3 dependent refusal domains, a real-process SIGKILL at
the pre-restore barrier, repeated retries, and peer edits preserved through SDK,
JSON and TOON refusals. Packed npm and Bun consumers assert the same limited
compensation contract. Privacy refusal/allow corpora, framework routes and the
read-only fleet path oracle remain unchanged.

Exact focused commands and revert proofs are recorded in `pm-swarm-y972`. Full
npm/Bun release, packed-consumer and coverage evidence comes from the current CI
head; pending runs are not represented as passing gates.
