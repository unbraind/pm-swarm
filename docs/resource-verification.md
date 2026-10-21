# Resource reservation verification

Tracked in [pm-swarm-resource-reservations](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-resource-reservations.toon).
This feature builds on PR #12 and must merge after it. No release is performed.

## Public corpus

`PUBLIC_TRACKER_REPO` selected a read-only checkout of public `unbraind/pm-ops`.
`node --test test/resource-corpus.acceptance.ts` extracted its committed tracker
at `eba7d5262fd75e67afce0caad29dae7dc7dfbaeb` into a non-Git temporary directory.
All baseline files were made read-only before the SDK read. The feature exercised
only one newly created synthetic resource. The original checkout was never
modified. The native CLI status check ran without Git in PATH.

| Measured observation | Result |
| --- | ---: |
| Certified public corpus items | 146 |
| Baseline files / bytes | 300 / 3,689,055 |
| Baseline SHA-256 digests changed | 0 |
| Synthetic resource records | 1 |
| Successful resource mutations | 7 |
| Exclusive refusal / stale publication refusal | 1 / 1 |
| Final released generation | 4 |
| Final compact JSON bytes | 89 |
| Coordination and read phase | 41,224 ms |
| Test case / total runner duration | 42,723 / 48,275 ms |
| Tests / failures / skips / cancellations | 1 / 0 / 0 / 0 |

Timing reflects the loaded development host, not a latency guarantee. Hosted
Postgres/MCP adapters, arbitrary core writers and external resource sinks are
outside this filesystem acceptance. An explicit backend must supply shared
fencing and atomic commits; refusal never chooses another backend.

## Behavioral revert proof

Each independent disposable source copy reused pinned dependencies and the final
real-tracker regressions. No PM SDK or tracker was mocked. Source imports need no
dist rebuild. The working implementation was never reverted.

| Behavior removed in isolation | Targeted test command | Result |
| --- | --- | --- |
| `ResourceReservations.reserve` exclusive-owner check | `node --test --test-name-pattern="resources on one non-Git tracker" test/resources.test.ts` | Exit 1; 0/1 pass, missing busy rejection |
| `ResourceReservations.fence` principal/token/expiry check | `node --test --test-name-pattern="expired resources admit" test/resources.test.ts` | Exit 1; 0/1 pass, missing stale-fence rejection |
| `trackerResourceBackend` unsupported-storage refusal | `node --test --test-name-pattern="resource backend refusal propagates" test/resources.test.ts` | Exit 1; 0/1 pass, missing backend refusal |

All three failures are assertions, with zero cancellations. Tests also check
same-author ABA, no history appended on refusal, one-update publication, renewal,
malformed state preservation, ordinary item protection, compact TOON/JSON,
Git-free commands and three real competing processes receiving one winner.

## Gate provenance

Full npm and Bun release checks are delegated to CI because the development CPU
is saturated. Thresholds and source scope are unchanged. CI receipts are recorded
after completion. Local targeted checks are recorded separately from full-gate
acceptance. An initial PM-linked aggregate suite hit its existing 120-second
limit under host contention after four passing cases; that run is failed timeout
evidence, not acceptance. No test deadline or gate threshold is increased.

## Local focused receipts

`npm run typecheck`, `npm run lint`, `npm run build`, `npm run docstring`,
`npm run duplication`, `npm run identity:check` and the generated changelog check
pass. Docstrings cover 27 authored files and 81 declarations; duplication is
zero. Strict core tracker health passes with six existing stale-item advisories.

The aggregate focused c8 run passes 7/7 with no skips or cancellations and
measures all four dimensions at 100 percent across the two resource modules.
That run precedes the additional conservative refusal for empty capability
lists; the targeted backend regression passes again after the refinement. Final
whole-package coverage is established independently by CI.

The same seven resource scenarios are linked through the pinned PM runner in
three groups, preserving the existing per-command 120-second limit:

| Exact linked command | Passing result | PM elapsed |
| --- | --- | ---: |
| `node --test --test-name-pattern="tracker\|expired\|validation\|backend\|records" test/resources.test.ts` | 5/5 | 15,144 ms |
| `node --test --test-name-pattern=CLI test/resources.test.ts` | 1/1 | 35,925 ms |
| `node --test --test-name-pattern=process test/resources.test.ts` | 1/1 | 14,674 ms |
| `node --test --test-name-pattern="shared assigned-only lanes" test/mixed-tracker.test.ts` | 1/1 | 15,155 ms |

All passing executions have zero failures, skips and cancellations. The first
split SDK execution fails the newly added missing-capability refusal test before
its guard is corrected; the table records the successful corrected repetition.
Existing project policy disables automatic result recording, so PM comments
retain the measured receipts.

