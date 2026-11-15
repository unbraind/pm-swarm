# Fleet CI v2

Required checks remain `test (22)`, `test (26)` and `codeql`. CodeQL is required
and deliberately has no path filters. PRs and dispatch run quick hosted tests;
older PR runs cancel and every job is bounded to 30 minutes. Main pushes,
dispatch and nightly 02:49 UTC run four distinct deep Node 22/26 × npm/Bun jobs,
each executing one full gate with a 120 minute timeout and time scale 3. This
avoids release cron minutes 23/41. Local runners use persistent npm cache and
preinstalled Bun (version logged). PM_LOCAL_DEEP=off selects hosted fallback;
per-ref deep concurrency cancels superseded runs. Existing action pins remain.

| Check | Code PR Node 22 | Code PR Node 26 | Docs/tracker (both) | Deep each leg |
| --- | --- | --- | --- | --- |
| npm ci / prepare | yes | yes | yes | yes |
| Strict health / merge drivers | — | yes | yes | yes |
| Identity and private-path policy | explicit step | explicit step + release gate | explicit step | release gate |
| Build and test suite | quick | quick coverage | docs/privacy suites | full |
| Typecheck, lint, duplication, docstrings | — | yes | applicable tooling tests | yes |
| Coverage: 100% statements/branches/functions/lines (unchanged) | — | quick | — | full |
| Production dependency audit | — | yes | — | yes |
| Pack dry run (README, architecture, license, changelog) | — | yes | yes | yes |
| Changelog consistency / full-read bridge | — | yes | yes | yes |
| Publish attestation verifier | via tests | yes | release contract tests | yes |
| Packed install acceptance (npm/npx + native Bun/bunx) | — | yes | — | yes |
| Bun graph installation smoke | — | yes | — | yes |
| Required CodeQL | separate workflow, all paths | separate workflow, all paths | yes | main pushes plus unchanged Monday 01:47 UTC scan |

No original gate check is removed. The docs path includes every privacy suite,
tooling/identity contracts, release/README/architecture/license contracts,
review documentation contracts, mixed-tracker documentation and the tracker-read
latency record contract. Identity policy scans tracked files and commit data;
packing includes shipped Markdown, so both remain on the docs path. There is no
standalone Markdown linter. Existing standalone scale and external-corpus
acceptance commands remain available; they were not part of the original gate.

Quick depth is a deterministic prefix: 50/500 deadlock model operations,
100/1000 declaration cases, 25/200 deadline properties, 500/5000 privacy cases,
50/500 normalization cases per configured home, 25/250 punctuation cases per
home and 25/128 decoder homes. Counts use generated cases. The four explicit
late-seed Unicode regressions still use their original full generator indexes;
they are deterministic fixtures, not a shortened property corpus. Product size
boundaries and the exhaustive close-crash matrix remain intact.

Harness budgets validate a finite positive scale before child launch and round
up milliseconds. Shared child helpers, install/watch watchdogs and slow scan
regression timers scale; product lease, lock and linked-test deadline assertions
remain unscaled. Packed acceptance in the release gate already proves npm/npx
and native Bun/bunx install paths, so the extra Bun step only installs the graph.

Owner fleet baseline: 39,929 runner-minutes in 24 h, median PR CI 45–90 minutes
including about 28 minutes queueing. Main run 43735415781 required checks took
45m08s (Node 22) and 59m47s (Node 26), creation to completion. Full Node 26
close-crash matrix tests took 74–75 s, 106–110 s and 143–144 s for one/two/three
dependents; punctuation privacy took 78–79 s. These are historical measurements,
not a controlled quick/full benchmark. New quick and final CI timings are pending.
Full local depth is deliberately not run on the overloaded host.
Companion: pm-cli-website-dyhg.

## Local quick validation

The bounded local run passed 131/132 tests in 504.16 s. Its sole unexpected
failure required the original named identity-policy step in CI; that unconditional
step is restored, covering both code legs and the docs path. It was never removed
from the release gate. All model/privacy per-case assertions passed, including
four explicit late-seed Unicode regressions. The narrow identity workflow contract
is rerun after restoring the step.

Local quick timings: deadlock model 29.02 s, privacy home/allowed corpora
14.96/12.65 s, normalization 16.64 s, punctuation 97.04 s. Punctuation's historical
hosted full result was 78–79 s, demonstrating the host contention caveat rather
than a same-hardware speed comparison. Typecheck, lint, identity policy (zero
violations), publish verifier and strict YAML parse passed. Local strict health
has the existing managed extension mismatch, tracked by pm-swarm-ci-extension-host-skew.
No full local depth or separate coverage run was attempted. Final quick coverage,
packed installation acceptance and deep certification remain pending CI.

## Review round E

The failed logs identify two rollout regressions: install-prerequisites copied install-helpers without its new support/time.ts dependency; the strict child-deadline audit rejected an inline testTime call. Copy the helper dependency and teach the strict audit to recognize the validated scaling helper only with positive literal or declared timeout bases. Regression cases retain refusals for missing, zero, negative and unvalidated budgets. Targeted review and tooling checks passed.

The cheap tier excludes only inert tracker record formats; executable tracker changes keep product gates. `test/ci-routing.test.ts` executes each detector with inert and executable tracker paths. Product deadlines, full-depth cases and coverage thresholds are unchanged.
