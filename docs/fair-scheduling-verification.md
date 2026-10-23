# Fair scheduling verification

The opt-in `schedule` command uses SDK certified complete reads, SDK actionability
and existing swarm next/start ownership and conflict checks. Hard skill tags and
active conflicts constrain eligibility; creation-age promotion prevents newer
qualified work from indefinitely outranking older safe work. Explicit receiver
handoffs retain context and generation checks. No agents are launched.

## Read-only public corpus

Source: public [unbraind/pm-ops](https://github.com/unbraind/pm-ops), committed
`origin/main` snapshot `93e871f895f4e489550ef92601c9064a311889ce`.
Repository visibility was checked through the GitHub API. Only committed tracker
files were archived into a scratch tracker outside Git. Baseline files were made
read-only and SHA-256 checked after two identical-clock SDK previews and JSON/TOON
CLI previews. The source checkout was never modified. The CLI ran with Git absent
from PATH and a Git ceiling above the scratch directory.

| Measurement | Result |
| --- | ---: |
| Public items | 149 |
| Baseline files | 306 |
| Baseline bytes | 4,075,113 |
| Changed baseline files | 0 |
| Ready / skill-qualified / age-promoted | 10 / 10 / 10 |
| Known conflicting candidates | 3 |
| Selected while active lanes constrain unknown work | 0 |
| Decision rows / omitted | 5 / 5 |
| JSON / TOON bytes | 863 / 596 |
| Equal-clock SDK previews with identical receipts | 2 |
| CLI previews | 2 |
| Native skill tags / continuity preferences | 0 / 0 |

This corpus proves conservative selection and bounded output on real tracker
metadata. It contains no native skill requirements or cost preferences. Those
policies, starvation promotion, receiver context and process concurrency are
validated separately with real SDK-created trackers; they are not inferred from
this corpus. A preview makes no claim. Hosted storage scheduling is refused by
the local adapter and is not certified.

Reproduce against the public source checkout using:

```sh
PUBLIC_TRACKER_REPO="public-pm-ops-checkout" node --test test/scheduling-corpus.acceptance.ts
node --test test/fair-scheduling.test.ts
```

## Behavioral regression proof

With only `FairPolicy.select` temporarily restored to the original `selectNext`
priority policy, `node --test --test-name-pattern='aging promotes'
test/fair-scheduling.test.ts` failed one assertion: the fresh priority-zero item
was selected instead of the aged priority-four item. The implementation was
restored and the focused suite passed. This is a behavioral revert, not a missing
export or build-error proof.

CI runs the exact unchanged-threshold `npm run release:check` on Node 22 and 26,
and `bun run release:check` on Node 26. The PR records the final run and counts.