CI attempt [39677319757](https://github.com/unbraind/pm-swarm/actions/runs/39677319757)
on `85fca39` is failed evidence: both Node matrices pass 190/191 with full coverage,
but one existing README wording assertion fails. The README now retains the
assigned-item contract phrase and immediately states the resource exception;
assertions and application source are unchanged. The focused case passes 1/1
both directly and through PM. Release steps correctly do not proceed on that
failed suite. Successful complete-gate receipts follow.

The three core revert proofs were repeated against the current source and tests
on `f340c88`; each again fails 0/1 by assertion, exit 1, with no cancellations.
A fourth isolated revert removes only resource exclusion in
`Swarm.readyCandidates`: `node --test --test-name-pattern="resource records never"
test/resources.test.ts` fails 0/1 because the incorrectly selected resource
reaches the independent start guard (`Resource items require swarm resource`).
That guard still prevents a work claim; the regression requires no resource to
be selected at all. This additional behavioral failure is an explicit refusal,
not a timeout or canceled test.

## Complete CI release receipts

Application head `f340c885b1e07f12c1796c74979e829b9da8a47f` passes
[CI run 39677832478](https://github.com/unbraind/pm-swarm/actions/runs/39677832478).

| Execution | Source tests | Packed acceptance | Statements / branches / functions / lines |
| --- | --- | --- | --- |
| Node 22 npm release steps | 191/191 | 3/3 | 100 / 100 / 100 / 100 percent |
| Node 26 npm release steps | 191/191 | 3/3 | 100 / 100 / 100 / 100 percent |
| Complete `bun run release:check`, Node 26 | 191/191 | 3/3 | 100 / 100 / 100 / 100 percent |

Every successful suite reports zero failures, skips and cancellations. All 27
configured authored files are measured at unchanged thresholds. Clean CI strict
tracker health, identity/privacy, typecheck, lint, zero duplication, docstrings,
build, production audit, package contents, changelog and publish attestation all
pass. Production audit reports zero vulnerabilities. All three package dry runs
report shasum `b6927438f55439898744d9340920644f8a4f9fc3`.

During the required final pre-push refresh, #12 advances to `4d6a708`, adding
Git sync fencing and its review regressions. The merge retains both that fencing
and this feature's resource exclusion; its sole textual conflict is the import
list in `src/swarm.ts`. The earlier passing CI receipt above remains tied to
`f340c88`. The combined head receives fresh full CI evidence; it is not represented
as a documentation-only change. Final-head CI is linked in the PR. Existing
history records remain unchanged byte prefixes. #12's branch is never pushed.
The PR remains ready for review with base `main`, explicitly dependent on #12.
No PR merge or release is performed. No new PM CLI/SDK defect was identified.

## Latest prerequisite integration

Combined application head `ecda51c` includes #12 at
`4d6a708715ec38700712df88c224f6b8fb73437f`. The resource SDK and model are
unchanged; the upstream Git-sync fencing and eight new review regressions are
retained. Focused resource/expiry selection passes 6/6, and the complete
PM-linked `node --test test/review-r6.test.ts` passes 8/8 in 6,428 ms. Typecheck,
lint, docstrings and zero duplication pass again.

`node --test test/resource-corpus.acceptance.ts` passes again on this combined
source, 1/1 with zero failures/skips/cancellations. The same public source head,
146 items, 300 read-only baseline files and 3,689,055 baseline bytes are checked.
There are again seven successful resource mutations, one busy refusal and one
stale refusal, final generation 4, 89-byte JSON, and zero changed baseline
hashes. The measured coordination/read phase is 3,641 ms, the test case is
3,908 ms, and total runner time is 4,712 ms. These timings are a separate
loaded-host observation, not a performance target or replacement for the
initial receipt's measured duration.

## Combined-source full gates and final handoff

Combined application head `ecda51c837a0db249d0f9852c0d18fbdd374d9f8` passes
[CI run 39679043493](https://github.com/unbraind/pm-swarm/actions/runs/39679043493).
The increased count includes #12's eight review-round regressions.

| Execution | Source tests | Packed acceptance | Statements / branches / functions / lines |
| --- | --- | --- | --- |
| Node 22 npm release steps | 199/199 | 3/3 | 100 / 100 / 100 / 100 percent |
| Node 26 npm release steps | 199/199 | 3/3 | 100 / 100 / 100 / 100 percent |
| Complete `bun run release:check`, Node 26 | 199/199 | 3/3 | 100 / 100 / 100 / 100 percent |

All suites have zero failures, skips and cancellations. All 27 authored files
remain measured at unchanged thresholds. Every CI gate passes, including strict
tracker health, identity/privacy, typecheck, lint, zero duplication, 81 documented
declarations, production audit (zero vulnerabilities), package contents,
changelog and publish attestation. Every package dry run has shasum
`9ea1994a4c840ee46383a662a8a9b4d0a1356aef`.

The final required fetch also brings #12's `2fadac3`, which changes only its
verification documentation and append-only tracker evidence/claim release. This
merges cleanly. Published package inputs remain byte-identical to the passing
combined application head. The final commit adds those prerequisite receipts,
this verification note and append-only resource PM results, and releases our
feature claim while keeping it in progress. Final-head CI is linked in the PR.
No PR is merged and no release is made. Hosted backend acceptance and external
sink fencing retain their explicit boundaries above.
