# Input admission and SDK privacy oracle

Every swarm command snapshots caller-owned argument, option and global containers,
then enters `validateCommandInputs` before dispatch, settings reads,
backend discovery or writer leases. It checks all argument/flag string leaves and
keys, all supplied global flags, scalar/boolean shapes, numeric action domains, settings
values, explicit footprints and witness declarations. Privacy validation precedes
all these checks, so malformed private input cannot select a different diagnostic
that echoes its value. Expected-error recovery withholds the original arguments.

Public SDK mutation entry points independently check their inputs before entering
leases or writing heartbeat, item, progress or resource records. Settings preflight
reads and validates its effective section without writing, then re-reads it inside
the audited settings callback. The preliminary read never supplies the committed
snapshot. Race tests inject invalid Unix and drive-letter roots after preflight;
the locked validator refuses without overwriting peer settings or audit history.
Resource renew/release/publish also validate canonical decimal tokens before a
backend lease, reusing one pure validator across CLI and SDK entry points. Ownership and fencing decisions retain their existing locked checks.

## Oracle and normalization

`scanMutationSecrets` from the pinned SDK 2026.10.23 remains the first layer
for raw `absolute_home_path` findings. An independent complete root rule then
refuses **any absolute local filesystem path**, independent of directory names.
Each string reaches a bounded fixed point (at most sixteen rounds) of URI percent
decoding, JSON Unicode/hex/slash escapes, numeric and named HTML escapes, Unicode
NFKC and explicit confusable folding, and zero-width/bidi stripping. Malformed
URI octets cannot conceal adjacent valid ASCII; unresolved excessive nesting is
refused. Tokens peel repeated labels and file URL schemes, preserve web URL schemes,
handle brace wrappers and shell-variable braces, then pass through
both `path.posix.normalize` and `path.win32.normalize`. Either absolute grammar,
drive roots, UNC authorities, tilde roots and shell variable roots cause refusal.
Dot segments and duplicate/mixed separators cannot turn an absolute path into an
allowed relative candidate. HTTP(S) URL tokens and relative paths remain allowed;
separately supplied absolute values in a URL query remain subject to the guard.
Normalization never changes a persisted input. Credential findings retain the
native host's separate secret policy.

File URLs are absolute in URL grammar even when they omit explicit slashes.
The additional identities `file-implicit-path`, `file-dot-relative`,
`file-parent-relative` and `file-empty-root` cover those forms. All four are
missed by the raw SDK oracle and refused across nineteen mutating variants
(76 unchanged-tracker refusals) and both renderers (eight safe documents).

The corpus is defined exactly in `test/privacy-corpus.ts`. Synthetic locations
are constructed from segments, and no local coordinates are recorded here.
Unicode fixtures use fullwidth slash/letters, division slash U+2215, fraction
slash U+2044, Cyrillic o U+043E, Cyrillic s U+0455, zero-width U+200B and bidi
U+202E; the combined fixture URI-encodes the fullwidth slash form. The Windows
UNC fixture includes a server authority; forward-slash and mixed fixtures use
lowercase and mixed-case directory names, respectively.

The raw SDK detects **10 of 50** fixtures. The normalized guard refuses **all 50**, plus both round-2 dot-segment and forward-UNC cases.
Every row marked missed is an exact SDK-gap encoding identity for upstream reports.

