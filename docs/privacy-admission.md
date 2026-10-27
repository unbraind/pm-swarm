# Private user-home admission and SDK privacy oracle

Every command snapshots caller-owned input containers and enters
`validateCommandInputs` before dispatch, settings reads, provider discovery or
writer leases. Every supplied content string and string key is inspected. Host
invocation coordinates (`--path`, `PM_PATH`, cwd and resolved tracker/workspace
roots) select storage and are accepted as absolute or relative paths, including
home directories, spaces and Unicode. They are never persisted as item content
or copied into shared output. Privacy runs
before other input checks so a rejected value cannot select a diagnostic that
echoes it. Error recovery withholds original argument values. Public SDK mutation
entries independently validate before their first package write.

Incoming handoff metadata is preflighted before `next` or `schedule` enters its
operation lease. The public SDK mutation guard supplies local metadata; a
service-capable host retains its bound client, never a local shadow. Selection
still certifies one fresh complete corpus inside the lease and repeats receiver
shape, fence, skill and privacy checks. The complete prospective receiver receipt
is admitted before the embedded token cache changes. Handoff also previews its
current local document before acquiring a lease and repeats the fenced decision
inside it. Lease completion admits its shared result before announcing liveness;
local Git worktree coordinates receive the same relative projection as CLI
rendering. A refused receiver cannot extend stale-claim recovery.

`test/privacy-invocation.test.ts` keeps all 85 must-refuse content spellings and
moves only the tracker-location slot to the must-allow corpus: 21 registry
variants produce 1,785 location admissions and 1,785 content refusals. Real source
CLI cases cover six location modes in JSON and TOON across three home-directory
projects, including spaces and Unicode. The same matrix runs in packed npm and
Bun consumers, which additionally pass absolute `--path` to every command.
Incoming next/schedule properties cover all 85 encodings in preview and mutation
mode, malformed contexts and fences, direct SDK calls, native CLI and both
renderers. Tracker/history bytes and all package heartbeat/lease state remain
unchanged; filesystem observations also assert no preflight runtime-write attempt.

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
searches private-home substrings. It starts a path candidate at every separator
and always retains the maximal literal run until whitespace or NUL. Additional
views strip only available surrounding delimiters at the run edges, or use the
recognized enclosing quote/bracket; neither view replaces the literal run. Punctuation such as semicolons, commas,
colons, equals signs, query markers and fragments remains segment data until
normalization. Paired brackets inside a route remain inside its path. There is
no drive-letter prose classifier or blanket URL acceptance.

At most sixteen fixed-point rounds fold Unicode compatibility/confusables and
strip zero-width/bidi controls, then decode percent octets and JSON/HTML escapes, including escaped JSON quotes.
UTF-8 decoding replaces each
invalid sequence with a replacement marker while preserving adjacent valid
multibyte sequences; malformed prefixes cannot erase encoded Unicode separators.
Folding also precedes percent decoding: fullwidth hex digits must not split valid
UTF-8 runs into malformed fragments. Excessive unresolved nesting refuses safely.
Classification converts separators and case-folds spelling, then applies both
`path.posix.normalize` and `path.win32.normalize` to absolute-looking candidate
substrings. Both grammars resolve dot and dot-dot segments, duplicate separators
and trailing separators, with POSIX/drive/UNC anchors bounding upward traversal.
Drive paths inside file URLs also receive their drive-rooted interpretation.
Windows device prefixes receive their underlying drive or UNC-share view while
retaining the original POSIX interpretation for ambiguous separator spellings.
Every home-root pattern
is searched in the normalized candidate views, including URI authorities, paths,
queries, fragments, Markdown, JSON, shell and relative text. No URL component
receives a privacy exemption. Route parentheses and brackets
inside a path remain intact; the classifier does not turn relative path suffixes
into generic absolute-path refusals. Relative text containing a literal home-root
spelling is deliberately classified as private by this lexical rule; the real
fleet inventory reports no such relative paths.
Normalization classifies input and never rewrites persisted notes or file paths.

Ordinary prose, money, approximate times, regex backslashes, remote authorities,
web URLs without private-home content and non-home absolute paths remain allowed.
Field-specific domain rules still apply: persisted lane roots and linked
footprints must remain portable. Local Git root overrides retain their separate
path constraints. HOME, USERPROFILE, the detected process home and each available
realpath spelling pass through the identical canonicalizer used for candidates
before they are captured for the module's process lifetime. A filesystem root
alone is not a private user folder.

Configured roots receive both native normalizations too, including their dot
segments and trailing separators. Matching requires a directory boundary after a
configured home: a home named `demo` does not classify sibling names `demo2`,
`demo-old` or `demo.txt` as private. Entire strings are decoded before path
classification; Markdown/JSON/shell embeddings, queries and fragments retain
substring detection. Public absolute paths outside protected roots remain allowed.
HOME shortcuts also include the percent-delimited HOME spelling. Classification
tests normalized candidates at home-directory segment boundaries; it never
shortens a canceled punctuation-bearing segment before resolving parent traversal.

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
state/backend refusals**, collectively the fifteen retained typed refusal categories plus
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

