# Resource deadlock validation

The overlap recheck found core claim fencing/native history and SDK
`collectOrderingCycles`, structural analysis in pm-graph and scheduling analysis
in pm-gantt-chart. Swarm already reserves single resources and selects ready work;
none of those surfaces records pending multi-resource waits. This feature composes
those authorities without changing claims, dependencies or reservation ownership.

The non-git regression uses two fenced holders, alpha holding resource-a and beta
holding resource-b. Each declares the other resource as pending. Assertions compare
both exact wait edges, the SDK component `[alpha, beta]`, and both manual release
alternatives. Native resource histories remain byte-identical after detection.
Expiry and successor generations remove the old request from the projection.

The seeded model exercises 500 sequences of preview, declaration/withdrawal and
random older-input replay against native history revisions. It reads state through
the SDK, checks request fields against an independent model, and preserves seeded
native relationships, ownership and foreign fields under changing session focus.
Whitespace/CRLF variants share the production parser. Another 1,000 seeded schema
cases exercise all array sizes through 16 and token sizes through 80 decimal digits.
Sparse arrays, nonfinite values and malformed or oversized inputs are refused.

An independent SDK request injects a competing title edit and restoration at each
native admission boundary. The final document matches the original but native
history has advanced: the pending-request write must refuse. No peer state is
removed or rolled back.

## Public tracker observation

Source: public `unbraind/pm-swarm`, main revision
`3ee1ad5be14023fe7bfa355b5bd4e2fb0e16d16a`. Only its tracked tracker files were copied
to a plain scratch directory. Every tracker file and directory was made read-only
before observation, with Git discovery bounded outside the directory. The source
checkout was never changed. Run `node test/deadlocks-public.acceptance.ts <copy>`
to reproduce on another explicitly supplied public tracker copy.

| Measurement | Result |
| --- | ---: |
| Items read through the SDK | 32 |
| Resource items | 0 |
| Pending requests / wait edges / cycles / alternatives | 0 / 0 / 0 / 0 |
| Observation duration on the contended development host | 11,128 ms |
| Added, changed or removed tracker files | 0 |

The full tracker file digest before and after was
`df704e1ab4d8162b85b3a1a61d8721fc07a42469b8af8b979f15f36a591769e9`.
The public tracker contains no resource reservations; this is a compatibility and
read-only observation, not evidence of real-world deadlock discovery. The synthetic
pair supplies the positive feature acceptance evidence. A cold writable SDK guard
list can create ignored metadata caches; the same read succeeds when cache writes
are unavailable on a read-only tracker.

Full npm and Bun release gates, existing 100% coverage thresholds, installation
acceptance and privacy/identity checks run in CI. Exact results and run links are
recorded on the feature item and PR after validation. No merge or release is part
of this change.
