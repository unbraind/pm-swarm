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
    try { execFileSync('git', [...args], { cwd: root, env: gitEnvironment(), stdio: ['ignore', descriptor, 'pipe'] }); }
    finally { closeSync(descriptor); }
    return readFileSync(path, 'utf8').trim();
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/**
 * Characters after which an absolute path can start: line start, a leading diff marker, whitespace, quotes and
 * backticks, opening brackets, assignment and list separators, emphasis, the `file://` / `file://localhost` URL
 * authorities in any letter case, and a single-letter command option the path is glued to (`-I`, `-L`, `-o`), also
 * when the option itself follows an assignment or list separator (`CFLAGS=-I…`, `-Wl,-L…`).
 *
 * A positive boundary list rather than an exclusion list: any other preceding character continues a relative
 * name, so a CJK folder name, `c++` or `docs` before a home or Users segment is not reported.
 */
const PATH_START = String.raw`(?<=^|^[+-]|[\s"'` + "`" + String.raw`(\[{<>=:,;|*]|[Ff][Ii][Ll][Ee]:\/\/|[Ff][Ii][Ll][Ee]:\/\/[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]|(?:^|[\s"'` + "`" + String.raw`(\[=:,;])-[A-Za-z])`;

/**
 * Remote URLs (any scheme of two or more characters except `file:`, in any letter case, because URI schemes are
 * case-insensitive), blanked before matching: their paths and query values (`https://example.com/login?next=/home/dashboard`)
 * name remote resources, not this machine. A match ends at whitespace, quotes, angle or square brackets, braces
 * or `)`, but not `(`, which is a valid path character; `)` still ends a Markdown link.
 */
const REMOTE_URL = /\b(?!file:)[a-z][a-z0-9+.-]+:\/\/[^\s"'`<>)[\]{}]*/gi;

/**
 * Absolute home-directory paths: Linux and macOS user homes (also below a var directory, as on Fedora Silverblue)
 * and the root home (also below var, as on macOS), with any number of leading slashes, because POSIX resolves a
 * doubled leading slash like a single one. Windows profiles match one or more separators and any letter case,
 * because Windows paths are case-insensitive. The macOS Users form stays case-sensitive: a lowercase users segment
 * in text is far more often a web route than a home directory.
 */
const ABSOLUTE_HOME_PATH = new RegExp(
  `${PATH_START}\\/+(?:var\\/+)?(?:home|Users)\\/`
  + `|${PATH_START}\\/+(?:var\\/+)?root(?=\\/|$|[\\s"'` + "`" + `),.;:])`
  + String.raw`|\b[A-Za-z]:[\\/]+[Uu][Ss][Ee][Rr][Ss][\\/]`,
);

/**
 * Detect an absolute home-directory path: a Linux or macOS user home, the root home, or a Windows user profile.
 *
 * Each form must start a path token (see PATH_START), remote URLs are ignored (see REMOTE_URL), and the root home
 * must end its segment. So prose such as "mismatch/root cause", a root-cause document, a relative folder named home
 * or Users, or a web redirect value is not reported. The GitHub issue sync imports arbitrary issue text, and a false
 * positive fails every later gate run until the commit leaves the audited range; a false negative publishes a
 * username.
 *
 * @param text - Text to scan; for patch lines, the line without its leading `+`.
 * @returns Whether the text contains an absolute home-directory path.
 */
export function containsAbsoluteHomePath(text: string): boolean {
  return ABSOLUTE_HOME_PATH.test(text.replace(REMOTE_URL, ' '));
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
