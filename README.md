# pm-swarm

Coordinate dozens of agents on one pm tracker, with renewed heartbeats, fenced ownership, dead-agent recovery and context handoff. pm-swarm uses SDK readiness, dependencies and declared file footprints to choose parallel work and show overlaps. Agents can share a plain directory and the same tracker. Git worktree lanes add optional branch isolation and merge prediction when the workspace is a Git worktree. It never pushes.

Install with PM CLI/SDK 2026.10.23 or later (Node 22.18 or later). Git lanes additionally require Git with `merge-tree --write-tree`. This new package stays unreleased until maintainer approval. After publication:

```sh
pm install pm-swarm --project
npm install pm-swarm @unbrained/pm-cli
bun add pm-swarm @unbrained/pm-cli
npx pm install pm-swarm --project
bunx --bun pm install pm-swarm --project
```

For local review, build and pack this checkout, then `pm install ./pm-swarm-2026.10.15.tgz --project` in a scratch pm project, with or without Git. npm and Bun dependencies alone do not activate project extensions; use `pm install` to register it.

| Command | Example | Behavior |
| --- | --- | --- |
| plan | `pm swarm plan --parent project-id --limit 3` | Certified full corpus, SDK readiness and claim view, safe parallel waves |
| next | `pm swarm next --agent worker --parent project-id` | Pick the best safe ready item and claim its lane; `--dry-run` previews the choice and makes no changes |
| start | `pm swarm start task-id --agent worker --base main --root ../lanes` | Claim a shared lane; in Git, also create a worktree and branch; warn on overlaps, or refuse with `--strict` |
| status | `pm swarm status` | Assigned lanes and declared overlaps without Git; in Git, conflicting pairs and clean pair count; `--full` includes every SHA/tree; active branches, ahead/behind current target, changed files, drift, pair and base-tip predictions |
| status --watch | `pm swarm status --watch --interval 2 --json` | Stream lane and conflict changes as JSON lines (TOON blocks by default); stop with Ctrl-C |
| sync | `pm swarm sync task-id --files src/a.ts,src/b.ts --dry-run` | Preview explicit changed-file links, or derive them from Git; `--apply` writes through the SDK |
| heartbeat | `pm swarm heartbeat --agent worker` | Renew agent liveness; optional item ID plus `--token` verifies a held generation |
| reclaim | `pm swarm reclaim --stale-after 120 --to recovery-worker` | Atomically return stale claims to the open pool (omit `--to`) or transfer them with recovery evidence |
| handoff | `pm swarm handoff task-id --agent worker --token 1 --to reviewer --note "Tests linked; review parser"` | Atomically transfer ownership and compact context; shared-tracker receiver obtains it from `next` |
| close | `pm swarm close task-id --agent worker --token 1 --note "Tests pass"` | Fence, finish and release a shared claim in one mutation |
| progress | `pm swarm progress PLAN_ID --orchestrator coordinator` | Read revision-bound claimed, produced, reviewed and accepted Plan evidence; explicit witness writes use `--apply` |
| resource | `pm swarm resource resource-id --action reserve --ttl 300 --agent worker` | Exclusive non-file resource lease; status, renew, publish and release share the same tracker fence |
| land | `pm swarm land` | Search real sequential merges; `--execute` runs linked tests and merges locally |
| reap | `pm swarm reap --dry-run` | Preview terminal claim release; in Git, also remove merged terminal lanes |
| settings | `pm swarm settings --base main --root ../lanes --branch-prefix swarm/ --limit 4 --apply` | Preview or apply the `swarm` settings section through the SDK |

## Settings and compact output

The `swarm` section in the SDK-owned settings document has these defaults:

| Setting | CLI flag | Default |
| --- | --- | --- |
| `base` | `--base` | `main` |
| `root` | `--root` | `../.pm-swarm` |
| `branch_prefix` | `--branch-prefix` | `swarm/` |
| `lane_limit` | `--limit` | `4` (integer 1–8) |
| `progress_orchestrator` | `--progress-orchestrator` | unset |

