# Shared-tracker coordination verification

The feature is tracked in [pm-swarm-shared-tracker](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-shared-tracker.toon), under implementation epic pm-swarm-07o2. The package remains unreleased.

## Design

The command dispatcher checks workspace mode once. It traverses worktree markers before resolving a Git root, so a non-Git tracker path does not spawn Git. Settings bypasses repository detection entirely. Existing Git lanes retain their branch/worktree, diff, merge-prediction and cleanup behavior.

SharedTracker reuses the host-bound Swarm SDK client and certified readiness. A tracker-local SDK operation lease covers selection and claim publication while the lease remains valid. The 1800-second lease is finite and is not renewed during the operation; a stalled process can continue after expiry, and distinct overlapping explicit `start` calls can then both succeed because `PmClient.claim` has no tracker fencing token. Both modes use the same priority/age/id ranking, footprint containment checks and unknown-footprint fallback. Shared lanes are all items with a nonblank assignee, including assigned-only items and items with SDK claims. Linked files define their footprints; claim provenance is included when available. They do not persist branch or base fields.

Shared status reports nonterminal assigned items and declared overlaps, with null claim age where no claim history exists. Git measurements are omitted with an explanatory note. Watch compares claim provenance rather than elapsed age and emits separate overlap events. Sync requires explicit portable files without Git, preserving preview/apply precedence. Land refuses with the Git requirement and the available shared-tracker commands. Reap preserves active and foreign claims and releases terminal claims for the invoking principal.

## Behavioral revert evidence

All proofs ran against real temporary SDK trackers in an isolated source copy using the pinned SDK. Tests import source, so these mutations did not require a dist rebuild.

- Replacing only `runCommand` with its origin/main implementation: 0/9 no-git regressions pass; process exits 1. Every command in the eight-command matrix exits 2, first line `Error: Command failed`, with `git rev-parse failed` in the detail.
- Rebuilding with only `runCommand` reverted, then packing and installing that tarball: the packed non-Git acceptance fails at `next` with exit 2 from the host; the test exits 1.
- Disabling only `SharedTracker.sharedExclusive`: the eight-process contention regression fails, process exits 1, on a real already-claimed race. The SDK still protects individual claim ownership, but the full batch cannot each select and claim its own safe item.
- Restoring unconditional awaiting in the command dispatcher: the Git refusal regression fails (exit 2 instead of its existing exit 1). Awaiting only shared-mode operations preserves the Git transport and keeps explicit shared-mode exit-2 refusals.
- Restoring only the initial `repositoryRoot` function: a real Git regression fails when the ceiling equals the current worktree directory. Moving the ceiling check to ancestor traversal makes the same assertion pass while preserving the non-Git parent ceiling.
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


## Initial feature gate receipts

Both full gates passed on source commit `7a59afa`, using nvm Node 26.12.0, npm 11.20.0 and Bun 1.3.5, with isolated HOME, global/system Git configuration disabled and CI enabled. Coverage inventory, exclusions and thresholds remain unchanged.

| Gate | Suite | Packed acceptance | Statements / lines | Functions | Branches |
| --- | --- | --- | --- | --- | --- |
| `npm run release:check` | 112/112 | 3/3 | 1523/1523 | 90/90 | 753/753 |
| `bun run release:check` | 112/112 | 3/3 | 1523/1523 | 90/90 | 753/753 |

All 24 authored source files are measured at 100 percent in every dimension. Both gates have zero failures, skips or cancellations, zero duplication and a clean production audit. Typechecking, lint, docstrings, package contents, generated changelog, release attestation and actual packed consumers pass.

The eight-process claim test retained all eight unique claims and validated all nine history files in 24646 ms in the npm gate and 28004 ms in the Bun gate. Strict core health passed for the source fixture; full managed-extension strict health passed in the packed non-Git tracker under Node and native Bun. These timings include process startup and contention under host load.