| Encoding identity | Raw SDK | Package guard |
| --- | --- | --- |
| unix-home | detected | refused |
| unix-users | **missed** | refused |
| unix-root | **missed** | refused |
| single-quoted | detected | refused |
| double-quoted | detected | refused |
| angle-bracketed | **missed** | refused |
| file-url | **missed** | refused |
| angle-file-url | **missed** | refused |
| file-localhost | **missed** | refused |
| percent-upper | **missed** | refused |
| percent-lower | **missed** | refused |
| percent-double | **missed** | refused |
| percent-triple | **missed** | refused |
| percent-file-url | **missed** | refused |
| malformed-percent-prefix | **missed** | refused |
| malformed-utf8-prefix | **missed** | refused |
| json-escaped-slashes | **missed** | refused |
| windows-unc | **missed** | refused |
| windows-backslash | **missed** | refused |
| windows-forward | **missed** | refused |
| windows-mixed | **missed** | refused |
| windows-file-url | **missed** | refused |
| tilde-slash | **missed** | refused |
| tilde-named | **missed** | refused |
| tilde-backslash | **missed** | refused |
| home-variable | **missed** | refused |
| home-braced | **missed** | refused |
| userprofile-percent | **missed** | refused |
| userprofile-powershell | **missed** | refused |
| trailing-parenthesis | detected | refused |
| trailing-bracket | detected | refused |
| trailing-comma | detected | refused |
| trailing-period | detected | refused |
| unicode-fullwidth | **missed** | refused |
| unicode-division-slash | **missed** | refused |
| unicode-fraction-slash | **missed** | refused |
| unicode-cyrillic-o | **missed** | refused |
| unicode-cyrillic-s | **missed** | refused |
| unicode-zero-width | **missed** | refused |
| unicode-bidi | **missed** | refused |
| markdown-emphasis | **missed** | refused |
| assignment | detected | refused |
| cli-equals | detected | refused |
| url-query | detected | refused |
| unicode-symbol-prefix | **missed** | refused |
| home-variable-bare | **missed** | refused |
| tilde-bare | **missed** | refused |
| bracket-file-url | **missed** | refused |
| colon-prefix | **missed** | refused |
| percent-fullwidth | **missed** | refused |

## Renderer boundary

The host catches renderer exceptions and returns `overridden: false` with an
`extension_renderer_failed` warning, allowing a native renderer fallback. A thrown
privacy refusal alone therefore cannot secure this boundary. Swarm returns a
small typed refusal document instead, retaining renderer ownership. No original
result value or partial receipt reaches that document. JSON and TOON are tested
for every encoding; watch frames are checked before the first stream write.

## Evidence

The Cartesian command test uses one real non-Git tracker and the actual injected
SDK: **19 mutating variants, 52 encodings, 242 text input positions, 12,660 refusals**
(including 76 malformed scalar cases). It snapshots every tracker file byte,
directory entry and symlink, including runtime files and all history, before and
after every refusal, and captures stdout to prohibit partial receipts. A separate
**1,092-case** matrix covers 21 SDK mutation entries; 39 malformed domain inputs
receive the same byte-invariance checks. Four native CLI cases reproduce the
review's handoff failures with a valid owner/fence and check the whole tracker.
All 416 encoding/format/result-shape combinations retain renderer ownership and emit only the
safe refusal. These attest input refusal, rather than promising that I/O failures
or later concurrent state changes can never need recovery.

```sh
node --test --test-concurrency=1 test/privacy-admission.test.ts test/privacy-refusals.test.ts test/privacy-routes.test.ts test/privacy-guard.test.ts test/privacy-lease.test.ts
node --test test/privacy-fleet.acceptance.ts test/sdk-read-effects.acceptance.ts
npm run typecheck
npm run lint
# Full gates run in CI on the saturated host's behalf.
npm run release:check
bun run release:check
```

Behavioral revert proofs are recorded as append-only comments on pm-swarm-y972.
The original native SDK settings-section registration gap remains unchanged; see
[settings verification](settings-and-quality-gates.md).

## Compositional regression

`test/privacy-fuzz.ts` generates **5,000 absolute candidates** from seed
`0x51a7c0de`, applying one through four randomly selected transformations:
percent encoding, dot segments, duplicate/mixed separators, UNC authorities,
file URLs, wrappers, confusables, invisible/bidi characters, case, punctuation,
HTML entities and JSON escapes. Every candidate is refused by all nineteen
mutating variants (**95,000 command refusals**) and both renderers
(**10,000 safe refusal documents**), on one unchanged non-Git tracker.
A separate seed `0x6a09e667` generates **2,500 relative paths and 2,500 HTTP(S)
URLs**: all pass every command's privacy admission (**95,000 admissions**) and
both renderers (**10,000 successful renders**), with zero false privacy refusals.
The original fifty fixtures and both review reproducers remain fixed regressions.