Flags override individual configured values. Preview is the default; `--apply`
writes through the host's audited settings transaction. The freshly locked
section is patched so competing updates and foreign settings survive. Stored
roots must be relative. Invalid values return `swarm_settings_invalid` with a
remedy and exit 2. Example:

```sh
pm swarm settings --root ../lanes --branch-prefix work/ --limit 2
pm swarm settings --root ../lanes --branch-prefix work/ --limit 2 --apply --operation-id configure-lanes-v1
pm swarm settings --json
pm swarm plan --limit 1
```

For embedded hosts, `settings`, `resolveSwarmSettings`, `swarmSettingsSection`,
`updateSettings` and `SettingsRefusal` expose the same typed surface. Pass the
injected host SDK into `updateSettings`; reuse `operationId` only to retry the
same intent. `start --base/--root/--branch-prefix` override Git lane settings
for that invocation. `plan --limit` overrides planning capacity.

The pinned SDK has no extension settings-section registration API and its
normalized reader omits extension-owned sections. The package therefore uses
public SDK file APIs under the audited mutation lock. Native host registration
remains pending SDK support; see [verification and SDK gap](docs/settings-and-quality-gates.md).

All swarm commands register scoped TOON/JSON host rendering. JSON is compact;
TOON planning omits full read receipts unless `--full` is supplied. Absolute local filesystem
paths in nested result values, keys, watch events or errors trigger a typed
`swarm_private_path` refusal. Replace them with project-relative paths. CLI Git
worktree locations are relative to the project root.

Private input is checked before any swarm dispatch or writer lease, including
notes, flags, settings and SDK mutation arguments. The pinned SDK privacy scanner
runs first; canonical POSIX and Windows root checks also refuse non-home paths.
Relative paths, framework route folders and HTTP(S) URLs remain supported.
Path punctuation is preserved inside whole tokens; only edge wrappers are removed.
Coordination leases keep renewing during validation, while persistent principal
liveness is announced after a successful write or completion. Use
`pm swarm heartbeat` separately when a long queue needs background liveness.
Refusal tests cover every registered mutator. Cold SDK reads can still create
derived caches; see the documented SDK read-effect limit and the
[per-encoding oracle results and byte-invariance proof](docs/privacy-admission.md).

## Without git

Plan progress reads and witness declarations, plus resource status, reservation, renewal, publication and release work in plain trackers and never invoke Git, including when Git is absent from PATH. Git worktree planning and branch landing require Git. See the resource example below for an independent resource loop alongside item claims.

The primary agent loop is `next` → heartbeat while working → `sync --files --token` → `close --token`. Run `pm init` in a plain directory and install the extension there. Mode is detected once per invocation; non-Git workspaces return `mode: shared-tracker`. `settings` works without repository detection. The tracker commands do not start Git in this mode, including when Git is absent from PATH.

```sh
pm swarm plan
pm swarm next --agent worker --dry-run
pm swarm next --agent worker --json
# Retain selected and token from this response. The token below is illustrative.
pm swarm heartbeat task-id --agent worker --token 1
# Edit and test in the shared workspace.
pm swarm sync task-id --agent worker --token 1 --files src/a.ts,test/a.test.ts --apply
pm swarm status --watch --interval 2
pm swarm close task-id --agent worker --token 1 --note "Tests pass"
pm swarm reap --agent worker --dry-run
pm swarm reap --agent worker
```

Shared lanes are all items with a nonblank assignee, including items with SDK claims made inside or outside swarm, except items tagged `swarm-resource`. Assigned-only items also block overlapping selection. `start` records fenced ownership and the linked footprint through the SDK, without branch or base fields. Selection and shared writes enter an ordered request queue and hold a tracker-local operation pin, with a 30-second lease renewed every five seconds during long mutations. Expiry refuses a resumed writer before its next SDK mutation. The pin is never stolen from a live process during an awaited SDK write; a killed process releases it through the next caller's recovery check. Contention retries use jittered backoff, bounded at five minutes, and exhausted contention fails explicitly. A hung but live process blocks other mutations until it finishes or is terminated.