The packed non-Git smoke uses `pm install ./package.tgz --project`, then next, sync with explicit files, status and terminal stale-claim reap. Git is absent from PATH during that loop. Existing Git-mode test cases remain unchanged, and a new regression preserves their existing refusal exit transport.

Node 22 and Node 26 CI passed on the tested source. The final handoff changes only this verification note and append-only PM evidence, with the feature left in progress and its claim released. No merge, tag, release or publication was performed.


## PR 10 review round

Every unresolved review thread and all of its comments were read at review head `8f7a850`. The latest CodeRabbit review contained no Outside diff range section. All three findings were valid.

| Thread | Verified correction |
| --- | --- |
| PRRT_kwDOVLY-P86uUldH | Shared planning and selection reuse one certified corpus. Start, sync and reap skip unrelated claim-history reads; start and next retain the selected item's direct ownership read. Status retains claim timestamps and age. |
| PRRT_kwDOVLY-P86uUldZ | Shared sync refuses new links on a foreign lane before writing. Preview and no-op apply remain permitted; refusal preserves files and history. |
| PRRT_kwDOVLY-P86uUldf | Git sync rejects empty explicit lists and empty entries, including whitespace-only direct SDK input, then deduplicates normalized paths. Git-derived changes remain available when files are omitted. |

Whole-diff self-review found the same foreign-write gap in Git sync; it now has the same guard and real-tracker regression as shared sync. Both sync entry points reject whitespace-only direct SDK paths. Regression instrumentation delegates every read to the real SDK, counting calls without substituting tracker responses.

Behavioral proofs use an isolated source copy with the final regressions and the pinned SDK. Only the named pre-review function is restored in each run; source imports need no dist rebuild:

- `sharedLanes`: 0/6 pass, exit 1, due to redundant corpus reads or unrelated per-lane ownership reads.
- `SharedTracker.next`: 0/1 pass, exit 1, due to redundant corpus reads.
- `SharedTracker.sync`: 0/1 pass, exit 1, missing the expected foreign-ownership rejection.
- `Swarm.sync`: 0/3 pass, exit 1, missing empty-file and foreign-write refusals and returning duplicate normalized paths.

The item remains in progress. Review threads are left untouched. Hosted coordination remains outside the local tracker acceptance boundary.


### Review-round release receipts

Both full release gates pass on the application code, tests and package inputs in source commit `856d26a`, with isolated HOME, global/system Git configuration disabled and CI enabled. Node 26.12.0, npm 11.20.0 and Bun 1.3.5 are used. The configured inventory, exclusions and thresholds are unchanged.

| Gate | Suite | Packed acceptance | Statements / lines | Functions | Branches |
| --- | --- | --- | --- | --- | --- |
| `npm run release:check` | 122/122 | 3/3 | 1526/1526 | 90/90 | 780/780 |
| `bun run release:check` | 122/122 | 3/3 | 1526/1526 | 90/90 | 781/781 |

All 24 authored files are measured at 100 percent in every dimension. Both suites have zero failures, skips or cancellations. The eight-process test retained all eight claims and validated nine history files with strict core health; measured claim batches took 25037 ms (npm) and 16147 ms (Bun).

Packed Git npm/npx and native Bun/bunx consumers, the built dependency allowlist, and the non-Git tarball loop pass in both gates. Full strict health passes for the managed non-Git extension under Node and native Bun with Git absent from PATH. No gate needed a timeout retry. Identity/privacy, types, lint, zero duplication, docstrings, production audit, package contents, changelog and release attestation all pass. Both pack dry-runs reported tarball shasum `43becd5976a48522c42577e32638e2f27505d55e`.

The final handoff changes only this verification note and append-only PM receipts; application code, tests and package inputs remain those of `856d26a`. The pre-existing development-tool advisory remains tracked in pm-swarm-zn7m. No new PM CLI/SDK bug was observed; the host still uses generic refusal headings with actionable details. The feature remains in progress with its claim released.

## Assignment and cross-mode lease review round

At pre-round head `b1f30c2`, every unresolved thread and every comment were fetched with no remaining pagination. The latest CodeRabbit review had no Outside diff range findings. All four findings were valid.

