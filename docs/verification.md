# Local review evidence

The package is unpublished. `main` contains the initial scaffold; implementation is on `feat/swarm`. No repository, PR, tag, release, publish or push was created.

The final release gates require all 64 real-Git/SDK tests to pass with zero failed, skipped, cancelled or todo tests. The preceding complete run passed 63 tests; the added base-update regression passed separately before the final gates. All 18 authored modules, including tooling and extension entry points, reached 100% statements, branches, functions and lines. Thresholds remain 100 in every dimension, with no ignored source modules. The packed npm/npx and native Bun/bunx acceptance passed one test spanning both independent consumers, all commands, host TOON/JSON, local landing and tracker privacy.

The scoped PM-linked command also passed 10 tests, zero failed/skipped/cancelled/todo.

Three negative controls replaced one feature function at a time with its absent-feature behavior: `separation` returned no reasons, `predict` reported no conflicts, and `cleanOrder` returned input order. Each targeted regression failed with ERR_ASSERTION and exit 1. Each source file was restored byte-for-byte; import or compilation errors were not accepted as proof. The initial scaffold had no implementation, so these are behavioral reverts of each feature rather than reversions to an existing algorithm.

Conflict prediction uses Git 2.53.0's actual merge engine. Two lane commits changing the same line produce a conflict, while a third lane changing a separate file does not. Every lane is also compared with its current target tip. The three-lane fixture checks all six permutations and only `a → b → c` succeeds. Simulations chain real unreferenced merge commits so later merge bases retain correct ancestry.

A later base-update regression checks that status and sync exclude inherited base files after a lane updates its base. Independently reverting either function to the recorded starting base fails that regression with ERR_ASSERTION (two additional controls); both functions were restored exactly.

Tracker-path experiment: both independent SDK comments survive in the resulting item and history tree with the configured pm drivers. Setting the item driver to a failing command creates a tracker conflict. Drivers print receipt text before Git's NUL-delimited result, which the predictor parses separately. Unresolved tracker paths are retained explicitly. Simulation changes no source tracker history. Driver clone-local runtime receipts are ignored state.

Read-only dogfood used an isolated copy of pm-vcs: 134 certified items, 8 ready candidates, 4 safe waves, 21 separated pairs (14 incompatibilities and 7 wave assignments), zero active swarm lanes and therefore zero merge predictions/conflicts. Tracked state stayed unchanged. Suggested IDs: pm-vcs-dispatch104, pm-vcs-j7mz, pm-vcs-w3yi, pm-vcs-00mb. Zero active lanes is zero-case evidence, separate from the nonempty real-Git regression tests.

SDK integration boundaries encountered:

- Custom extension fields require active extension registration. `get --fields` does not accept their names; lane creation uses a full read.
- Narrow reads omit claim facets unless `claim_state` is explicitly requested.
- Typed settings normalize away private package sections. Reads use SDK settings-path/file APIs; writes use governed `mutateWorkspaceSettings`.
- Linked test source context follows the outer workspace inside a nested pm test snapshot. Secondary temporary worktrees then fail provenance checks. The linked acceptance command explicitly covers non-landing operations; full landing tests run in the direct complete release suite. No source-access or trust restriction is disabled.
- Native `bunx --bun` supplies Bun's `node` shim. Its consumer links `bun test`; the npm consumer links `node --test`.
- Managed local-tarball installation stores machine-specific provenance inside `.agents/pm/extensions/`; this directory stays ignored, matching the reference package policy. Worktree paths themselves are stored only in local Git config.

The supplied pm-lint checkout lacked the requested GitHub sync caller; the pinned caller was copied unchanged from supplied pm-jev. The pm-ops pin follows that reference at 2026.10.14 so artifact-time prepare skips driver installation; its template launcher is byte-identical. Release scheduling remains disabled, with manual dispatch additionally requiring maintainer enablement.

Production npm audit reports zero vulnerabilities. Full audit reports three affected development packages in the braces/micromatch/fast-glob chain, with no available registry fix; a package-local follow-up tracks the advisory separately. Landing searches at most eight lanes exhaustively. Unexpected failures during actual Git merges may leave earlier clean merges committed; nothing is pushed.