Each shared claim persists a monotonically increasing decimal `swarm_token` and claim timestamp atomically with its assignee. `next` and `start` return `token`; keep that exact string and pass `--token` to shared `sync --apply`, `handoff` and `close`. A stale or missing token is refused with typed `StaleFenceError` / CLI code `swarm_stale_fence` before changing item data. Reusing an author ID after a takeover does not make its old token valid. Embedded `SharedTracker` instances remember the tokens they issue; separate CLI invocations require the explicit token. Legacy claims without a swarm token retain ordinary SDK ownership checks. Plan excludes candidates overlapping active assigned items and places unknown footprints in solitary waves; unknown work is deferred when active lanes prevent a safe planning recommendation. `next` retains its explicit unknown-footprint fallback. Claims made by tools outside swarm do not participate in its multi-item footprint lease; recheck status before editing.

`status` lists nonterminal assigned items with their agent, linked files, claim timestamp and age in seconds. Assignments without valid claim provenance have null age. It shows declared overlaps, including unknown footprints, and a one-line note explaining that Git ahead/behind and merge predictions are unavailable. Watch adds `overlap_detected`, `overlap_changed` and `overlap_resolved` events. Age advancing alone emits no change.

`sync` requires `--files a,b` without Git. Paths must be relative to the project; `--apply` links them through the SDK and `--dry-run` always previews. `reap` releases terminal claims belonging to the invoking principal; it reports foreign terminal claims with guidance to use their `--agent` principal. Active claims are preserved. `land` exits 2 and explains that it merges Git branches; shared-tracker work already lives on the shared tracker. The dedicated `npm run test:scale` proof installs the built package into one non-Git tracker and runs 50 real process agents through next/heartbeat/sync/close loops, kills 13 of 50 mid-run, reclaims their items and checks every write plus full strict health. Git is absent from PATH. See [fenced lease verification](docs/fenced-leases-verification.md) for measured timings. Hosted Postgres/MCP coordination is not certified by that local-process test.

## Exclusive resources

Use one canonical tracker item per physical resource: a test database, port,
dataset, test environment or deployment slot. Provision it once with the
`swarm-resource` tag and distribute its ID to every worker. Different IDs are
different resources even if their titles match. Resource items are excluded from
work selection, item start/sync/close/handoff and stale-agent reclaim. Ordinary
work claims and resource reservations remain independent; acquire the resource
before using it and release it in cleanup. Acquisition is exclusive even for the
same principal; use renew to extend a reservation you already hold.

```sh
pm create --type Task --id test-db --title "Integration test database" --tags swarm-resource
# Use the actual resource ID returned by create, including its project prefix.
pm swarm resource project-test-db --action reserve --agent worker --ttl 300 --json
# Retain the returned token string; this example assumes generation 1.
pm swarm resource project-test-db --action renew --agent worker --token 1 --ttl 600
pm swarm resource project-test-db --action publish --agent worker --token 1 --note "Integration checks passed"
pm swarm resource project-test-db --action release --agent worker --token 1
pm swarm resource project-test-db
```

TTL defaults to 300 seconds and accepts integers from 1 through 86400. Renew
before expiry; an agent heartbeat does not extend a resource reservation. Expired
owners cannot renew, release or publish. A successor reserve increments the
durable decimal `swarm_token`; release also increments it, preventing same-author
ABA. No background reaper is required. Retain resource items and their append-only
histories rather than deleting/recreating them, which would reset their identity.

Every command returns only `id`, `resource`, `token`, `owner`, `expires_at` and
`held`, in native TOON or JSON. Status preserves the recorded expired owner while
reporting `held: false`. Publication appends a note of at most 4096 characters in
one atomic tracker update; it retains the reservation until release or expiry.
`ResourceRefusal` exposes `code` and `remedy`; CLI exit 2 preserves the code and
includes the remedy in its diagnostic. `resource_busy` means wait or ask the owner
to release; `resource_stale_fence` means discard the token/result, reserve and
recompute; `resource_invalid` means inspect the tagged item or fix input;
`resource_backend_refused` means configure a backend with shared fencing.