| Thread | Correction |
| --- | --- |
| PRRT_kwDOVLY-P86uYd_6 | README and verification text define shared lanes as all items with a nonblank assignee, including assigned-only items and SDK claims. |
| PRRT_kwDOVLY-P86uYeAB | Git operations acquire the same tracker lease as shared operations, outside the existing repository lease. Both release on success and failure. |
| PRRT_kwDOVLY-P86uYeAP | Git selection and strict start include assigned tracker footprints without a local Git lane, including unavailable local branches and unknown footprints. Terminal and unassigned items do not block. |
| PRRT_kwDOVLY-P86uYeAq | Absolute Git ceiling entries are normalized and canonicalized through symlinks until an empty entry disables further ceiling symlink resolution. Relative and unresolvable absolute entries are ignored. Workspace symlinks use the physical working directory. |

Whole-diff review also covered assignments with stale Git metadata and conversion of one's own shared claim into a strict Git lane. Conversion excludes its own item from overlap checks. Git footprint projection reuses its certified corpus rather than reading it twice. Existing Git lane diffs remain measured.

The regressions use real temporary trackers and Git repositories. Lease instrumentation probes the actual SDK lease during real SDK reads; it substitutes no tracker responses. A separate concurrent Git/non-Git CLI test targets the same tracker with overlapping candidates and requires exactly one retained claim.

Behavioral reverts restore only the named pre-round function in an isolated source copy with the final tests. Source imports need no dist rebuild:

| Revert | Failing regressions | Process exit |
| --- | --- | --- |
| `Swarm.exclusive` | 1/1: tracker lease absent during Git selection | 1 |
| `Swarm.activeFootprints` | 4/4: claim, assignment, unavailable branch, unknown footprint | 1 |
| `Swarm.startLane` | 1/1: own shared claim falsely overlaps itself | 1 |
| `repositoryRoot` | 3/3: trailing separator, parent component, dot component | 1 |
| Lane documentation | 1/1: assigned-only behavior/documentation contract | 1 |
| Absolute-only `repositoryRoot` from `feab75b` | 1/1: symlink ceiling and empty-entry semantics | 1 |

The focused commands are `node --test --test-name-pattern="PATTERN" test/mixed-tracker.test.ts`, with patterns `Git operations hold`, `Git selection includes shared (claim|assignment|missing-branch|unknown)`, `Git strict start can convert`, `workspace detection normalizes absolute`, and `shared assigned-only lanes`, respectively.

A final adjacent-case check found the symlink ceiling issue after the first npm gate had passed on `feab75b`. The superseded Bun gate was deliberately stopped to complete that correction and is not counted as a passing release gate. Six targeted ceiling tests pass, including relative entries, symlink aliases, the empty-entry sentinel, physical workspace paths and nonexistent paths. The full final regression file has 17 tests.

The additional isolated revert command is `node --test --test-name-pattern="workspace detection canonicalizes ceiling symlinks" test/mixed-tracker.test.ts`. Restoring only `repositoryRoot` from `feab75b` fails 1/1 with exit 1. The corrected 17-test file passes through `pm test --run --only-last --progress`.


### Final assignment and cross-mode release receipts

Both full gates pass on application code, tests and package inputs in `b3339c3`, using isolated HOME, disabled global/system Git configuration and CI enabled, under Node 26.12.0/npm 11.20.0/Bun 1.3.5.

| Gate | Suite | Packed acceptance | Statements / lines | Functions | Branches |
| --- | --- | --- | --- | --- | --- |
| `npm run release:check` | 139/139 | 3/3 | 1546/1546 | 90/90 | 802/802 |
| `bun run release:check` | 139/139 | 3/3 | 1546/1546 | 90/90 | 802/802 |

All 24 authored files retain four 100 percent metrics with unchanged inventory, exclusions and thresholds. Both final runs have zero failures, skips, cancellations and timeout retries. Identity/privacy, types, lint, zero duplication, docstrings, production audit, package contents, changelog and release attestation pass.

