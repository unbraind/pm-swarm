# pm-swarm

Parallel agents need a claimed item, a separate branch, and evidence that their work can land. pm-swarm joins pm's context and claims with Git worktrees and real merge simulations. It never pushes.

Install with a current pm host (Node 22.18 or later, Git with `merge-tree --write-tree`). This new package stays unreleased until maintainer approval. After publication:

```sh
pm install pm-swarm --project
npm install pm-swarm @unbrained/pm-cli
bun add pm-swarm @unbrained/pm-cli
npx pm install pm-swarm --project
bunx --bun pm install pm-swarm --project
```

For local review, build and pack this checkout, then `pm install ./pm-swarm-2026.10.15.tgz --project` in a scratch repository. npm and Bun dependencies alone do not activate project extensions; use `pm install` to register it.

| Command | Example | Behavior |
| --- | --- | --- |
| plan | `pm swarm plan --parent project-id --limit 3` | Certified full corpus, SDK readiness and claim view, safe parallel waves |
| next | `pm swarm next --agent worker --parent project-id` | Pick the best safe ready item and claim/create its lane; `--dry-run` previews the choice and skips |
| start | `pm swarm start task-id --agent worker --base main --root ../lanes` | Claim, create worktree and branch, record portable fields; warn on overlaps, or refuse with `--strict` |
| status | `pm swarm status` | Conflicting pairs and clean pair count; `--full` includes every SHA/tree; active branches, ahead/behind current target, changed files, drift, pair and base-tip predictions |
| status --watch | `pm swarm status --watch --interval 2 --json` | Stream lane and conflict changes as JSON lines (TOON blocks by default); stop with Ctrl-C |
| sync | `pm swarm sync task-id --dry-run` | Preview changed-file links; `--apply` writes through the SDK |
| land | `pm swarm land` | Search real sequential merges; `--execute` runs linked tests and merges locally |
| reap | `pm swarm reap --dry-run` | Preview cleanup; omit flag to remove merged terminal lanes |
| settings | `pm swarm settings --base main --root ../lanes --branch-prefix swarm/ --limit 4 --apply` | Preview or apply the `swarm` settings section through the SDK |

The agent loop is `next` → work → `sync` → `land`:

```sh
pm swarm next --agent worker --parent project-id --dry-run
pm swarm next --agent worker --parent project-id
# Use the printed worktree and branch, edit, test, and commit your work.
pm swarm sync task-id --agent worker --apply
pm swarm status --watch --interval 2
pm swarm land --json
pm swarm land --execute
```

`next` uses the same certified corpus and SDK dependency readiness as `plan`, excluding existing lanes and both own and foreign claims. It selects known footprints that do not intersect any nonterminal lane's declared footprint or actual changed paths, measured with Git from the current target's merge base. Priority sorts ascending (0 first), then creation time ascending (oldest first), then item ID. A lower priority safe item beats a higher priority overlapping item. Output includes the selection reason and skipped candidates with overlapping lane IDs and paths. `--parent` selects direct children. Selection and start share a repository operation lease; the SDK claim is the final ownership check.

Unknown candidate footprints are deferred until no known safe item exists, then started with an explicit warning. An active lane with neither linked nor changed paths cannot establish safety and blocks known candidates conservatively. When no eligible item remains, `selected` is null and no lane is created. `--dry-run` makes no claim, item/history edit, branch, worktree, or local Git configuration change. Normal host SDK read caches may still be refreshed. `next` uses the configured base, root and branch prefix, just as `start` does.

`start` includes `overlap_warnings`, naming each active lane and the candidate and lane paths. The default still starts successfully; `pm swarm start task-id --strict` refuses overlaps before claiming or creating a worktree. These checks prevent obvious overlapping edits; real merge predictions remain available through `status` and `land`.

`status --watch` emits initial lanes/conflicts as additions, then only changes: `lane_added`, `lane_changed`, `lane_removed`, `conflict_predicted`, `conflict_changed`, and `conflict_resolved`. Ahead/behind counts, changed files and footprint drift participate in lane comparisons. Repeated identical polls emit nothing. The default interval is two seconds; smaller positive requests are clamped to two seconds, and values above 86400 seconds or nonfinite/nonpositive values are rejected. `--interval` requires `--watch`. Ctrl-C exits successfully and clears the pending timer. Watch reads local refs without fetching; fetch remote work explicitly when needed. TOON blocks are separated by blank lines; `--json` emits one event per line. Watch uses the host-pinned SDK codec, keeping the package free of runtime dependencies.

Each planning wave contains mutually compatible items. The first wave is the suggested start set. Every incompatible pair carries its separation reasons: equal or containing paths, dependencies, or an unknown footprint. Missing file links always mean `footprint: unknown`, with a solitary wave. Capacity is enforced independently by `--limit`. The SDK excludes blocked work and unfinished containers; only open and unclaimed items start in a plan. `--parent` selects direct children. Readiness is advisory: the SDK claim is the atomic ownership check when starting.

`start` registers `swarm_branch`, `swarm_base` (the original commit SHA), and `swarm_base_ref` (the moving target ref). Defaults are base `main`, worktree root `../.pm-swarm`, branch prefix `swarm/`, lane limit 4. Flags override settings. Planning supports limits 1–8; landing searches up to eight active lanes exhaustively and refuses larger batches explicitly.