The built-in `trackerResourceBackend(engine)` reuses #12's local tracker operation
lease, holding its live writer pin through SDK commit and writing assignee,
generation, expiry and publication evidence together. It conservatively refuses
extensions declaring services (or missing/empty capability declarations), since their
storage ownership cannot be established by this adapter. It never switches to
local coordination after a provider refusal. The generic `ResourceBackend`
contract lets a hosted provider supply tracker-wide serialization and atomic
writes without changing the resource model; a provider must implement its lease
and commit guarantees explicitly. Hosted Postgres/MCP providers are not certified
by the filesystem adapter's tests. Direct core writes bypass the swarm protocol;
all cooperating agents must use this resource API. Tokens guard publication to
the tracker, not arbitrary external database/deployment writes: those sinks must
also validate fencing if they allow delayed writes after resource expiry.

For the typed SDK example, see [resource reservations](docs/resource-reservations.md).

## Heartbeats, takeover and handoff

While editing or running tools outside swarm, run `pm swarm heartbeat --agent worker` regularly. Awaited swarm mutations renew the operation lease and the invoking principal's heartbeat automatically. Synchronous Git subprocesses block those timers; Git mode retains its live process pin across such calls and checks both pin and operation generations before each write, without treating heartbeat age alone as lost ownership. Shared-tracker mode also enforces the heartbeat expiry check. Runtime liveness records stay in the tracker's ignored runtime directory; deleting those records discards recent liveness evidence, so preserve them while agents are active. A new claim or transfer grants a fresh heartbeat interval even if the receiver last ran long ago.

Operation owners and queued requests include a hashed host boot and PID namespace identity. Automatic dead-process recovery uses PID probes only when that locality matches. A missing, different or unverifiable locality is preserved as potentially live, including legacy records, another container's PID namespace and unavailable locality probes. Unverifiable ownership can therefore return `swarm_busy` until its owner finishes or an operator inspects abandoned records. Clear only confirmed abandoned pin/request records in the ignored `runtime/swarm` directory after all writers sharing the tracker are stopped. Automatic recovery is certified for the same Linux host boot and PID namespace; this does not certify cross-host coordination.

`pm swarm reclaim --stale-after 120 --parent project-id --dry-run` previews stale swarm assignments among direct children without writing item history, ownership or heartbeat records. Remove `--dry-run` to apply; omit `--parent` to scan the tracker. The invoking principal's own assignments are preserved in both preview and apply. Only assignments marked by `swarm_token`, `swarm_claimed_at` or `swarm_branch` are eligible, so ordinary human and SDK assignments are preserved. Only the configured open and in-progress statuses can return to the configured open status; blocked, review, draft and other workflow states are preserved and reported in `refused`. Add `--to recovery-worker` to assign them directly. Each item transition bumps the token and appends a comment with the previous owner, last heartbeat, previous token and destination in the same SDK update. Reclaim uses the newest valid claim or heartbeat timestamp. Before transfer it checks a fresh item against the corpus snapshot and re-reads the owner's heartbeat; observed item changes or fresh heartbeats preserve the item. Core SDK writes and agent-wide heartbeats after that final check can still race with recovery; they do not participate in the swarm pin. Terminal reap also revalidates its item snapshot before release or Git cleanup. Items with neither valid timestamp are preserved and reported in `refused` with guidance to repair their liveness evidence. A `swarm_token` that is not a decimal generation is also preserved and reported in `refused`, and reclaim continues with the other items; `start`, `next`, `handoff` and `close` name that item and refuse before writing. Reclaim does not return a Git lane (`swarm_branch` set) to the pool, because Git `next` skips it and Git `start` reports that the lane already exists. Pass `--to` to keep that lane assigned; explicit reassignment preserves `swarm_branch`. Terminal work is left alone. Choose a threshold longer than your external heartbeat interval.