`commitMutation` checks non-item payloads. Every item writer instead requires
`commitItemMutation` with a complete current snapshot, including body, and the
mutation options/history message. It admits that snapshot before invoking the
SDK and marks only this package request for transactional document admission.
The source inventory parses every authored client call, SDK settings
mutation, portable backend transaction and imported linked-test writer; an added
or unguarded site fails the test until it joins the inventory and admission path.
The inventory requires the item-specific helper and snapshot at all twelve item
writers; the remaining six writers use the generic helper.
The current inventory has **18 sites**: twelve item mutations (claim, update,
release, file links and comments), audited settings, linked-test acknowledgement,
linked-test execution, the shared portable resource transaction and two SDK
coordination lock acquisitions. All four resource actions share that transaction, whose freshly decided change is also
admitted inside the backend callback.

The registered SDK `beforeMutation` hook sees the **complete proposed
`ItemDocument` under the native item lock**, before either item or history
persistence. It validates every metadata field, annotation/link and body, even if
a peer changed a field after preflight. Its refusal is rethrown as the same typed
`SettingsRefusal`, with a safe structural field name and a corrective remedy.
No offending value is echoed. The request-local scope prevents this package from
intercepting unrelated core operations used for explicit repairs.

The scope lives in a process-wide `Symbol.for` registry with request-local
`AsyncLocalStorage`, shared by source, distribution and installed package copies.
SDK constructor identity is registered there too. Commands and embedded engines
check their supplied client against that public SDK identity. A physically
different SDK copy, even with the same version, produces `swarm_sdk_mismatch`
before a package write or inside the native pre-persistence hook. The generic
sink enforces that identity for runtime publication and coordination too. Its remedy is
to share the host SDK installation, remove the nested dependency and restart.
Refusal details cross package boundaries as data and are reconstructed as the
caller's typed error; cross-module `instanceof` is not the transport.

Inside that same SDK commit, the hook compares the complete current document to
the checked snapshot before allowing persistence. SDK read projections and empty
derived collections are excluded from canonical comparison; populated persisted
fields and the body remain included. Internal SDK reads request unbounded output
and full depth; a native budget-refusal envelope becomes a typed input refusal,
never a partial comparison. Large public bodies and annotations remain intact.
A changed document gives `swarm_document_changed`; refresh
ownership and evidence before retrying. Git start refreshes after its own claim.
CLI progress reuses the exact injected client. Legacy boolean constructor hints
use normal native activation instead of assuming an active host. Progress may
retry a benign append conflict up to eight attempts, re-reading every role,
revision and prerequisite; privacy, authority and stale-evidence errors never
retry. Persistent contention returns the typed conflict without a false receipt.

The native `onWrite` hook advances a request snapshot only when both documents
exactly match its admitted, actually committed successor. Unrelated lock/cache
notifications and peer documents cannot advance it. For compound close, the scope encloses one SDK workspace transaction. The generic
`swarm_partial_commit` diagnostic remains for callers composing unjournaled
native operations; journaled close propagates SDK interruption/compensation
semantics instead.

`commitItemMutations` builds the ordered metadata patch/unset and native close
steps on `commitWorkspaceTransaction`. `deriveMutationTransactionId` binds the
plan to the SDK-resolved canonical item, actor, original token and note. The update persists the next fence
and `swarm_close_transaction`, while clearing ownership and handoff state. That
receipt permits recovery with the original token after the update has committed.
An unrelated or stale request cannot adopt the receipt. Pure local SDK inspection refuses invalid state before usage-producing host
reads; a fresh host snapshot is re-evaluated before committing. Malformed stored
generations retain their repair diagnostic. Service-backed reads stay with the
bound client. The SDK owns journal inspection, step idempotency, native mutations
and reverse-order compensation.
The complete document guard remains active for forward and compensation writes;
a peer edit is preserved rather than overwritten by rollback. A replay checks
current completion before returning a receipt. An owned item receipt alone is
insufficient across requests: recovery verifies the latest entry through public
SDK history reads. It requires the transaction's reserved bulk marker, its actor
and a native update/close/restore operation. The check runs during pure preflight,
after the fresh host read, and inside the native item-lock admission hook before
each write. A foreign latest writer or unreadable history refuses with a typed
conflict; it never becomes a new compensation baseline. This preserves peer
comments, titles and bodies even after a previous rollback was refused. Copying
a transaction marker onto a comment does not make that comment package-owned.
Unknown SDK receipt formats fail closed. A changed item needs explicit owner
coordination rather than automatic compensation over the peer's work.

Non-Git tests interrupt all seven forward coordinator boundaries, including
between each native mutation and its journal record. A fresh CLI process resumes
every case with exactly one update and one close, generation two, no lost fields,
and byte-identical history on committed replay. Ordinary failure after the update
restores the original fields through the SDK and a retry completes once. Four
additional interruptions in compensation recover without duplicate restoration
or lost completion. Seven
private-peer transitions preserve exact peer history. Changed completion markers,
generations and owners return a typed conflict. Close has no
`swarm_partial_commit` path.

