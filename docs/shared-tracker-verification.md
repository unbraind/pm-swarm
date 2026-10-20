# Shared-tracker coordination verification

The feature is tracked in [pm-swarm-shared-tracker](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-shared-tracker.toon), under implementation epic pm-swarm-07o2. The package remains unreleased.

## Design

The command dispatcher checks workspace mode once. It traverses worktree markers before resolving a Git root, so a non-Git tracker path does not spawn Git. Settings bypasses repository detection entirely. Existing Git lanes retain their branch/worktree, diff, merge-prediction and cleanup behavior.

SharedTracker reuses the host-bound Swarm SDK client and certified readiness. A tracker-local SDK operation lease covers selection and claim publication. Both modes use the same priority/age/id ranking, footprint containment checks and unknown-footprint fallback. Shared lanes are claimed items with linked files and claim provenance. They do not persist branch or base fields.

Shared status reports nonterminal claims and declared overlaps, with null claim age where no claim history exists. Git measurements are omitted with an explanatory note. Watch compares claim provenance rather than elapsed age and emits separate overlap events. Sync requires explicit portable files without Git, preserving preview/apply precedence. Land refuses with the Git requirement and the available shared-tracker commands. Reap preserves active and foreign claims and releases terminal claims for the invoking principal.

## Behavioral revert evidence

All proofs ran against real temporary SDK trackers in an isolated source copy using the pinned SDK. Tests import source, so these mutations did not require a dist rebuild.

- Replacing only `runCommand` with its origin/main implementation: 0/9 no-git regressions pass; process exits 1. Every command in the eight-command matrix exits 2, first line `Error: Command failed`, with `git rev-parse failed` in the detail.
- Rebuilding with only `runCommand` reverted, then packing and installing that tarball: the packed non-Git acceptance fails at `next` with exit 2 from the host; the test exits 1.
- Disabling only `SharedTracker.sharedExclusive`: the eight-process contention regression fails, process exits 1, on a real already-claimed race. The SDK still protects individual claim ownership, but the full batch cannot each select and claim its own safe item.
- Reverting only the age-independent comparison in `statusChanges`: the no-git watch regression fails, process exits 1, because age advancement emits spurious `lane_changed` events.

## Acceptance boundaries

The process test starts eight actual `pm swarm next --agent worker-N` processes against one non-Git tracker with eight disjoint declared footprints. It checks eight unique selections, each persisted assignee, JSON parsing of every history line, and strict integrity/history health. Source-loaded fixture extensions are unmanaged, so that fixture's health invocation disables extension discovery; managed packed acceptance separately runs full strict health.

The tarball acceptance installs `./package.tgz` with `pm install --project` in a non-Git tracker and runs next, sync with explicit files, status, terminal stale-claim reap and full strict health under both Node and native Bun. The loop has no Git executable in PATH. The first targeted run passed in 136738 ms.

This proves local shared-directory coordination. Hosted Postgres/MCP coordination and clients that bypass swarm's operation lease are outside this process proof. Ordinary SDK claims remain the per-item ownership authority.

## Command matrix

Measured through native human output in a non-Git tracker with no Git executable in PATH. Before uses the isolated origin/main dispatcher revert; all eight also include the generic `git rev-parse failed` detail.

| Command | Before: exit; first line | After: exit; first line |
| --- | --- | --- |
| plan | 2; `Error: Command failed` | 0; `mode: "shared-tracker"` |
| next --agent worker --dry-run | 2; `Error: Command failed` | 0; `mode: "shared-tracker"` |
| start item --agent worker | 2; `Error: Command failed` | 0; `mode: "shared-tracker"` |
| status | 2; `Error: Command failed` | 0; `mode: "shared-tracker"` |
| sync item --files src,docs --apply | 2; `Error: Command failed` | 0; `mode: "shared-tracker"` |
| land | 2; `Error: Command failed` | 2; `Error: Command failed` |
| reap --dry-run | 2; `Error: Command failed` | 0; `mode: "shared-tracker"` |
| settings | 2; `Error: Command failed` | 0; `swarm:` |

The host's first-line error title remains generic for land; its full diagnostic explicitly says `pm swarm land needs a git repository: landing merges git branches; in shared-tracker mode work is already on the shared tracker` and names next, sync with explicit files, status and reap. Sync without explicit files exits 2 and names `--files a,b`.
