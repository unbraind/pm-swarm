/** Enforce the tracked identity baseline and reject newly added private home paths. */
import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitEnvironment } from '../src/git-environment.ts';
import { isMainInvocation } from './main-invocation.ts';

/** Read policy entries while ignoring comments and blank lines. */
function policyEntries(root: string, name: string): string[] {
  return readFileSync(join(root, '.github', name), 'utf8').split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'));
}

/** Audit complete Git output without the subprocess pipe's fixed buffer ceiling. */
function gitOutput(root: string, args: readonly string[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'pm-swarm-identity-'));
  try {
    const path = join(directory, 'stdout'); const descriptor = openSync(path, 'w');
    try { execFileSync('git', [...args], { timeout: 300000, cwd: root, env: gitEnvironment(), stdio: ['ignore', descriptor, 'pipe'] }); }
    finally { closeSync(descriptor); }
    return readFileSync(path, 'utf8').trim();
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/**
 * Characters after which an absolute path can start: line start, a leading diff marker, whitespace, quotes and
 * backticks, opening brackets, assignment and list separators, emphasis, the `file://` / `file://localhost` URL
 * authorities in any letter case, and a single-letter command option the path is glued to (`-I`, `-L`, `-o`), also
 * when the option itself follows an assignment or list separator (`CFLAGS=-I…`, `-Wl,-L…`). Any Unicode opening
 * punctuation, initial quote, space separator or other punctuation (a fullwidth colon or comma, an ideographic
 * comma) also starts a path, except `.`, `/` and `\`, which continue a name. Letters in any script continue a name.
 *
 * A positive boundary list rather than an exclusion list: any other preceding character continues a relative
 * name, so a CJK folder name, `c++` or `docs` before a home or Users segment is not reported.
 */
const PATH_START = String.raw`(?<=^|^[+-]|[\s"'` + "`" + String.raw`(\[{<>=:,;|*]|[\p{Ps}\p{Pi}\p{Zs}]|(?![./\\])\p{Po}|[Ff][Ii][Ll][Ee]:\/\/|[Ff][Ii][Ll][Ee]:\/\/[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]|(?:^|[\s"'` + "`" + String.raw`(\[=:,;])-[A-Za-z])`;

/**
 * Remote URLs (any scheme of two or more characters except `file:`, in any letter case, because URI schemes are
 * case-insensitive), blanked before matching: their paths and query values (`https://example.com/login?next=/home/dashboard`)
 * name remote resources, not this machine. A match ends at whitespace, quotes, angle or square brackets, braces
 * or `)`, but not `(`, which is a valid path character; `)` still ends a Markdown link. In the authority and path,
 * a comma or semicolon followed by a slash ends the URL, so a separate path field after it (as in a CSV line) is
 * still scanned. Once a `?` or `#` starts the query or fragment, commas and slashes are URL characters and stay
 * masked; a CSV line whose URL field itself has a query is therefore read as one URL. The match starts at `://` and
 * only then looks back over the scheme, so a scheme of any length is recognized and each `://` scans back over its
 * own scheme run once: the scan stays linear (an unbounded scheme retried at every word boundary was quadratic, and a
 * length cap left longer schemes unmasked). Only the `://` part onwards is masked; a scheme contains no path.
 */
const REMOTE_URL = /:\/\/(?<=[a-z][a-z0-9+.-]+:\/\/)(?<!(?:^|[^a-z0-9+.-])file:\/\/)(?:[^\s"'`<>)[\]{},;?#]|[,;](?!\/))*(?:[?#][^\s"'`<>)[\]{}]*)?/giu;



/**
 * Characters that end a path token: whitespace, quotes and backticks, brackets, list separators, emphasis, and
 * closing, final-quote, space or other punctuation, except the dot, slash, backslash and colon, which belong to names
 * (a colon also keeps a drive letter inside a `file://` path).
 */
const TOKEN_END = String.raw`[\s"'` + "`" + String.raw`<>()[\]{}|*,;]|[\p{Pe}\p{Pf}\p{Zs}]|(?![./\\:])\p{Po}`;

/**
 * A path token at a path start (see PATH_START), after an optional `file://` / `file://localhost` authority (captured,
 * because only a file URL may carry a drive letter after its slash) or a Windows extended-length or device prefix (two
 * or more backslashes, `?` or `.`, a backslash; doubled as JSON escapes them): either a POSIX path, which begins with a
 * slash, or a Windows path, which begins with a drive letter and a separator.
 */
const PATH_TOKEN = new RegExp(
  `${PATH_START}(?:([Ff][Ii][Ll][Ee]:\\/\\/(?:[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt])?)|\\\\{2,}[?.]\\\\+)?`
  + String.raw`((?:[A-Za-z]:[\\/]|\/)(?:(?!` + TOKEN_END + `).)*)`,
  "gu",
);

/**
 * Resolve one path token the way path resolution would, in one linear pass: empty and `.` components drop, `..` pops
 * one component and never goes above the root. A POSIX path splits only on slashes, so a backslash stays part of a
 * name, as it is on POSIX. A Windows path (a drive-letter first component, also after a `file://` authority) splits
 * on both separators.
 *
 * @param token - The path token, starting with a separator or a drive letter.
 * @param fileUrl - Whether the token followed a `file://` authority, the only place a drive letter may follow a slash.
 * @returns Whether it is a Windows path, its resolved components, and whether anything followed the last kept
 * component (a separator, `.` or an emptied component), which marks a home directory itself as a directory.
 */
function resolvePath(token: string, fileUrl: boolean): { windows: boolean; parts: string[]; trailing: boolean } {
  let windows = /^[A-Za-z]:[\\/]/.test(token);
  let raw = windows ? token.slice(2).split(/[\\/]+/) : token.split("/");
  const first = raw.findIndex((part) => part !== "");
  // Only a file URL writes a drive letter after its leading slash; in a plain POSIX path a leading drive-like
  // component is an ordinary directory name.
  if (fileUrl && !windows && first !== -1 && /^[A-Za-z]:$/.test(raw[first])) {
    windows = true;
    raw = raw.slice(first + 1).join("/").split(/[\\/]+/);
  }
  const parts: string[] = [];
  let trailing = false;
  for (const part of raw) {
    if (part === "" || part === ".") { trailing = parts.length > 0; continue; }
    if (part === "..") { parts.pop(); trailing = parts.length > 0; continue; }
    parts.push(part);
    trailing = false;
  }
  return { windows, parts, trailing };
}

/**
 * Whether resolved components name a home: a user home or a Windows profile (a home or Users directory, also below a
 * var directory on POSIX, followed by a user or marked as a directory), or the root home. The macOS Users form is
 * case-sensitive, because a lowercase users segment is usually a web route; the Windows profile matches any case. A
 * root-home component may carry trailing dots or colons (a sentence end, a label) but not a dash, underscore or other
 * name characters.
 *
 * @param path - The resolved path.
 * @returns Whether the path is in a home directory.
 */
function namesHome({ windows, parts, trailing }: ReturnType<typeof resolvePath>): boolean {
  const rest = !windows && parts[0] === "var" ? parts.slice(1) : parts;
  const container = windows ? /^users$/i.test(rest[0] ?? "") : rest[0] === "home" || rest[0] === "Users";
  if (container && (rest.length >= 2 || trailing)) return true;
  return !windows && /^root[.:]*$/.test(rest[0] ?? "");
}

/**
 * Detect an absolute home-directory path: a Linux or macOS user home, the root home, or a Windows user profile.
 *
 * Remote URLs are masked first (see REMOTE_URL). Every path token at a path start (see PATH_START and PATH_TOKEN)
 * is then resolved component by component (see resolvePath) and checked (see namesHome), so dot segments, parent
 * segments and repeated separators cannot hide a home, while relative names, prose and web routes are not reported.
 * The GitHub issue sync imports arbitrary issue text, and a false positive fails every later gate run until the commit
 * leaves the audited range; a false negative publishes a username.
 *
 * @param text - Text to scan; for patch lines, the line without its leading `+`.
 * @returns Whether the text contains an absolute home-directory path.
 */
export function containsAbsoluteHomePath(text: string): boolean {
  for (const match of text.replace(REMOTE_URL, " ").matchAll(PATH_TOKEN)) if (namesHome(resolvePath(match[2], match[1] !== undefined))) return true;
  return false;
}

/** Audit every post-baseline commit, including side branches, against tracked policy. */
export function auditIdentities(root: string): string[] {
  const baseline = policyEntries(root, 'identity-baseline.txt');
  if (baseline.length !== 1 || !/^[a-f0-9]{40}$/i.test(baseline[0])) throw new Error('Invalid identity baseline');
  const approved = new Set(policyEntries(root, 'approved-git-identities.txt'));
  if (approved.size === 0) throw new Error('Approved identity list is empty');
  const git = (args: readonly string[]): string => gitOutput(root, args);
  git(['merge-base', '--is-ancestor', baseline[0], 'HEAD']);
  const commits = git(['rev-list', `${baseline[0]}..HEAD`]).split('\n').filter(Boolean);
  const violations: string[] = [];
  for (const commit of commits) {
    const [author, committer] = git(['show', '-s', '--format=%ae%n%ce', commit]).split('\n');
    if (!approved.has(author)) violations.push(`${commit}: unapproved author identity`);
    if (!approved.has(committer)) violations.push(`${commit}: unapproved committer identity`);
    const patch = git(['show', '--format=', '--diff-merges=first-parent', '--no-ext-diff', '--no-textconv', '--unified=0', commit]);
    if (patch.split('\n').some(line => line.startsWith('+') && !line.startsWith('+++') && containsAbsoluteHomePath(line.slice(1)))) {
      violations.push(`${commit}: added absolute home path`);
    }
  }
  return violations;
}

/** Report policy failures without exposing private paths or unapproved email addresses. */
export function runIdentityGate(root: string, output: (line: string) => void = console.log): number {
  try {
    const violations = auditIdentities(root);
    output(`identity-gate: ${violations.length} violation(s)${violations.length > 0 ? `\n${violations.join('\n')}` : ''}`);
    return violations.length > 0 ? 1 : 0;
  } catch {
    output('identity-gate: policy or Git history could not be verified');
    return 1;
  }
}

if (isMainInvocation(process.argv, import.meta.url)) {
  process.exitCode = runIdentityGate(process.argv[2] ?? process.cwd());
}