`pm swarm handoff task-id --agent worker --token 1 --to reviewer --note "Tests linked; inspect edge cases"` transfers owner, token, note and receiver packet in one item transaction. `pm swarm next --agent reviewer` returns that assigned item before selecting new work, with its new token and `context`: item state, up to 50 linked files, the last three comments (up to 1024 characters each), sender and note. `files_omitted` reports any file truncation. The full item remains available through `pm show`. A returned handoff remains available until finished or handed on. Malformed handoff JSON, null/primitive/array contexts, and missing, non-decimal or mismatched context tokens are refused as `swarm_stale_fence` in both preview and claim modes, without changing item history.

Shared `sync --apply`, `handoff` and `close` consume fencing tokens; reclaim and terminal reap follow their administrative recovery policies. Git `sync --apply` also checks current ownership under the tracker lease and requires `--token` when the item has a swarm token, including after a round-trip handoff. A supplied stale token is refused even when there are no new paths. Core pm commands and external SDK clients do not supply swarm tokens and can bypass this protocol; use the swarm writer commands for the fenced loop. This package does not change the host SDK. Agent principals are caller-selected identities, not an authentication system. Other optional Git worktree commands retain their existing SDK ownership contract.

## Optional Git worktree lanes

Inside a Git worktree, existing lane behavior is retained. Use `next` → work and commit in the printed worktree → `sync --apply` → `status` → `land`. Git-specific settings and flags control this optional isolation layer.

```sh
pm swarm next --agent worker --parent project-id
pm swarm sync task-id --agent worker --apply
pm swarm status --watch --interval 2
pm swarm land --json
pm swarm land --execute
```

`next` uses the same certified corpus and SDK dependency readiness as `plan`, excluding existing lanes and both own and foreign claims. It selects known footprints that do not intersect any nonterminal lane's declared footprint or actual changed paths, measured with Git from the current target's merge base. Priority sorts ascending (0 first), then creation time ascending (oldest first), then item ID. A lower priority safe item beats a higher priority overlapping item. Output includes the selection reason and skipped candidates with overlapping lane IDs and paths. `--parent` selects direct children. Both modes serialize through the tracker process pin; Git operations acquire the repository lease inside it. Git retains that pin across synchronous subprocesses that can outlast the heartbeat interval; ownership generations remain checked before writes. Git selection also checks assigned items without a local branch, including assigned-only items; the SDK claim is the final ownership check.

Unknown candidate footprints are deferred until no known safe item exists, then started with an explicit warning. An active lane with neither linked nor changed paths cannot establish safety and blocks known candidates conservatively. When no eligible item remains, `selected` is null and no lane is created. `--dry-run` makes no claim, item/history edit, branch, worktree, or local Git configuration change. Normal host SDK read caches may still be refreshed. `next` uses the configured base, root and branch prefix, just as `start` does.

`start` includes `overlap_warnings`, naming each active lane and the candidate and lane paths. The default still starts successfully; `pm swarm start task-id --strict` refuses overlaps before claiming or creating a worktree. These checks prevent obvious overlapping edits; real merge predictions remain available through `status` and `land`.

`status --watch` emits initial lanes/conflicts as additions, then only changes: `lane_added`, `lane_changed`, `lane_removed`, `conflict_predicted`, `conflict_changed`, and `conflict_resolved`. Ahead/behind counts, changed files and footprint drift participate in lane comparisons. Repeated identical polls emit nothing. The default interval is two seconds; smaller positive requests are clamped to two seconds, and values above 86400 seconds or nonfinite/nonpositive values are rejected. `--interval` requires `--watch`. Ctrl-C exits successfully and clears the pending timer. Watch reads local refs without fetching; fetch remote work explicitly when needed. TOON blocks are separated by blank lines; `--json` emits one event per line. Watch uses the host-pinned SDK codec, keeping the package free of runtime dependencies.

Each planning wave contains mutually compatible items. The first wave is the suggested start set. Every incompatible pair carries its separation reasons: equal or containing paths, dependencies, or an unknown footprint. Missing file links always mean `footprint: unknown`, with a solitary wave. Capacity is enforced independently by `--limit`. The SDK excludes blocked work and unfinished containers; only open and unclaimed items start in a plan. `--parent` selects direct children. Readiness is advisory: the SDK claim is the atomic ownership check when starting.

