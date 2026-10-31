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
 * Characters after which an absolute path can start: line start, whitespace, quotes and backticks, opening
 * brackets, assignment and list separators, emphasis, the `file://` / `file://localhost` URL authorities, and a
 * leading diff marker, so a committed patch file that adds a home path is still caught.
 *
 * A positive boundary list rather than an exclusion list: any other preceding character continues a relative
 * name. Excluding only ASCII word characters treated `文档/home/page.ts` and `docs/c++/home/page.ts` as absolute,
 * and a `file://localhost` URL slipped through because its path slash follows a letter.
 */
const PATH_START = String.raw`(?<=^|^[+-]|[\s"'` + "`" + String.raw`(\[{<>=:,;|*]|file:\/\/|file:\/\/localhost)`;

/** Absolute home-directory paths: Linux and macOS user homes, the root home, and Windows user profiles. */
const ABSOLUTE_HOME_PATH = new RegExp(
  `${PATH_START}\\/(?:home|Users)\\/`
  + `|${PATH_START}\\/root(?=\\/|$|[\\s"'` + "`" + `),.;:])`
  + String.raw`|\b[A-Za-z]:[\\/]+Users[\\/]`,
);

/**
 * Detect an absolute home-directory path: a Linux or macOS user home, the root home, or a Windows user profile.
 *
 * Each form must start a path token (see PATH_START), and the root home must end its segment, so prose such as
 * "mismatch/root cause", a root-cause document, or a relative folder named home or Users is not reported. A
 * Windows profile may use doubled separators, as JSON-escaped history stores it. The GitHub issue sync imports
 * arbitrary issue text, and a false positive fails every later gate run until the commit leaves the audited range.
 *
 * @param text - Text to scan; for patch lines, the line without its leading `+`.
 * @returns Whether the text contains an absolute home-directory path.
 */
export function containsAbsoluteHomePath(text: string): boolean {
  return ABSOLUTE_HOME_PATH.test(text);
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
