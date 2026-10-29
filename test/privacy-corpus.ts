/** Synthetic path encodings; construct all locations without embedding private coordinates. */
const unix = ['', 'home', 'private', 'project'].join('/');
const windows = ['C:', 'Users', 'private', 'project'].join('\\');
/** Stable encoding identities used in SDK-gap reports and Cartesian command admission tests. */
export const privacyCorpus = [
  ['unix-home', unix],
  ['unix-users', ['', 'Users', 'private', 'project'].join('/')],
  ['unix-root', ['', 'root', 'project'].join('/')],
  ['single-quoted', `'${unix}'`],
  ['double-quoted', `"${unix}"`],
  ['angle-bracketed', `<${unix}>`],
  ['file-url', `file://${unix}`],
  ['angle-file-url', `<file://${unix}>`],
  ['file-localhost', `file://localhost${unix}`],
  ['percent-upper', encodeURIComponent(unix)],
  ['percent-lower', encodeURIComponent(unix).toLowerCase()],
  ['percent-double', encodeURIComponent(encodeURIComponent(unix))],
  ['percent-triple', encodeURIComponent(encodeURIComponent(encodeURIComponent(unix)))],
  ['percent-file-url', `file://${encodeURIComponent(unix)}`],
  ['malformed-percent-prefix', `%zz ${encodeURIComponent(unix)}`],
  ['malformed-utf8-prefix', `%ff${encodeURIComponent(unix)}`],
  ['json-escaped-slashes', unix.replaceAll('/', '\\/')],
  ['windows-unc', ['', '', 'server', 'Users', 'private', 'project'].join('\\')],
  ['windows-backslash', windows],
  ['windows-forward', windows.replaceAll('\\', '/').replace('Users', 'users')],
  ['windows-mixed', windows.replace('\\private', '/private').replace('Users', 'uSeRs')],
  ['windows-file-url', `file:///${windows.replaceAll('\\', '/')}`],
  ['tilde-slash', '~/private/project'],
  ['tilde-named', '~private/project'],
  ['tilde-backslash', '~\\private\\project'],
  ['home-variable', '$HOME/private/project'],
  ['home-braced', '${HOME}/private/project'],
  ['userprofile-percent', '%USERPROFILE%/project'],
  ['userprofile-powershell', '$env:USERPROFILE/project'],
  ['trailing-parenthesis', `${unix})`],
  ['trailing-bracket', `${unix}]`],
  ['trailing-comma', `${unix},`],
  ['trailing-period', `${unix}.`],
  ['unicode-fullwidth', unix.replaceAll('/', '\uff0f').replace('home', '\uff48\uff4f\uff4d\uff45')],
  ['unicode-division-slash', unix.replaceAll('/', '\u2215')],
  ['unicode-fraction-slash', unix.replaceAll('/', '\u2044')],
  ['unicode-cyrillic-o', unix.replace('home', 'h\u043eme')],
  ['unicode-cyrillic-s', ['', 'U\u0455ers', 'private', 'project'].join('/')],
  ['unicode-zero-width', unix.replace('home', 'ho\u200bme')],
  ['unicode-bidi', unix.replace('home', 'ho\u202eme')],
  ['markdown-emphasis', `**${unix}**`],
  ['assignment', `path=${unix}`],
  ['cli-equals', `--note=${unix}`],
  ['url-query', `https://example.test/?path=${unix}`],
  ['unicode-symbol-prefix', `\u{1f680}${unix}`],
  ['home-variable-bare', '$HOME'],
  ['tilde-bare', '~'],
  ['bracket-file-url', `[file://${unix}]`],
  ['colon-prefix', `path:${unix}`],
  ['percent-fullwidth', encodeURIComponent(unix.replaceAll('/', '\uff0f'))],
] as const;