## Whole-token path handling

Tokenization separates whitespace, then removes presentation delimiters only at
token edges. Parentheses, brackets, braces, slots and punctuation inside a path
never create another path candidate. Whole Markdown links and images unwrap their
target without splitting nested route folders. Leading labels and file schemes
are peeled at the edge; HTTP(S) schemes remain intact. Normalization classifies a
candidate but never rewrites the supplied path or its rendered value.

`test/privacy-path-samples.ts` commits thirteen relative shapes, including grouped,
dynamic, catch-all and parallel routes. Nine bare/prose/Markdown presentations
pass both renderer formats, and native non-Git plan/start/status commands preserve
the exact path values. `test/privacy-fleet.acceptance.ts` additionally generates
its corpus from read-only `git ls-files` calls in available local fleet checkouts.
It reports counts and an aggregate inventory digest, never stores the path list,
and disables optional Git locks. The snapshot's parenthesis/bracket/slot counts
are reported separately so synthetic route coverage is not confused with fleet
inventory coverage.

## Registry-driven refusal admission

`src/commands.ts` declares mutation variants beside the actual command definitions.
The SDK activation registry is reconciled against that metadata: thirteen mutating
commands, nineteen variants, including every progress stage and resource action.
The separate property matrix covers **509 input refusals** and **35 state/backend
refusals**, collectively exercising all fifteen typed refusal categories, plus
ordinary missing-item, terminal, foreign-owner, malformed-generation, strict
conflict and no-Git refusals. Each case hashes every tracker byte, directory entry
and symlink, including history and runtime, and captures stdout to reject partial
receipts. State cases use a tracker whose complete-list cache was prepared by the
SDK during fixture setup; the cold-read limitation below remains explicit.

Local mutation-guard lookups use the SDK's `createMutationGuardSdk.get`, retaining
SDK schema, identity and parsing behavior without client usage/cache writes.
Service declarations defer to the bound client rather than reading a local shadow.
The local-only resource adapter instead refuses if a provider appears between
ownership discovery and metadata inspection; it never falls back to a bound
client whose storage cannot satisfy that adapter's fencing contract.
Shared start checks prospective files and overlap warnings before ownership;
Git start checks its portable receipt before claiming. Tests inject a real peer
file transition after corpus enumeration and before the client read, proving that
the final fresh receipt is checked again. Next/schedule validate explanations
before starting selected work. Resource metadata and configured progress actors
are checked before publication. Recovery skips unsafe foreign context with a
reason while truthfully retaining other completed transfers.

Lease acquisition keeps its coordination generations transient. Principal
heartbeats are announced after successful writes or completion, and failed
validation removes only empty infrastructure directories created by that call.
Atomic empty-directory removal preserves peer records; a publisher recreates a
parent removed at its first write boundary. Filesystem interleavings, real I/O
failures and reruns verify cleanup, liveness and retained data.

## SDK read-effect limit

Pinned SDK 2026.10.23 `PmClient.get()` records current-read context usage, and full
gets or `listAllComplete()` may materialize metadata caches. `PmClientOptions`,
`GetOptions` and `PmCompleteListOptions` expose no per-call no-write mode; the
mutation guard's list method also uses the persistent cache. The package uses the
public guard's local item lookup where possible and preserves SDK-owned records.
It never rolls back derived files, disables configuration or reimplements listing.

`test/sdk-read-effects.acceptance.ts` measures a cold strict-overlap refusal:
item/history bytes remain identical, no package runtime records remain, but five
SDK metadata-cache files are created. Thus whole-tracker byte identity is measured
for the prepared-tracker refusal matrix, and is **not a universal cold-cache or
provider-read guarantee**. Follow-up: [pm-swarm-write-free-reads](../.agents/pm/issues/pm-swarm-write-free-reads.toon).
