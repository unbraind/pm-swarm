# Fresh native close; recovery requires explicit inspection

`swarm close` resolves the selected ID through the host-bound native `get()` before
reading history. It captures a native history head, reads the complete decision
document, validates ownership, token and privacy, then delegates directly to native
`PmClient.close`. Identity uses the SDK mutation-free first-version projection;
only its immutable ID is consumed. The same head is checked under the native item writer lock.

Pure local refusal checks run before native read bookkeeping. The authoritative
head-before-document admission repeats exactly the same checks; local preflight
never supplies a decision baseline or write document.

Swarm adds no metadata mutation before close. It does not advance the token,
clear the assignee, predict a successor, create a workspace transaction or restore
an item afterward. Core owns the resulting item, Plan behavior, blocker-field
removal, dependent auto-unblocking and native warnings. Dependents have complete
snapshots and history admission; unreadable foreign rows stay unadmitted and core
reports affected dependent failures unchanged.

## Read-only refusal

Any earlier native close, a terminal primary or a legacy `swarm_close_transaction` marker returns
`swarm_close_recovery_unsupported` before acquiring a swarm lease or writing item
state. A lost native return also refuses recovery. SDK callers receive
`CloseRecoveryUnsupported.item_id` and `.journal_entry`; CLI JSON and TOON retain
the code and the remedy naming both in the host's supported `required` field.

The entry is tracker-relative: a native `history/<id>.jsonl` position, or the SDK
transaction entry named by a valid legacy marker. A malformed marker is identified
by its structural field, never interpreted as a filesystem path. The refusal does
not attribute any native close to swarm. Author equality, copied messages,
matching documents and matching tokens never prove ownership.

Previously closed items remain unsupported even after a native reopen or restore.
This conservative rule never tries to decide who owned an earlier close.
Repeated calls leave native items, histories and legacy journals unchanged.
Swarm never resumes close, compensates the primary, restores dependents or repairs
its own missing receipt automatically. Inspect the native item, dependency state
and journal with core commands and reconcile explicitly. Core owns the
assignee and custom-token lifecycle on a closed item; terminal reap follows its separate,
reviewed ownership and history policy.

The current contract deliberately permits only a fresh native operation. Native
closed state is enough to refuse replay even if a prior swarm process died before
returning its receipt. A process killed before any native close committed has no
close mutation to recover; a later fresh command still uses normal native
admission. There is no saved-result adoption or inference from historical authors.

## Deferred protocol

[Issue 34](https://github.com/unbraind/pm-swarm/issues/34) and
[pm-swarm-durable-close-recovery](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-durable-close-recovery.toon)
own journaled multi-item recovery. Acceptance includes durable compensation
identity, exact own-write receipts, native dependent restoration, fsynced progress,
all forward/reverse SIGKILL boundaries, peer edits and byte-identical ABA.
[Issue 32](https://github.com/unbraind/pm-swarm/issues/32) remains the narrower
member-progress subtask. The retired prototype remains reproducible at commit
`0157465`; it is absent from this implementation and package artifact.

## Validation

Tests use real non-Git trackers and native SDK calls. They compare native item and
dependent bytes, retain warnings, refuse legacy same-author close adoption, resolve
service-context short IDs before history selection, inject native lost returns and
ABA, and kill a real process after native close. Read-only retries preserve all
native state. Packed npm and Bun consumers exercise the same reduced contract.

The SDK/backend writer inventory now contains 21 sites, including 15 item writers.
No close restore or workspace-transaction writer remains. Full source coverage
continues to require 100/100/100/100 without ignore pragmas; exact commands, revert
proofs and gate counts are recorded in the pm item and PR.