/** Round-2 review cases retained independently of the original fifty fixtures. */
export const reviewCorpus = [
  ['dot-segment-root', ['', '.', 'home', 'private', 'project'].join('/')],
  ['forward-unc-authority', ['', '', 'server', 'Users', 'private', 'project'].join('/')],
] as const;
/** Round-4 embedded-text and URL cases use synthetic user identities only. */
const user = ['', 'Users', 'private'].join('/');
const noteWindows = ['C:', 'Users', 'private'].join('\\');
export const embeddedCorpus = [
  ['combined-markdown-csv-json-shell', `see [shell rc](${user}/.zshrc) and edited a.ts,${unix} and ${JSON.stringify({ root: `${noteWindows}\\x` })} see(${noteWindows}\\y)`],
  ['markdown-spaced-label', `[shell rc](${user}/.zshrc)`],
  ['csv-unix', `a.ts,${unix}`], ['json-windows', JSON.stringify({ root: `${noteWindows}\\x` })],
  ['parenthesized-windows', `see(${noteWindows}\\y)`],
  ['shell-semicolon', `x;${unix}`], ['shell-pipe', `|${unix}`], ['shell-redirection', `2>${unix}/log`],
  ['markdown-underscore', `_${unix}_`], ['markdown-reference', `[x]:${unix}`],
  ['shell-tilde-assignment', 'export P=~/x'], ['csv-windows', `a,${noteWindows}`],
  ['json-array-unix', JSON.stringify(['x', `${user}/b`])],
  ['markdown-link-title', `[x](${user}/a "title")`], ['git-file-url', `git+file://${unix}`],
  ['url-encoded-query', `https://example.test/?f=${encodeURIComponent(unix)}`],
  ['url-nested-home', `https://example.test/public${unix}`],
  ['url-comma-path', `https://example.test/,${unix}`], ['url-fragment', `https://example.test/#${unix}`],
  ['windows-device-users', ['','', '?', noteWindows, 'x'].join('\\')],
  ['windows-unc-spaced-share', ['', '', 'server', 'shared folder', 'Users', 'private', 'x'].join('\\')],
  ['windows-device-unc-users', ['','', '?', 'UNC', 'server', 'Users', 'private', 'x'].join('\\')],
  ['json-home-variable', JSON.stringify({ root: '$HOME' })],
  ['json-profile-variable', JSON.stringify({ root: '%USERPROFILE%' })],
  ['embedded-braced-variable', 'export P=${HOME}/x'],
  ['embedded-profile-powershell', 'export P=$env:USERPROFILE/x'],
  ['html-embedded-home', `note=&#40;${unix.replaceAll('/', '&#47;')}&#41;`],
  ['relative-home-substring', ['src', 'home', 'page.ts'].join('/')], ['relative-users-substring', ['docs', 'Users', 'guide.md'].join('/')],
  ['relative-root-substring', ['..', 'root', 'example.ts'].join('/')], ['url-prose-home-substring', `See https://example.test/docs then edit ${['src', 'home', 'page.ts'].join('/')}`],
] as const;
/** Malformed octets cannot erase valid encoded Unicode separators in adjacent sequences. */
export const malformedCorpus = [
  ['malformed-utf8-fullwidth', `%ff${encodeURIComponent(unix.replaceAll('/', '\uff0f'))}`],
  ['malformed-utf8-fullwidth-suffix', `%e2%82${encodeURIComponent(unix.replaceAll('/', '\uff0f'))}%ff`],
] as const;
/** Scope excludes ordinary prose, remote authorities and absolute locations outside user homes. */
export const benignCorpus = [
  ['prose-option-currency-time', 'Option A: kept the cache; took ~5 min'],
  ['money-five', '$5'], ['money-twenty', '$20'], ['approximation', '~5 min'],
  ['regex-prose', String.raw`regex \d+`], ['regex-leading-backslash', String.raw`\d+`], ['single-letter-option', 'Option A:'],
  ...['s3://bucket/key', 'gs://bucket/key', 'git://github.com/example/repo', 'postgres://worker@db.example.com/app', 'wss://example.test/socket', 'redis://example.test:6379/0', 'ftp://example.test/file', 'http://example.test/docs', 'https://example.test/docs?q=public#intro'].map((value, index) => [`remote-${index}`, value] as const),
  ...[['','usr','bin'], ['','tmp','x'], ['','etc','hosts'], ['','var','data','work']].map((parts, index) => [`non-home-${index}`, parts.join('/')] as const),
  ['framework-group', 'src/app/(auth)/page.ts'], ['framework-dynamic', 'src/app/[id]/page.ts'],


  ['file-implicit-path', 'file:var/private/project'], ['file-dot-relative', 'file:./var/private/project'],
  ['file-parent-relative', 'file:../var/private/project'], ['file-empty-root', 'file:'],
  ['file-public-root', `file://${['','usr','bin'].join('/')}`], ['git-file-public-root', `git+file://${['','tmp','x'].join('/')}`],
  ['unrelated-shell-variable', '$HOMEWORK/public'], ['unrelated-braced-variable', '${HOMEWORK}/public'],
  ['unrelated-windows-variable', '%TEMP%/public'], ['unrelated-powershell-variable', '$env:TEMP/public'],
  ['relative-drive', 'Z:relative-drive-root'], ['ordinary-backslash', String.raw`use \ for escaping`],
] as const;
/** Fixed rejection set used across every admission and rendering boundary. */
export const rejectedCorpus = [...privacyCorpus, ...reviewCorpus, ...embeddedCorpus, ...malformedCorpus];
