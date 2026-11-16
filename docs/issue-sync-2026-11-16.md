# Scheduled GitHub issue sync diagnosis, 2026-11-16

[Failed workflow run](https://github.com/unbraind/pm-swarm/actions/runs/43707037608).

Observed failure:

```text
pm github gate: import plan is not idempotent — 2 duplicate provenance tag(s) in the existing corpus, 0 new entr(y/ies) without a provenance tag, 0 conflicting target(s).
```

The failed run used pm-github 2026.11.4. Main now contains [PR #78](https://github.com/unbraind/pm-swarm/pull/78), pinning both sync and closeout to 2026.11.15. That release permits shared reference tags while keeping import ownership exclusive. No further caller change is needed.

| Reference | Preserved items |
| --- | --- |
| #43 | pm-swarm-1ii8 (sentinel migration), pm-swarm-4msd (privacy oracle repair) |
| #65 | pm-swarm-durable-close-recovery (crash recovery), pm-swarm-9bks (reporter memory) |

These are separate defects/features delivered through shared PRs. No items were merged or closed.

## Import gate evidence

6 planned, 0 skipped, 2 matched by provenance, 0 adopted, 4 new.

For non-blocked importers the read-only command is:

```sh
pm github import unbraind/pm-swarm --state all --atomic --gate --dry-run --with-comments --json
```

Command output (exit 0):

```text
pm github gate: plan verified — 6 planned, 0 skipped, 2 matched by provenance, 0 adopted, 4 new.
[dry-run] Atomic plan would import 4, update 2, skip 0. Adopt 0.
```

A passing plan proves completeness and identity planning, not successful writes or a new scheduled CI run. Shared reference tags remain references; new mirror items in a plan are not applied by this investigation.

## Validation

Typecheck and lint pass. The pinned tracker validation returns `ok: true` with existing advisories. The seeded tracker validation and gated import preview also pass through `pm test --run --progress`. Package quick tests are still running at the initial draft; no full passing package suite is claimed. Remaining results are recorded in the linked sync repair item. CI is not dispatched manually, and no successful scheduled rerun is claimed.
