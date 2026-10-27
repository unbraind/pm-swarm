# Native-history compare-and-set for mutations

A release, re-claim and restore can recreate precisely the same item bytes,
assignee and `swarm_token`. Equality of those fields proves neither ownership
lineage nor that a checked snapshot is current. Every item mutation therefore carries two
independent preconditions: the existing complete-document/generation checks and
an append-only native-history revision.

`historySnapshot` binds the reconstructed SDK document to the stream length and
`hashHistoryStream` of its native records. The expected revision travels unchanged
from that snapshot into `commitItemMutation`. Its `beforeMutation` hook re-reads
history while the SDK holds the item's native writer lock, before the write.
The no-op `mutateItem` callback used for Git cleanup performs the same check
inside that lock before any branch, worktree or configuration deletion. Its
`skipNoop` behavior still prevents an extra item/history mutation.

Any length or record-hash mismatch produces typed `swarm_superseded`, field
`history`, with a remedy to preserve the peer claim/resources and refresh native
history. A document's `after_hash` alone is insufficient because it repeats after
a restore. The SDK hashes the complete immutable stream. No package history
writer, alternate lock or free-text ownership proof is introduced.

| Audited writer | Revision source and locked check |
| --- | --- |
| Git metadata rollback | `acquisitionSnapshot` head; native mutation hook |
| Git/shared failed-claim release | `acquisitionSnapshot` head; native release hook |
| Git rollback resource deletion | Same snapshot head; native `mutateItem` callback |
| Reservation rollback | Native acquisition snapshot; native update hook |
| Git terminal resource deletion | Fresh verified recovery snapshot; locked callback |
| Git/shared terminal release | Same recovery head; native release hook |
| Stale-claim recovery transfer | Fresh verified recovery snapshot; native update hook |
| Journal close compensation | Journal-verified native snapshot; native restore hook |

The original cleanup audit covered eight SDK sites. The source inventory now
requires a history precondition at all 19 item writer sites among
25 SDK/backend writer sites. Every new item writer must join the inventory.
[Native close admission](native-close.md) documents the added forward writes and
core dependent lifecycle updates. The journal remains SDK-owned and its
persisted checkpoint format remains version/hash, retaining interrupted-close
compatibility. Native heads are ephemeral preconditions rather than new markers.
Foreign missing, divergent or unreadable state is preserved with a skip reason.
Existing content-only peer edits already included in a fresh cleanup snapshot
remain preserved; native release/claim/restore ownership transitions invalidate
acquisition lineage even when their final content is identical.

The pinned SDK 2026.10.23 publicly exports:

- `readHistorySnapshot(historyPath, itemId): Promise<HistoryStreamSnapshot>`;
- `readHistoryEntries(historyPath, itemId): Promise<HistoryEntry[]>`;
- `hashHistoryStream(entries: readonly HistoryEntry[]): string`;
- transactional `beforeMutation` hooks and async `mutateItem` callbacks.

The native item lease spans both the mutation callback and hook. Calling these
public history readers there supplies the necessary locked read. There is no
blocking SDK gap. [pm-cli#1576](https://github.com/unbraind/pm-cli/issues/1576)
tracks a built-in expected-revision API that would remove this package adapter.

The seeded property uses `0xaba47129` separately in each runner. It composes legal
release/claim/restore walks with varying order and intermediate restores, then
restores the original native version. Each peer must recreate byte-identical
item content while increasing history length. After the failed command, item
and history bytes must equal the peer's successful result; Git references,
worktrees and configuration must also remain equal before checking the refusal.

| Full-suite matrix definition | Interleavings |
| --- | ---: |
| Shared start/next/schedule/reserve × three admission boundaries on one non-git tracker | 12 |
| Git start/next/schedule × metadata/resources/release cleanup × three boundaries | 27 |
| Git start/next/schedule × seven acquisition transitions | 21 |
| Git/shared terminal cleanup × three boundaries | 6 |
| Git/shared stale recovery × three boundaries | 6 |
| Two journal compensation phases × three boundaries | 6 |
| Forward close: transaction/metadata/native close × three admission boundaries | 9 |
| Native dependent close updates × three admission boundaries | 3 |
| All seven native item mutation kinds × three admission boundaries | 21 |
| Independent-process writer attempts during Git rollback/reaping, then successful retries | 2 |

The final row probes the actual Git command while the SDK lock is held. A real
separate SDK process uses zero lock wait; it must be blocked there and succeed
after lock release. Other rows admit real SDK peer transitions immediately before
the native write. No SDK read, mutation or return value is fabricated.

Packed npm and Bun consumers retain all earlier commands and checks and add two
byte-identical native-history ABA cases each: shared and resource acquisition.
The source and packed gates retain at most two test workers and unchanged
100/100/100/100 coverage thresholds. Exact focused commands, measured results and
isolated behavioral revert proofs are recorded on `pm-swarm-y972`; final-head
full-suite evidence is linked in PR 24.

Four isolated behavioral revert probes produce **77 reported results: 68 expected
failures and nine passing controls**, with zero skips/cancellations. The common
head guard gives 44 failures/three controls; the Git callback gives eight/six;
the reclaim revision handoff gives eight/zero; the native-lineage refusal
category gives eight/zero. Exact source bytes are restored after each probe.

Reverting only the foreign recovery-admission function adds three expected
failures; restoring it passes 3/3. This continuation therefore records **five
probes, 80 reported results, 71 expected failures and nine controls**. The final
pinned PM focused command passes **70/70** (351524.236546 ms), with zero failures,
skips, cancellations or todo results; exact commands are linked on the item.
Typecheck, lint, zero duplication (0/12804 lines, 123 sources) and documented
declarations pass. Complete release and packed evidence remains a final-head CI
check rather than a local full-suite claim.
