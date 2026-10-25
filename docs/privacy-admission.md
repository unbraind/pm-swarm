# Private user-home admission and SDK privacy oracle

Every command snapshots caller-owned input containers and enters
`validateCommandInputs` before dispatch, settings reads, provider discovery or
writer leases. Every supplied string and string key is inspected. Privacy runs
before other input checks so a rejected value cannot select a diagnostic that
echoes it. Error recovery withholds original argument values. Public SDK mutation
entries independently validate before their first package write.

## Scope and canonicalization

The scope is **private user paths**, rather than every absolute filesystem path.
The guard recognizes conventional Unix and macOS user-home roots, the root user's
home, drive-letter Users directories, extended-device and UNC forms, named tilde
homes, HOME and USERPROFILE shortcuts, and configured/resolved process-home
spellings. Home variable names require a separator or identifier boundary, so
currency and unrelated variables remain ordinary text. A bare tilde home reference
is retained from the original fixed corpus; numeric approximations remain allowed.

`scanMutationSecrets` from SDK 2026.10.23 remains the first layer for
`absolute_home_path`. The second layer canonicalizes the **entire string** and
searches private-home substrings. There is no whitespace tokenization, wrapper
parser, drive-letter prose classifier or blanket URL acceptance.

At most sixteen fixed-point rounds fold Unicode compatibility/confusables and
strip zero-width/bidi controls, then decode percent octets and JSON/HTML escapes. UTF-8 decoding replaces each
invalid sequence with a replacement marker while preserving adjacent valid
multibyte sequences; malformed prefixes cannot erase encoded Unicode separators.
Folding also precedes percent decoding: fullwidth hex digits must not split valid
UTF-8 runs into malformed fragments. Excessive unresolved nesting refuses safely.
Classification then converts backslashes, removes dot-only path segments,
collapses duplicate separators and case-folds spelling. Every home-root pattern
is searched at every substring position, including URI authorities, paths,
queries, fragments, Markdown, JSON, shell and relative text. There is no URI or
UNC parser and no context exemption. Relative text containing a literal home-root
spelling is deliberately classified as private by this lexical rule; the real
fleet inventory reports no such relative paths.
Normalization classifies input and never rewrites persisted notes or file paths.

Ordinary prose, money, approximate times, regex backslashes, remote authorities,
web URLs without private-home content and non-home absolute paths remain allowed.
Field-specific domain rules still apply: persisted lane roots and linked
footprints must remain portable. Local Git root overrides retain their separate
path constraints. HOME, USERPROFILE, the detected process home and each available
realpath spelling pass through the identical canonicalizer used for candidates before they are
captured for the module's process lifetime; a filesystem root alone is not a private user folder.

## Rejected and benign corpora

`test/privacy-corpus.ts` retains the original **50** private encodings, both
round-2 reproducers, **31** embedded review forms and **two** malformed-UTF-8
Unicode-separator regressions: **85 rejected cases**.
They include multiword Markdown links and titles, comma-separated and JSON paths,
shell separators/redirections, underscore markup, reference links, shell
assignments, device/UNC paths, file URLs, and decoded URL paths/queries/fragments.
Only synthetic user identities are constructed; no private coordinates are stored.

The same module declares **34 benign cases**, including all reviewed prose forms,
remote schemes, non-home absolute paths and framework routes. The previous four
implicit file URLs outside user homes now belong to this allowed corpus.
Every benign case passes all **19** registry variants (**646 admissions**) and both
renderers (**68 renders**). Real SDK handoff persists all **34** notes and returns
truthful receipts. Child processes verify configured, resolved/symlink, future and
unset-root home behavior without printing those locations.

The raw SDK detects **10/50** original forms and misses both round-2 cases and all
31 embedded cases plus both malformed Unicode-separator cases: **10/85** detected.
The package refuses **85/85**. Original per-encoding findings remain below; the additional identities are in
`embeddedCorpus` and `malformedCorpus`, and targeted output reports each SDK miss by identity.

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

Additional fixed identities:

