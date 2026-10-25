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

`scanMutationSecrets` from the pinned SDK 2026.10.23 is queried for the
`absolute_home_path` finding for every raw string and normalized candidate. The
package does not maintain an independent Unix home-path detector. Its stricter
normalization layer exists because the pinned oracle misses the forms measured
below: URI escape decoding (including nested and malformed octets), NFKC,
explicit Cyrillic confusables, invisible/bidi controls, slash folding, file URL
and Windows UNC authorities, case-folded home layouts, shell home references and alternate home directory layouts. Only
canonical candidates are scanned; normalization never changes a persisted input.
Credential findings retain the native host's separate secret policy.

The corpus is defined exactly in `test/privacy-corpus.ts`. Synthetic locations
are constructed from segments, and no local coordinates are recorded here.
Unicode fixtures use fullwidth slash/letters, division slash U+2215, fraction
slash U+2044, Cyrillic o U+043E, Cyrillic s U+0455, zero-width U+200B and bidi
U+202E; the combined fixture URI-encodes the fullwidth slash form. The Windows
UNC fixture includes a server authority; forward-slash and mixed fixtures use
lowercase and mixed-case directory names, respectively.

The raw SDK detects **10 of 50** fixtures. The normalized guard refuses **all 50**.
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
SDK: **16 mutating variants, 50 encodings, 197 text input positions, 9,914 refusals**
(including 64 malformed scalar cases). It snapshots every tracker file byte,
directory entry and symlink, including runtime files and all history, before and
after every refusal, and captures stdout to prohibit partial receipts. A separate
**1,050-case** matrix covers 21 SDK mutation entries; 39 malformed domain inputs
receive the same byte-invariance checks. Two native CLI cases reproduce the
review's handoff failures with a valid owner/fence and check the whole tracker.
All 400 encoding/format/result-shape combinations retain renderer ownership and emit only the
safe refusal. These attest input refusal, rather than promising that I/O failures
or later concurrent state changes can never need recovery.

```sh
node --test --test-concurrency=1 test/privacy-admission.test.ts test/settings-and-output.test.ts test/commands.test.ts
npm run typecheck
npm run lint
# Full gates run in CI on the saturated host's behalf.
npm run release:check
bun run release:check
```

Behavioral revert proofs are recorded as append-only comments on pm-swarm-y972.
The original native SDK settings-section registration gap remains unchanged; see
[settings verification](settings-and-quality-gates.md).