`start` registers `swarm_branch`, `swarm_base` (the original commit SHA), and `swarm_base_ref` (the moving target ref). Defaults are base `main`, worktree root `../.pm-swarm`, branch prefix `swarm/`, lane limit 4. Flags override settings. Planning supports limits 1–8; landing searches up to eight active lanes exhaustively and refuses larger batches explicitly.

Absolute worktree paths live only in repository-local Git config (`swarm.lane.<id>`). Never put machine paths into tracker fields, comments, or settings. A persisted root setting must be relative; an absolute `start --root` override remains local. Worktree paths may appear in command output. If the lane root is inside the repository, ignore that directory before landing so the base worktree stays clean. Existing absolute linked paths are rejected so sync cannot persist them. Keep `.agents/pm/extensions/` ignored: the host package installer records local tarball provenance there.

All package Git operations strip inherited Git location variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_NAMESPACE`, and `GIT_PREFIX`). The explicit repository directory determines the target, including linked worktrees; hook environment variables cannot redirect operations to a parent or unrelated repository. Other Git configuration and identity variables remain available.

Git simulations use configured repository merge drivers; `missing_merge_drivers` reports missing pm configuration, and unresolved tracker paths remain visible in `tracker_conflicts`. Run predictions only in repositories you trust.

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

`status` reports conflicts without failing the process; `land` supplies the conflict exit gate. For package development, run `npm run release:check` and `bun run release:check` with isolated HOME and Git configuration. CI verifies tracker health, commit identity, TypeScript, lint, duplication, docstrings, four 100% coverage dimensions, production audit, package allowlist, generated changelog, release attestation and packed npm/native Bun consumers. Packed acceptance also installs the tarball into a non-Git tracker and runs the shared loop. Git acceptance extracts `npm pack`, installs the directory with `pm install <dir> --project` into fresh Git repositories and trackers, and checks real host commands through Node, npx, Bun and bunx, including TOON/JSON watch shutdown. A built artifact import check rejects dependencies outside Node built-ins and the pm SDK. Release has only a manual trigger plus an approval variable; scheduled publication stays disabled.

## Shared plan progress witnesses

`pm swarm progress PLAN_ID` aggregates each core Plan step's owner and declared
production evidence into one content revision. It works on one shared tracker,
including a plain directory with no Git executable. It does not land branches,
execute linked evidence, or create another task tracker. Requires PM CLI/SDK
2026.10.23 or newer for concurrent mutation lease fencing and writer deadlines.

Configure the accepting principal once through the tracker's audited settings
operation. Acceptance commands cannot appoint their own orchestrator:

```sh
pm swarm settings --progress-orchestrator coordinator --apply
pm swarm progress delivery-plan --json
pm swarm progress delivery-plan --offset 20 --limit 20 --revision REVISION
```

`swarm.progress_orchestrator` is the authority for both reads and writes. Without
it, accepted counts remain zero and acceptance is refused. `--orchestrator` is
an optional assertion that must match this setting; it never selects authority.
`--agent` must match the SDK-recorded mutation author from `PM_AUTHOR`, the global
SDK author option, or the configured SDK default. A disagreement produces a
`progress_role` refusal with a remedy before any witness is written.

The default TOON and JSON projections include exact counts, up to 20 compact
step rows, `omitted` and `next_offset`; the maximum page size is 100. Continue with
`--revision` to refuse changed Plan inputs or approval authority. Evidence bodies
and raw comments stay in `pm show PLAN_ID --full`. The view distinguishes:

| Level | Required evidence |
| --- | --- |
| claimed | A core Plan step has an owner. |
| produced | That owned step is completed with nonempty core `stepEvidence`. |
| reviewed | A reviewer whose SDK-recorded author differs from the worker explicitly witnesses the revision. |
| accepted | The configured orchestrator's SDK-recorded author differs from both worker and reviewers and accepts the reviewed revision. |

Core `pm plan approve`, a completed status, ordinary comments and worker
self-reports do not establish orchestrator acceptance. Witness actors are the
SDK mutation authors also written to item history. Flags cannot override that
attribution. The receipt includes the resolved `actor`; regression tests verify
it against both comment authors and the corresponding history entry authors.

Identities in pm are asserted. This prevents accidental or casual self-approval
by one agent changing progress flags. Changing `PM_AUTHOR`, an SDK author option,
or tracker settings remains an asserted identity/configuration change, not proof
of a distinct person or process. Adversarial settings need **signed provenance**
and stronger authorization. These witnesses are not signed and do not provide
that boundary; protect tracker configuration and write access accordingly.

A SHA-256 content revision covers the Plan title, description, body, acceptance
criteria, readiness definition, all `plan_*` metadata (including step bodies,
owners, evidence, links and validation), item artifact/dependency links, and the
configured orchestrator. Any such change invalidates existing review and
acceptance. Unchanged comments do not invalidate witnesses. This is a content
revision, not a Git commit or wall-clock version: restoring identical inputs
restores the same revision. Witnesses refer to declared evidence, not
independently verified artifact bytes.

Reads and declarations are read-only by default. Only `--apply` appends an
attributed, idempotent `swarm-progress/v2` SDK comment. Previous v1 comments are
excluded because their actors could have been selected by progress flags;
re-evaluate and submit new review/acceptance witnesses. Existing core Plan
commands remain the source of steps, owners and production evidence. SDK atomic
comments preserve concurrent writers on the same tracker. A criterion or
configured-authority edit racing a witness append leaves an old-revision
witness that the new view excludes. Provider failures propagate without a
filesystem fallback.

```sh
pm plan create --title 'Parallel delivery' --step 'Implement parser' --step 'Document API'
pm plan update-step PLAN_ID STEP_ID --step-owner worker
pm plan complete-step PLAN_ID STEP_ID --step-evidence 'Parser regression passed'
pm swarm progress PLAN_ID --json
# Copy the returned revision; the first declaration below is only a preview.
PM_AUTHOR=reviewer pm swarm progress PLAN_ID --agent reviewer --stage reviewed \
  --step STEP_ID --revision REVISION --evidence 'Inspected parser and regression'