Packed Git npm/npx and native Bun/bunx consumers pass. The non-Git tarball workflow passes under Node and native Bun with Git absent from PATH and full managed-extension strict health. Eight real processes retain eight claims and nine valid history files with strict fixture health: 21903 ms (npm), 46153 ms (Bun).

Both package dry-runs have shasum `0d6760e7519595b4c83b27331f216d770544749d`. Dist is ignored rather than committed, and both gates rebuild it. The final handoff commit changes only append-only PM evidence and verification documentation; application code, tests and package inputs remain those of `b3339c3`. A preliminary Bun run was deliberately stopped to finish the extra ceiling fix; it is superseded by these complete final gates.

Core package tracker health passes with clean integrity/history and the previously documented six stale-item advisories. Full local health still reports the ignored pm-github extension host-version skew; no dependency pin or existing history was rewritten. Hosted coordination remains unverified. The feature stays in progress with its claim released. No new PM CLI/SDK bug was observed. Review threads remain untouched.

## Missing workspace descendant review round

All review threads and comments were fetched at head `7a1be85`, with no remaining pagination. The latest CodeRabbit review has no Outside diff range findings.

| Thread | Verified correction |
| --- | --- |
| PRRT_kwDOVLY-P86uau2z | `repositoryRoot` runs `git rev-parse` in the existing directory where it finds the worktree marker, rather than the original missing descendant. |

Whole-PR review covered workspace dispatch, coordination leases, footprint selection, ownership guards, status/watch and packed acceptance. An adjacent traversal regression exposed a ceiling bypass when missing descendants lead through a symlink ancestor. Existing ancestors are now canonicalized before ceiling comparison, matching the physical paths used for existing workspaces. Relative ceilings, empty-entry sentinel semantics and non-Git discovery remain covered by the existing suite.

Three new real-tracker regressions cover ordinary repositories, symlink aliases and linked worktrees. Each verifies missing descendants resolve without creating directories and that a repository ceiling still blocks discovery. All nine workspace-detection tests in `test/mixed-tracker.test.ts` pass.

Behavioral revert proofs use an isolated source copy with the final tests and pinned SDK. Only the indicated behavior inside `repositoryRoot` changes; source imports require no dist rebuild:

| Revert | Command | Result |
| --- | --- | --- |
| Restore the original Git working directory, retaining ancestor canonicalization | `node --test --test-name-pattern="workspace detection resolves missing descendants" test/mixed-tracker.test.ts` | 0/3 pass, 3 fail, exit 1: `git rev-parse failed` |
| Restore lexical ancestor traversal, retaining the corrected Git working directory | `node --test --test-name-pattern="workspace detection resolves missing descendants of a symlink" test/mixed-tracker.test.ts` | 0/1 pass, 1 fail, exit 1: repository ceiling bypass |

The review thread remains untouched. Dist is ignored and regenerated by the release gates. The feature remains in progress.

### Missing-descendant release receipts