Absolute worktree paths live only in repository-local Git config (`swarm.lane.<id>`). Never put machine paths into tracker fields, comments, or settings. A persisted root setting must be relative; an absolute `start --root` override remains local. Worktree paths may appear in command output. If the lane root is inside the repository, ignore that directory before landing so the base worktree stays clean. Existing absolute linked paths are rejected so sync cannot persist them. Keep `.agents/pm/extensions/` ignored: the host package installer records local tarball provenance there.

All package Git operations strip inherited Git location variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_NAMESPACE`, and `GIT_PREFIX`). The explicit repository directory determines the target, including linked worktrees; hook environment variables cannot redirect operations to a parent or unrelated repository. Other Git configuration and identity variables remain available.

Git's low-level configured pm merge drivers participate in `merge-tree --write-tree` on the tested Git version. The real-repository regression merges two SDK comments into the same item and history; both survive in the resulting tree. Replacing the item driver with a failing command produces an item-path conflict. Tracker conflicts are retained as `tracker_conflicts`, never silently waived. `start` and `status` warn via `missing_merge_drivers` when required config is absent. Install drivers with `pm merge install`. Predictions execute configured repository merge drivers, as normal Git merges do; run only in repositories you trust.

Status compares each lane with its current target tip and each other lane. Each prediction includes `left_id`, `left_branch`, `right_id`, `right_branch`, conflicting files, an explicit `clean` result from Git's exit status, and informational `messages`; the current target is identified as `base`. Conflicts with no individual paths remain visible with their messages. Default output shows conflicting pairs plus `clean_pairs`; `pm swarm status --full` includes all pairs, commit SHAs, and merge trees. Changed files are measured from the merge base of the current target tip and lane tip, so inherited base updates do not become agent footprints. The recorded starting SHA preserves lane provenance. Drift means a changed path has no linked equal or containing footprint. Git simulations write unreferenced objects, without changing branches, index, or worktree files.

Landing backtracks through simulated merge commits, preserving ancestry at each step. If no complete order succeeds, `order` is the largest clean landable subset, with sorted item IDs breaking ties deterministically. `conflicting_set` remains a minimum-cardinality unlandable subset against the base. `blocked` names each remaining lane, conflicting files, Git messages, peers, and a suggested next step such as `rebase swarm/task-b after swarm/task-a lands`. `pm swarm land --execute` merges only the clean order and leaves blocked branches and worktrees untouched; partial results still exit 1. Execution requires the configured base checked out and clean, all lane targets equal to that base, unchanged refs, nonempty linked tests, and every SDK linked-test result passing. Tests run on each simulated merged tree in a temporary worktree through the host's normal trust and sandbox policy. The pinned host uses `GITHUB_HEAD_REF`, then `GITHUB_REF_NAME`, before the local Git branch when deciding source-ref trust; CI flags alone do not grant trust. Foreign-ref commands require explicit clone-local acknowledgement. Tests explicitly exercise refused, acknowledged, and matching hosted-ref states. Refused, skipped, or empty tests block landing. No automatic dependency installation occurs in verification worktrees. All tests are preflighted before the first local merge; unexpected Git failures can still leave earlier merges committed. Inspect and resume explicitly. There is no push. Under `bunx --bun`, Bun supplies the `node` shim; author Bun suites as `bun test`, or provide the intended Node executable in the linked command.

Reaping requires the item to have a closed or canceled status, or an SDK terminal status. Branch ancestry must also prove it is merged into its target. Dirty worktrees, mismatched worktree registrations, active items, and unmerged branches are preserved. `start`, `sync`, and `reap` accept `--agent` to select the invoking principal. Only the invoking principal's stale claim is released; foreign claims remain intact. Reaping detects missing lane directories and removes only their stale registrations, preserving unrelated worktree records. A leftover directory is removed only at its expected location inside the configured swarm root, with a worktree marker pointing to a missing registration in this repository. Arbitrary directories, symlink redirections, locked worktrees, and paths outside that root are refused and preserved. The result reports `cleanup` actions and `refused` reasons; dry runs preview these actions. A local `start --root` override must match the configured root before reaping. Reaping does not delete tracker items.

Successful commands exit 0. An unlandable set exits 1. Invalid input, ownership refusal, failed Git operations, or failed linked tests use the host's expected-error exit (normally 2). Host rendering supports TOON by default and `--json`. Plans always certify complete SDK reads and fail closed. Default output omits `complete_list` and `read_output`; use `pm swarm plan --full` or `pm swarm plan --json` to retain those receipts and their token estimate. Status and land also accept `--full` for detailed output.

For CI, install dependencies and register the extension, then inspect predictions without executing merges:

```sh
pm swarm plan
pm swarm plan --full
pm swarm status
pm swarm status --full
pm swarm land --json
```

`status` reports conflicts without failing the process; `land` supplies the conflict exit gate. For package development, run `npm run release:check` and `bun run release:check` with isolated HOME and Git configuration. CI verifies tracker health, commit identity, TypeScript, lint, duplication, docstrings, four 100% coverage dimensions, production audit, package allowlist, generated changelog, release attestation and packed npm/native Bun consumers. Packed acceptance extracts `npm pack`, installs the directory with `pm install <dir> --project` into fresh Git repositories and trackers, and checks real host commands through Node, npx, Bun and bunx, including TOON/JSON watch shutdown. A built artifact import check rejects dependencies outside Node built-ins and the pm SDK. Release has only a manual trigger plus an approval variable; scheduled publication stays disabled.