Settings admission checks the complete fresh raw source document, substituting
only its owned proposed subtree, as well as the SDK-normalized returned patch.
This protects preserved unknown top-level and nested fields that normalized SDK
settings omit. The audited SDK writer still owns persistence and history.
Recovery skips unsafe foreign
context with a reason before releasing a claim or deleting a Git lane.

The generic helper guards runtime-record publication and rendering/watch boundaries.
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

## Whole-document and normalization properties

`test/privacy-documents.test.ts` seeds private values using real core SDK writers,
then exercises **ten field/link families × nine actions = 90 refused rewrites**.
The actions include reserve, renew, publish, release, start, handoff, sync, close
and Plan witness publication. Fields include title, description, body, acceptance
criteria, comments, notes, files, docs, tests and extension metadata. Every refusal
names its structural field, returns no receipt and leaves all durable tracker and
history bytes unchanged. Comparisons exclude SDK-owned ignored runtime caches and
usage receipts while retaining package runtime and lease infrastructure. Repairing
the offending title through the core API permits exactly one successor reservation
at generation one. Fifteen independent-process peer transitions on one non-Git tracker alter title, body
and comments across update, files, comments, claim and release writers between
preflight and the native commit; the locked hook refuses our
rewrite and preserves the peer's exact history. Settings tests cover owned,
foreign top-level and unknown nested output subtrees. Plan snapshots include body
for full admission and bind progress revisions to that content.

Seed **`0x6d2b79f5`** covers **5,000 private normalizations + 5,000 benign siblings**
across ten configured homes (POSIX, drive and UNC, including a space-bearing root).
Identity insertions include `pad/..`, dot segments, duplicate/mixed separators,
percent/JSON/HTML encodings, Unicode separators, case, device namespaces and file URLs. Both grammars
clamp upward traversal at their anchor. Three configured-root spellings (ordinary,
trailing separator, and dot/dot-dot) produce **18 actual handoff refusals** with
unchanged trackers, plus **three successful public-sibling handoffs**. The existing
fixed corpora and all earlier seeded properties remain.

Seed **`0xc0ffee71`** adds **twenty randomized configured homes**, **5,000 private
punctuation aliases + 5,000 benign siblings**. Independent POSIX normalization
supplies the oracle before percent/JSON/HTML/Unicode/mixed-separator encoding and
quote/bracket presentation. All nineteen registry variants produce **95,000
refusals + 95,000 admissions**; both renderers produce **20,000 checked documents**.
There are zero escapes or false refusals. The generator includes unmatched
brackets, apostrophes, escaped JSON quotes, prose contractions and randomized
punctuation in HOME itself. Another 72 fixed classification checks cover six
segment delimiters in six presentations and their benign siblings. The raw SDK
misses all four added identities: `semicolon-parent`, `prose-apostrophe`,
`unmatched-bracket`, and `json-quoted-parent`; the package refuses all four.
Native CLI handoff repeats fifty
punctuation/encoding/wrapper cases with byte-identical trackers and no receipt;
one public sibling handoff succeeds.

The installed-layout matrix uses **one non-Git tracker**, real package files, a
shared SDK layout and a physically copied same-version SDK layout. A separate
core process edits a private or benign title after corpus return, snapshot return,
admission, scope entry, immediately before commit, and native writer entry.
**Twelve private + ten stale benign interleavings** preserve peer history and
produce no package persistence or partial receipt. A clean shared-copy write
succeeds; a distinct SDK is refused at native command startup. Three admission
interruptions converge once on rerun. Additional real peer-appends prove both a
successful re-evaluated witness and bounded contention without losing peer data.

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

Atomic update/close is supported by public `commitItemMutations` and
`commitWorkspaceTransaction`; the earlier missing-capability assessment was
incorrect. [pm-swarm-atomic-close](../.agents/pm/issues/pm-swarm-atomic-close.toon)
tracks its implementation and recovery evidence.

Native settings-section registration and supported extension-section reading are
tracked separately in [pm-swarm-native-settings](../.agents/pm/issues/pm-swarm-native-settings.toon),
blocked on [pm-cli#1580](https://github.com/unbraind/pm-cli/issues/1580). The current
PR delivers typed settings, matching flags and audited persistence through the
documented compatibility bridge.

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
node --test --test-concurrency=1 test/privacy-invocation.test.ts
node --test --test-concurrency=1 test/privacy-documents.test.ts test/privacy-normalization.test.ts test/privacy-sinks.test.ts test/privacy-home.test.ts test/privacy-admission.test.ts test/privacy-refusals.test.ts test/privacy-routes.test.ts test/privacy-guard.test.ts test/privacy-lease.test.ts
node --test --test-concurrency=1 test/privacy-punctuation.test.ts
npm run build && node --test --test-concurrency=1 test/privacy-sdk-instance.test.ts
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