Application code, tests and package inputs are those of `7babaf5`. The full local npm gate passed with isolated HOME, disabled global/system Git configuration and CI enabled, using Node 26.12.0/npm 11.20.0/Bun 1.3.5. [CI run 39466254083](https://github.com/unbraind/pm-swarm/actions/runs/39466254083) passed both Node 22 and Node 26 jobs, including the full Bun release gate.

| Gate | Evidence | Suite | Packed acceptance | Coverage |
| --- | --- | --- | --- | --- |
| `npm run release:check` | Local Node 26 | 142/142 | 3/3 | All 24 authored files; four 100 percent metrics |
| `bun run release:check` | CI Node 26 | 142/142 | 3/3 | All 24 authored files; four 100 percent metrics |

The local npm report measures statements/lines 1547/1547, functions 90/90 and branches 802/802. Inventory, exclusions and thresholds are unchanged. Identity/privacy, types, lint, zero duplication, docstrings, production audit, package contents, changelog and release attestation pass. CI also passes strict tracked-project health and both Node matrices' 142-test suites and three packed acceptance tests. Local npm and CI Bun package dry-runs have the same shasum: `5e45e0cf295a3502d59ce8c4516a14528a673316`.

The local Bun attempt reported 140 passes, one failure and one cancellation: the JSON watch child missed its 15-second initial-output deadline; the TOON watch child hit its 60-second test timeout. That attempt is not counted as a successful gate. Both cases then passed locally, 2/2, through `pm test --run --only-last --progress`, running `node --test --test-name-pattern="watch child streams" test/next-watch.test.ts` with unchanged internal deadlines. The complete CI Bun gate also passed both cases without failures, skips or cancellations. No test timeout or threshold was relaxed.

Eight-process coordination retained eight claims and nine valid histories with strict fixture health in 43555 ms (local npm), 82490 ms (local Bun attempt) and 2147 ms (CI Bun). Packed npm/npx, native Bun/bunx, the built import allowlist and non-Git tarball workflows all pass in the successful gates.

The final handoff changes only append-only PM evidence and this verification note. The feature remains in progress with its claim released. The existing ignored local extension version skew, six stale-item advisories and development-only glob advisory in pm-swarm-zn7m remain separate; hosted coordination remains unverified. No new PM CLI/SDK bug was observed. No review thread was replied to or resolved.

## Terminal claim-read review round

At head `576c9a5`, all unresolved threads and all their comments were fetched with no remaining pagination. The latest CodeRabbit review contains no Outside diff range findings.

| Thread | Verified correction |
| --- | --- |
| PRRT_kwDOVLY-P86ucxhK | Compute terminal status before loading claim provenance; terminal lanes retain metadata with null `claimed_at`, and only active assigned items incur claim reads. |

Three real non-Git tracker regressions cover direct `sharedLanes`, status and three serial watch polls. Each includes active claimed and assigned-only items, terminal claimed and assigned-only items, and unassigned work. They count delegated real SDK reads, retain active timestamps, verify claim-disabled callers perform no reads, and confirm all observed histories remain unchanged.

The focused command is `node --test --test-name-pattern="skips terminal claim reads" test/shared-tracker.test.ts`: corrected code passes 3/3. Restoring only the previous `sharedLanes` method in an isolated source copy, with final tests and pinned SDK unchanged, fails all 3 regressions, exit 1. Direct lanes expose the unwanted terminal claim timestamp; status performs 4 rather than 2 reads; three watch polls perform 12 rather than 6 reads. Tests import source, so no dist rebuild is needed for the proof.

Whole-PR self-review checked all claim-history reads and their callers, including selection, planning, sync, reap, status/watch, Git lane projection and workspace dispatch. No additional instance of this defect class was found: non-status shared operations already disable claim reads, and direct claim ownership checks remain necessary. Dist is ignored and rebuilt by release gates. Review threads remain untouched.

### Terminal claim-read release receipts

Main advanced during validation with Dependabot commit `3663759`. It was merged in `c30c4dc`, bringing the pinned PM CLI and pm-ops to `2026.10.17`. Application code and tests remain those of `b77154c`. The corrected 3/3 regressions and the isolated 3/3 failing behavioral revert were repeated successfully with the new pinned SDK. Earlier passing gates on the previous dependency graph are superseded by these merged-head receipts.

| Gate | Evidence | Suite | Packed acceptance | Coverage |
| --- | --- | --- | --- | --- |
| `npm run release:check` | Local Node 26.12.0/npm 11.20.0, isolated HOME and Git configuration, CI enabled | 145/145 | 3/3 | All 24 authored files; four 100 percent metrics |
| `bun run release:check` | [CI Node 26 on c30c4dc](https://github.com/unbraind/pm-swarm/actions/runs/39475928529) | 145/145 | 3/3 | All 24 authored files; four 100 percent metrics |

Both gates have zero failures, skips and cancellations; no timeout retry or threshold change was needed. Local coverage measures statements/lines 1548/1548, functions 90/90 and branches 804/804. Inventory and exclusions are unchanged. Identity/privacy, types, lint, zero duplication, docstrings, clean production audit, package contents, changelog and publish attestation pass. CI also passes the Node 22 matrix and strict tracked-project health.

Packed npm/npx, native Bun/bunx, the built import allowlist and non-Git tarball workflows pass. Local npm and CI Bun package dry-runs match shasum `71dc782b8703792557ce5f509f80c5936b0763f5`. The local eight-process test retains eight distinct claims and nine valid history files with strict fixture health; its claim batch took 39321 ms.

The final fetch still contains only PRRT_kwDOVLY-P86ucxhK, with no remaining thread/comment/review pagination and no Outside diff range findings. No thread was replied to or resolved. The final handoff changes only append-only PM evidence and this verification note; application, tests and package inputs remain those of `c30c4dc`.

Core local tracker health passes. Full local health retains the existing ignored pm-github host-version mismatch (pinned host 2026.10.17 versus extension requirement 2026.10.20) and six stale-item advisories. The development-only glob advisory remains in pm-swarm-zn7m; hosted coordination remains unverified. No new PM CLI/SDK bug was observed. The feature remains in progress with its claim released.

## Lease guarantee and physical fixture paths review round

At head `2f98a3b`, both unresolved threads and all their comments were fetched with complete thread/comment pagination. The latest CodeRabbit review has no Outside diff range findings. Both findings are valid.

| Thread | Correction |
| --- | --- |
| PRRT_kwDOVLY-P86uetj1 | README and this design document limit serialization to the valid, finite, non-renewed 1800-second lease. They explain that a stalled process can continue after expiry and overlapping explicit starts can both succeed without a tracker fencing token. |
| PRRT_kwDOVLY-P86uetkM | The shared Git fixture canonicalizes its temporary root before deriving repository and tracker paths, matching Git's physical root on symlinked temporary directories. |

Whole-PR self-review found another lexical-root comparison in packed Git acceptance; its fixture root is now canonicalized too. Production coordination and workspace discovery behavior remain unchanged. Other temporary roots do not compare lexical paths with Git's physical root. Dist is ignored and rebuilt by the release gates.

The new lease regression uses a real non-Git tracker and pinned SDK. It pauses after a certified corpus snapshot, ages only that disposable tracker's operation lease, and lets a successor strict start finish before resuming the first operation. Both overlapping claims persist, demonstrating the documented boundary without waiting thirty minutes or mocking SDK results. The same regression checks both documentation surfaces. The physical-path regression runs a real Git fixture in a child with a symlinked temporary directory, then verifies discovery and ceiling behavior.

Independent isolated reverts retain final tests and the pinned SDK:

| Reverted change | Exact command | Result |
| --- | --- | --- |
| README lease qualification only | `node --test --test-name-pattern="expired tracker lease" test/shared-tracker.test.ts` | 0/1 pass, 1 fail, exit 1: missing lease qualification |
| Design paragraph qualification only | `node --test --test-name-pattern="expired tracker lease" test/shared-tracker.test.ts` | 0/1 pass, 1 fail, exit 1: missing lease qualification |
| Only the previous `fixture` function | `node --test --test-name-pattern="fixture canonicalizes" test/mixed-tracker.test.ts` | 0/1 pass, 1 fail, exit 1: lexical and physical roots differ |

The corrected focused command is `node --test --test-name-pattern="fixture canonicalizes|expired tracker lease" test/mixed-tracker.test.ts test/shared-tracker.test.ts`. Tests import source; these proofs do not require a dist rebuild. Review threads remain untouched and the feature remains in progress.

The additional packed-fixture proof uses a symlinked `TMPDIR` with only the Git acceptance fixture's root canonicalization reverted. `node --test --test-name-pattern="packed npm/npx" test/install.acceptance.ts` fails 0/1, exit 1, at the returned `start.worktree` comparison: Git returns the physical temporary root while the old fixture expects its symlink alias. The reverted run took 245200 ms. The corrected fixture is exercised under the same symlinked temporary root by the full release gate.
