# Shared Plan progress validation

## Ownership and overlap

Core Plan owns steps, owners, evidence, decisions, validation and approval mode.
pm-review owns exact-head GitHub review findings and review rounds. pm-context
assembles context. pm-swarm composes these existing Plan declarations into one
parallel progress view; it neither lands branches nor introduces a second task
tracker. Progress adds no GitHub transport and never invokes Git; the selected
SDK storage backend owns any storage I/O.

The SDK minimum/dev pin is 2026.10.23 because concurrent witness comments need
the released expired-mutation-lease fence and queued-writer deadline fixes.

## Public tracker experiment

Command (provide the public checkout through the environment):

```sh
node --test test/progress-corpus.acceptance.ts
```

The test confirms the source repository is public, archives only its committed
tracker to a non-Git scratch project, and makes copied baseline files read-only.
It uses the real SDK and real CLI with no Git executable on PATH. It hashes every
baseline file before and after. Source repository files are never changed.

Measured public snapshot: `unbraind/pm-ops` at
`08febd274c40d2ec31bfe956438449898af1d885`.

| Measurement | Result |
| --- | ---: |
| Public items certified through SDK | 149 |
| Existing public Plan items | 0 |
| Copied baseline files | 306 |
| Copied baseline bytes | 4,075,113 |
| Baseline files changed | 0 |
| Labeled synthetic overlay Plans / steps | 1 / 3 |
| Claimed / produced / reviewed / accepted steps | 1 / 1 / 1 / 1 |
| Accepted after criterion change | 0 |
| Compact JSON / TOON bytes | 691 / 548 |
| Item-history mutations from reads | 0 |
| Measured operation time, milliseconds | 59,082 |

The source contains no Plan items. The three-step Plan is explicitly synthetic
and tests integration with the public tracker's actual settings and corpus;
these measurements do not imply organic Plan usage, hosted-provider acceptance,
or a throughput benchmark. SDK storage-provider dispatch is retained; no hosted
service is accessed for this validation.

## Concurrent writers and regression

`test/progress.test.ts` creates real temporary trackers outside Git. Four
independent processes append reviewer witnesses to the same Plan item, then an
additional old-revision comment races a core criterion update. Every successful
append survives, all six witnesses remain available, and acceptance of the
changed criterion is zero. Ordinary core writers participate through the SDK,
without a package-local process pin or a Git repository.

Targeted validation includes the real CLI's TOON/JSON parsing, read-only previews,
SDK idempotent appends, owner/reviewer/orchestrator separation, stale revisions,
malformed witness refusals and 102-step pagination with exact denominators.
