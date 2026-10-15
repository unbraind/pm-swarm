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
| start | `pm swarm start task-id --agent worker --base main --root ../lanes` | Claim, create worktree and branch, record portable fields |
| status | `pm swarm status --json` | Active branches, ahead/behind current target, changed files, drift, pair and base-tip predictions |
| sync | `pm swarm sync task-id --dry-run` | Preview changed-file links; `--apply` writes through the SDK |
| land | `pm swarm land` | Search real sequential merges; `--execute` runs linked tests and merges locally |
| reap | `pm swarm reap --dry-run` | Preview cleanup; omit flag to remove merged terminal lanes |
| settings | `pm swarm settings --base main --root ../lanes --branch-prefix swarm/ --limit 4 --apply` | Preview or apply the `swarm` settings section through the SDK |

Each planning wave contains mutually compatible items. The first wave is the suggested start set. Every incompatible pair carries its separation reasons: equal or containing paths, dependencies, or an unknown footprint. Missing file links always mean `footprint: unknown`, with a solitary wave. Capacity is enforced independently by `--limit`. The SDK excludes blocked work and unfinished containers; only open and unclaimed items start in a plan. `--parent` selects direct children. Readiness is advisory: the SDK claim is the atomic ownership check when starting.

`start` registers `swarm_branch`, `swarm_base` (the original commit SHA), and `swarm_base_ref` (the moving target ref). Defaults are base `main`, worktree root `../.pm-swarm`, branch prefix `swarm/`, lane limit 4. Flags override settings. Planning supports limits 1–8; landing searches up to eight active lanes exhaustively and refuses larger batches explicitly.

Absolute worktree paths live only in repository-local Git config (`swarm.lane.<id>`). Never put machine paths into tracker fields, comments, or settings. A persisted root setting must be relative; an absolute `start --root` override remains local. Worktree paths may appear in command output. Existing absolute linked paths are rejected so sync cannot persist them. Keep `.agents/pm/extensions/` ignored: the host package installer records local tarball provenance there.

Git's low-level configured pm merge drivers participate in `merge-tree --write-tree` on the tested Git version. The real-repository regression merges two SDK comments into the same item and history; both survive in the resulting tree. Replacing the item driver with a failing command produces an item-path conflict. Tracker conflicts are retained as `tracker_conflicts`, never silently waived. `start` and `status` warn via `missing_merge_drivers` when required config is absent. Install drivers with `pm merge install`. Predictions execute configured repository merge drivers, as normal Git merges do; run only in repositories you trust.

Status compares each lane with its current target tip and each other lane. Changed files are measured from the merge base of the recorded starting SHA and lane tip. Drift means a changed path has no linked equal or containing footprint. Git simulations write unreferenced objects, without changing branches, index, or worktree files.

Landing backtracks through simulated merge commits, preserving ancestry at each step. If no order succeeds, `conflicting_set` is a minimum-cardinality unlandable subset against the base, not merely a list of every overlapping pair. Execution requires the configured base checked out and clean, all lane targets equal to that base, unchanged refs, nonempty linked tests, and every SDK linked-test result passing. Tests run on each simulated merged tree in a temporary worktree through the host's normal trust and sandbox policy. Refused, skipped, or empty tests block landing. No automatic dependency installation occurs in verification worktrees. All tests are preflighted before the first local merge; unexpected Git failures can still leave earlier merges committed. Inspect and resume explicitly. There is no push. Under `bunx --bun`, Bun supplies the `node` shim; author Bun suites as `bun test`, or provide the intended Node executable in the linked command.

Reaping requires closed/canceled (or SDK terminal) status and branch ancestry proving it is merged into its target. Dirty worktrees, mismatched worktree registrations, active items, and unmerged branches are preserved. Only the invoking principal's stale claim is released; foreign claims remain intact. Reaping does not delete tracker items.

Successful commands exit 0. An unlandable set exits 1. Invalid input, ownership refusal, failed Git operations, or failed linked tests use the host's expected-error exit (normally 2). Host rendering supports TOON by default and `--json`; retain `complete_list` and `read_output` evidence from plans.

For CI, install dependencies and register the extension, then inspect predictions without executing merges:

```sh
pm swarm plan --json
pm swarm status --json
pm swarm land --json
```

`status` reports conflicts without failing the process; `land` supplies the conflict exit gate. For package development, run `npm run release:check` and `bun run release:check` with isolated HOME and Git configuration. CI verifies tracker health, commit identity, TypeScript, lint, duplication, docstrings, four 100% coverage dimensions, production audit, package allowlist, generated changelog, release attestation and packed npm/native Bun consumers. Release has only a manual trigger plus an approval variable; scheduled publication stays disabled.