| Encoding identity | Raw SDK | Package guard |
| --- | --- | --- |
| dot-segment-root | **missed** | refused |
| forward-unc-authority | **missed** | refused |
| combined-markdown-csv-json-shell | **missed** | refused |
| markdown-spaced-label | **missed** | refused |
| csv-unix | **missed** | refused |
| json-windows | **missed** | refused |
| parenthesized-windows | **missed** | refused |
| shell-semicolon | **missed** | refused |
| shell-pipe | **missed** | refused |
| shell-redirection | **missed** | refused |
| markdown-underscore | **missed** | refused |
| markdown-reference | **missed** | refused |
| shell-tilde-assignment | **missed** | refused |
| csv-windows | **missed** | refused |
| json-array-unix | **missed** | refused |
| markdown-link-title | **missed** | refused |
| git-file-url | **missed** | refused |
| url-encoded-query | **missed** | refused |
| url-nested-home | **missed** | refused |
| url-comma-path | **missed** | refused |
| url-fragment | **missed** | refused |
| windows-device-users | **missed** | refused |
| windows-unc-spaced-share | **missed** | refused |
| windows-device-unc-users | **missed** | refused |
| json-home-variable | **missed** | refused |
| json-profile-variable | **missed** | refused |
| embedded-braced-variable | **missed** | refused |
| embedded-profile-powershell | **missed** | refused |
| html-embedded-home | **missed** | refused |
| relative-home-substring | **missed** | refused |
| relative-users-substring | **missed** | refused |
| relative-root-substring | **missed** | refused |
| url-prose-home-substring | **missed** | refused |

Additional malformed-sequence identities (raw SDK misses; package refuses both):

| Identity | SDK detects | Package refuses |
| --- | --- | --- |
| malformed-utf8-fullwidth | no | yes |
| malformed-utf8-fullwidth-suffix | no | yes |

## Rendering and validate-then-write

The host catches renderer exceptions and permits native fallback. Swarm returns
an owned, typed safe refusal document instead of throwing into fallback. JSON,
TOON and watch frames are checked before emission, including unexpected result
shapes, primitive values, arrays, keys and nested content.

The activation registry is reconciled against mutation metadata: **13 mutating
commands, 19 variants**, including every resource action and progress stage.
The fixed Cartesian property covers every rejected encoding and text position,
plus malformed scalar inputs: **20,646 refusals**, each with full tracker/history
byte, directory and symlink snapshots and zero partial receipts. Separate SDK
coverage exercises **21 entries / 1,785 refusals**, plus malformed domains.
All **680** fixed encoding/format/result-shape rendering combinations retain
ownership and emit only a safe refusal. Native CLI handoff repeats the four prior
reproducers plus all 31 embedded forms and both malformed Unicode-separator forms with
valid ownership and fencing.

The state/backend matrix retains **509 input refusals** and **35 prepared-tracker
state/backend refusals**, collectively all fifteen typed refusal categories plus
ordinary missing, terminal, foreign-owner, strict and no-Git refusals. Fresh
receipt checks remain before shared/Git ownership changes. Real peer transitions
between corpus enumeration and native reads prove revalidation. Recovery skips
unsafe foreign context with a reason while retaining completed peer successes.
Provider transitions refuse local resource admission rather than falling back to
storage outside the adapter's fencing contract.

Settings preflight and the locked audit callback both validate the effective
persisted root domain; narrowing privacy must not permit nonportable saved roots.
Resource records, progress authorities and ownership context retain their fresh
checks. Leases defer principal liveness until successful writes/completion and
remove only owned records and empty infrastructure created by the invocation.

## Source-independent mutation sinks

`commitMutation` in `src/settings.ts` checks the complete prospective payload
immediately before invoking its writer. Each writer consumes that admitted
payload. The source inventory parses every authored client call, SDK settings
mutation, portable backend transaction and imported linked-test writer; an added
or unguarded site fails the test until it joins the inventory and admission path.
The current inventory has **18 sites**: twelve item mutations (claim, update,
release, file links and comments), audited settings, linked-test acknowledgement,
linked-test execution, the shared portable resource transaction and two SDK
coordination lock acquisitions. All four
resource actions share that transaction, whose freshly decided change is also
admitted inside the backend callback. Full fresh settings patches, including
preserved foreign subtrees, pass the helper before audit publication. Existing
item snapshots are checked with their patches. Recovery skips unsafe foreign
context with a reason before releasing a claim or deleting a Git lane.