PM_AUTHOR=reviewer pm swarm progress PLAN_ID --agent reviewer --stage reviewed \
  --step STEP_ID --revision REVISION --evidence 'Inspected parser and regression' --apply
PM_AUTHOR=coordinator pm swarm progress PLAN_ID --agent coordinator \
  --stage accepted --step STEP_ID --revision REVISION \
  --evidence 'Review and criterion verified' --apply
pm swarm progress PLAN_ID --json
```

The typed SDK binds the same options used by its owned pm client. The actor is
never a separate positional identity that can disagree with that client:

```ts
import { PlanProgress } from 'pm-swarm';

const progress = new PlanProgress({ cwd: '.', pmRoot: '.agents/pm', author: 'coordinator' });
const view = await progress.view('delivery-plan', { limit: 20 });
// Preview by default; supply apply: true after evaluating this exact revision.
await progress.witness(view.id, {
  step: view.steps[0].id, revision: view.revision, stage: 'accepted',
  evidence: 'Independent review verified',
});
```

`ProgressRefusal` provides `code` and `remedy`. CLI expected errors retain both
as structured context. `progress_stale` requires a fresh read and re-evaluation;
`progress_role` requires matching SDK attribution, independent principals and
tracker-configured authority; `progress_prerequisite` requires production and
then review; `progress_invalid` identifies invalid settings, a Plan, step, page
or witness. Malformed current-version comments fail closed; ordinary comments
remain ordinary discussion.

## Fair assignment by skills, age and handoff cost

`pm swarm schedule` is an opt-in policy over the same certified SDK readiness,
dependencies, ownership and footprint checks as `next`. It assigns work and never
launches an agent. It works without Git, including with no Git executable on PATH;
inside Git it retains measured changed-path checks and optional worktree lanes.

Declare hard item requirements with `skill:<name>` tags. Names are case sensitive,
1–64 letters, digits, underscores, dots or dashes; an agent may declare up to 64.
Every required skill must match. Untagged work requires no skills. Optionally set
`swarm_preferred_agent` and `swarm_handoff_cost` through the extension's registered
fields. Cost is a nonnegative integer up to 1000000, default 1; it is zero when
there is no preferred agent or the caller matches that agent. It is a ranking
unit, not a measured duration or a model's inferred ability.

```sh
pm create --type Task --title 'Extend parser' --tags skill:typescript \
  --file path=src/parser.ts --field swarm_preferred_agent=parser-worker \
  --field swarm_handoff_cost=5
