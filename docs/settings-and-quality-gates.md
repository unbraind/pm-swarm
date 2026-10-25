# Settings and output verification

`pm swarm settings` previews the effective package configuration. `--apply`
patches the section through the host's `mutateWorkspaceSettings` audit lock.
The callback reads the section after acquiring that lock; it never writes a
snapshot read before waiting. Other sections and unknown keys inside `swarm`
are preserved. Unknown keys are counted as skipped foreign settings and are
never interpreted or echoed.

The SDK pinned at 2026.10.23 has no extension settings-section registration API
on `ExtensionApi`. Its normalized `readSettings` projection also omits unknown
extension sections. `swarmSettingsSection` supplies typed package metadata and
`resolveSwarmSettings` supplies validation, but these are **not host settings
registration**. Reading the raw subtree with public SDK file/path APIs inside
the audited callback is the compatibility bridge. Host registration remains an
unmet acceptance criterion until the SDK supplies that capability. The SDK pin
is unchanged.

## Transaction boundaries

`updateSettings` exposes an optional verification checkpoint at every package
boundary: before the transaction, after the locked read, after validation, and
after the SDK commit returns. There is one durable write path: the SDK audited
settings transaction. No package journal, cleanup, deletion or second writer is
introduced. The host owns its internal journal recovery and lock release.

Tests start a competing audited transition at all four boundaries on the same
non-Git tracker. Transitions attempted while its lock is held wait until release;
updates to different leaves survive in either order. Four exception interruptions
and four real SIGKILL interruptions verify rerun convergence. A stable operation
ID deduplicates committed retries; the audit stream is byte-identical after replay.
A replay reports `replayed: true`, `changed: false`, and the current effective
configuration rather than pretending to apply the proposed patch again. Use a
new operation ID for a new intent.

## Output contract

The host renderer owns only registered `swarm` command paths with package result
shapes. TOON is the default; JSON is compact. Watch completion remains silent.
Command results, renderer input, watch events and expected error text are checked
recursively, including object keys, for absolute Unix and Windows home locations.
Private values trigger `swarm_private_path` and a remedy without the value.
Expected-error recovery withholds original argument values. Git CLI lane locations
are project-relative; embedded `Swarm.start` retains its local filesystem handle.

## Reproduction

```sh
npm ci
npm run typecheck
npm run lint
node --test --test-concurrency=1 test/settings-and-output.test.ts test/commands.test.ts
npm run build
npm run test:install
# The full fleet gate runs on CI with npm and Bun at unchanged thresholds.
npm run release:check
bun run release:check
# Point this at an independently verified public pm-ops checkout.
PUBLIC_TRACKER_REPO=../pm-ops node --test test/settings-corpus.acceptance.ts
```

Packed acceptance installs the tarball and pinned host into independent fresh npm
and Bun consumers, initializes non-Git trackers, removes Git from PATH, and invokes
every registered command. `land` must refuse with its explicit Git requirement.
Separate Git acceptance preserves branch-isolation and landing coverage. These
checks certify local file-backed trackers; hosted backend acceptance is separate.

The read-only corpus check verifies GitHub public visibility, archives only the
committed tracker, makes baseline files read-only, and hashes them before/after.
It exercises settings overrides without apply, SDK planning, CLI planning/status,
and both host renderers. It emits only aggregate measurements and public commit
identity. Measured results are recorded in the PR and pm evidence.
