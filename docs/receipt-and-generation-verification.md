# Portable receipts and generation-owned recovery

Every CLI command projects its result through `admitReceipt` using the workspace
already resolved before dispatch. Git `start`, `next` and `schedule` therefore
share the same portable worktree coordinate and both host renderers. Scheduling
admits its complete prospective decision rows before acquiring any claim or
creating a branch or worktree. The SDK retains its established local filesystem
coordinates; embedders can use the exported projection and admission helpers for
shared output without changing the target directory.

Only a top-level relative `worktree` is an operator coordinate. Private content in
IDs, decisions, notes, nested documents and all other fields still goes through
the existing SDK-first privacy gate. Literal relative folders resembling URI or
home aliases receive an explicit relative anchor; projection preserves their
filesystem target. Different-drive absolute Windows coordinates are never
misrepresented as relative. No post-acquisition repository lookup is needed.

The committed compatibility fixture contains receipts actually emitted by public
`pm-swarm@2026.10.15`, installed with host 2026.10.23 after registry integrity
verification. Its provenance and SHA512 are in `test/fixtures/legacy-receipts.json`.
Only the disposable operator-home prefix was replaced with a placeholder. The
default and spaces/Unicode root receipts preserve their domain fields and remain
renderable in JSON and TOON. Live home-directory fixtures cover all three lane
commands as well as the SDK's existing absolute-coordinate contract.

Recovery ownership is the exact acquired `swarm_token`, not merely the author,
assignee or a copied message. Native acquisition history establishes that token;
the current item and every intervening history transition must retain it. An ABA
transition also supersedes the old acquisition. A nested writer cannot overwrite
the native generation proof by replacing mutable callback metadata.

Item rollback rechecks that generation inside `commitItemMutation` and the SDK's
locked `beforeMutation` hook. Acquisition rollback and terminal Git reaping share `guardItemCleanup`, which
runs inside public SDK `mutateItem`:
`pmRoot`, settings, id, author, `op: 'update'`, `skipNoop: true`, and a `mutate`
callback. The callback checks generation and the whole document before touching
Git; returning no changed fields writes no item or history event. The outer
lease releases last. Git configuration removal additionally uses the fixed-value
compare-and-set form, while branch deletion retains its expected object id.
A peer generation yields typed `swarm_superseded` with a preservation remedy.
Close compensation retains SDK journal identity and additionally checks the
current generation before its native restore. There is no free-text ownership
inference and no new SDK gap.

The deterministic generation seed is `0xf37c9a21`; generated counters exceed the
safe-number ceiling and remain exact strings. Adversarial coverage includes:

| Matrix | Cases |
| --- | ---: |
| Git start/next/schedule × seven acquisition boundaries | 21 |
| Shared start/next/schedule/resource × four boundaries on one non-git tracker | 16 |
| Git rollback × three locked mutation boundaries | 6 |
| Git/shared terminal cleanup × three locked mutation boundaries | 6 |
| Same-author fixed-generation lost returns | 4 |
| Independent-process lost return; ABA; nested writers; existing claim | 5 |
| Journal compensation boundaries with independent processes | 2 |

Independent process tests also prove that the SDK item lock excludes a writer
at the actual Git cleanup command for both rollback and reaping, and that retry
succeeds after lock release.
A raw Git peer changing configuration between read and unset retains its value.
Byte comparisons cover peer item/history and Git resources. No-op cleanup tests
require exactly claim/release history and prohibit an extra update event.

The native mutation inventory now includes 24 routed write calls; the five-source
sink property checks 120 refused writes with unchanged durable tracker bytes.
Existing private-content and benign corpora, real fleet paths, decoder and
normalization fuzz remain in the release suite. Packed npm and Bun consumers run
live next/schedule in JSON and TOON and independent-process same-author successor
cases in fresh non-git trackers. Full release evidence is the final-head CI run
linked in the PR, at unchanged 100/100/100/100 thresholds and at most two workers.

Focused commands, behavioral revert results and final static checks are recorded
on the linked PM item. Previous recovery probes remain documented separately in
[journal-and-acquisition-verification.md](journal-and-acquisition-verification.md).

## Behavioral revert evidence

Each probe restores only the relevant production function or changed check,
runs the named adversarial test, and restores the exact source bytes in a finally
block. All ten probes exit 1: **40 reported results, 35 expected failures and five
passing controls**, with no cancelled or skipped results.

| Reverted behavior | Passed / failed |
| --- | --- |
| projection | 2 / 1 |
| schedule-preflight | 0 / 1 |
| operator-coordinate | 1 / 1 |
| generation | 0 / 9 |
| native-git-lock | 0 / 1 |
| noop-history | 0 / 3 |
| config-cas | 0 / 1 |
| locked-generation | 2 / 15 |
| native-generation-proof | 0 / 2 |
| preexisting-generation | 0 / 1 |

The terminal cleanup audit adds three isolated revert probes: removing the common
native lock fails both independent-process cases (0/2 pass); removing only shared
terminal release generation admission gives 4/8 passing controls and four
failures; restoring unconditional terminal Git configuration removal gives one
passing acquisition control and one terminal failure. All sources are restored
exactly. Combined this continuation has **13 probes, 52 reported results, 42
expected failures and ten passing controls**, with zero skips/cancellations.

The pinned PM linked broad integration passes **96/96** (329135.681442 ms).
The subsequent restored terminal checks pass **12/12**, and the final linked
cleanup/sink run passes **20/20** (66488.283977 ms), all without failures, skips,
cancellations or todo results. Typecheck and lint pass; duplication is zero
(0/12468 lines across 119 sources), and all 169 declarations in 37 authored
files are documented. Full-suite coverage and packed acceptance are reported
separately from final-head CI in the PR.