The same helper guards runtime-record publication and rendering/watch boundaries.
Storage coordinates used to select the tracker, lock, worktree or runtime file
are not serialized content. Git-derived sync links pass admission before an
effectful item read and again at the files writer. This closes the source gap
without maintaining separate Git, file, peer or argument privacy policies.

The inventory cross product supplies actual CLI, Git-diff, settings-file,
source-file and peer-comment values to every inventoried SDK/backend kind:
**18 sites × five sources = 90 refusals**, complete tracker/history snapshots,
zero changes and no partial receipt. End-to-end regressions separately exercise
Git-derived sync, fresh audited foreign settings, shared/Git recovery and real
handoffs. These properties retain the existing SDK read-cache limitation below;
they do not remove SDK-owned records to manufacture byte identity.

Malformed-neighbor containment uses seed **`0x8badf00d`**, **128 randomized homes**,
all **85 fixed encodings** and raw Unicode/nested percent/JSON/HTML forms:
**54,400 canonical substring-preservation checks** and **10,880 noisy-corpus
refusals**, zero lost paths. Each valid
encoded sequence survives random invalid-byte prefixes and suffixes. Process
probes cover fullwidth, confusable, NFD, case and percent spellings independently
through HOME and USERPROFILE: **ten environments / twenty actual handoff
refusals**, with complete tracker bytes unchanged. An uninspectable configured
root fails closed instead of silently dropping a protected identity.

## Seeded and real-path oracles

The round-2 generator keeps seed **`0x51a7c0de`**, **5,000** cases and one through
four composed transformations, now restricted to home roots: Unix/drive/UNC homes,
tilde, HOME and USERPROFILE. All nineteen variants refuse every case
(**95,000 refusals**) and both renderers refuse every case (**10,000 documents**),
with no tracker changes. Transformations retain percent encoding, dot segments,
duplicate/mixed separators, UNC, file URLs, wrappers, confusables, invisible/bidi
controls, case, punctuation, HTML entities and JSON escapes.

Seed **`0x6a09e667`** independently generates **2,500 relative paths + 2,500 web
URLs**: **95,000 admissions + 10,000 renders**, zero false privacy refusals.
Thirteen synthetic framework shapes cover grouped/dynamic/catch-all/parallel
routes in nine presentations. The read-only fleet oracle generates all tracked
relative paths using `git ls-files`, disables optional locks and reports counts
and an inventory digest. The path list is never committed.

## SDK integration limits

Native settings-section registration remains unavailable on pinned `ExtensionApi`;
normalized `readSettings` drops extension sections. Typed package metadata and the
audited raw-subtree bridge remain documented integration limits.

`PmClient.get` can record derived usage and `listAllComplete` can materialize SDK
metadata caches. `PmClientOptions`, `GetOptions` and `PmCompleteListOptions` expose
no per-call write-free read mode; the mutation guard's list method also caches.
Public `createMutationGuardSdk.get` supplies pure local metadata reads where
possible. Service-backed reads remain with the bound client.

The cold strict-refusal reproduction preserves item/history bytes and leaves no
package runtime records, but creates five SDK cache files. Whole-tracker refusal
invariance is therefore attested for the prepared state matrix, not universally
for cold or provider-owned reads. SDK-owned records are never rolled back or
deleted to hide this gap. Follow-up: [pm-swarm-write-free-reads](../.agents/pm/issues/pm-swarm-write-free-reads.toon).

## Reproduction

```sh
node --test --test-concurrency=1 test/privacy-sinks.test.ts test/privacy-home.test.ts test/privacy-admission.test.ts test/privacy-refusals.test.ts test/privacy-routes.test.ts test/privacy-guard.test.ts test/privacy-lease.test.ts
node --test test/privacy-fleet.acceptance.ts test/sdk-read-effects.acceptance.ts
npm run typecheck
npm run lint
# Full gates run in CI on behalf of the saturated local host.
npm run release:check
bun run release:check
```

Behavioral revert proofs and exact results are append-only comments on
pm-swarm-y972. Earlier all-absolute-path expectations are superseded by this
private-home scope; core ownership, recovery and field-domain checks remain.