pm swarm schedule --agent parser-worker --skills typescript,testing --dry-run
pm swarm schedule --agent parser-worker --skills typescript,testing --json
# Retain selected and token, then use the existing heartbeat/sync/close loop.
```

Below `--max-wait` (default 86400 seconds, range 1–31536000), selection orders by
priority, lower handoff cost, oldest creation timestamp, then ID. At the threshold,
qualified work moves ahead of fresh work regardless of priority or transfer cost;
aged work orders by oldest creation timestamp then ID. With equal input and clock,
selection is deterministic, including when corpus enumeration changes. Creation
age is the starvation baseline, not time since becoming ready. Future timestamps
have age zero. Hard skills, dependency readiness and active conflicts are never
waived: aging cannot make unsafe or unqualified work runnable. Once those
constraints clear, an aged item precedes newer arrivals. Unknown footprints may
start only with no active lanes; in that case aging and the same rank apply to
them too. This is stricter than `next`'s unknown fallback.

Assigned shared-tracker handoffs still take precedence and return the existing
bounded receiver context and fencing token. Their required skills are checked;
an unqualified receiver gets `schedule_skills` and must use a qualified receiver.
An explicit handoff is already assigned, so it adds no ready-candidate rows.
The scheduler does not reassign someone else's work to reduce a cost.

Both TOON and JSON return `selected`, `agent`, `token` when claimed, `reason`, a
frozen `now`, exact `counts`, and at most 20 compact `decisions` (set `--limit`
1–100). The selected row comes first, followed by IDs. `omitted` counts hidden
rows; decisions distinguish skills, conflicts, lower rank and unknown footprints.
No corpus, full item bodies or histories are included. `--parent` scopes direct
children. `--dry-run` writes no claim or history and cannot reserve a later result.
Real selections hold the existing swarm tracker operation lease across reading,
ranking and the SDK claim mutation, serializing `schedule`, `next` and `start`
on the same tracker. External core writers can bypass swarm's footprint protocol;
all cooperating selectors must use swarm. Local coordination conservatively
refuses storage-service extensions; hosted Postgres/MCP scheduling is not certified.

```ts
import { SharedTracker, Swarm, SchedulingRefusal } from 'pm-swarm';
import { PmClient } from '@unbrained/pm-cli/sdk';

const client = new PmClient({ cwd: '.', pmRoot: '.agents/pm', author: 'parser-worker' });
const tracker = new SharedTracker(new Swarm('.', '.agents/pm', client, 'parser-worker'));
try {
  const choice = await tracker.schedule({
    skills: ['typescript', 'testing'], maxWaitSeconds: 3600, dryRun: true,
    // Optional SDK clock for repeatable policy evaluation:
    now: '2026-10-23T12:00:00.000Z',
  });
  console.log(choice.selected, choice.reason, choice.counts);
} catch (error) {
  if (error instanceof SchedulingRefusal) console.error(error.code, error.remedy);
  else throw error;
}
```

`Swarm.schedule` exposes the same typed options and receipt for optional Git lanes.
`SchedulingRefusal` codes are `schedule_invalid` (fix options, skill tags or item
metadata), `schedule_skills` (declare the required skills or hand off to a qualified
receiver), and `schedule_backend_refused` (use supported tracker-wide coordination).
The CLI exits 2 with the code and remedy. An empty eligible set is a successful
receipt with `selected: null`, not an ownership transfer.
