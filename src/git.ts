import { spawnSync } from 'node:child_process';
import { gitEnvironment } from './git-environment.ts';
import type { Prediction } from './types.ts';

/** Distinguish an unavailable probe from an authoritative Git exit status before interpreting absence. */
export function gitProbe(repo: string, args: string[], input?: string) {
  const result = spawnSync('git', args, { timeout: 300000, cwd: repo, input, encoding: 'utf8', env: gitEnvironment() });
  if (result.error !== undefined || result.status === null) throw new Error(`git ${args[0]} failed; probe unavailable; inspect repository state`, { cause: result.error });
  return result;
}
/** Read a predicate or optional value only when Git reports success or documented absence. */
export function optionalGitProbe(repo: string, args: string[]) {
  const result = gitProbe(repo, args);
  if (result.status !== 0 && result.status !== 1) throw new Error(`git ${args[0]} failed; probe unavailable; inspect repository state`);
  return result;
}
/** Run Git without a shell; all failures use path-free package diagnostics. */
export function git(repo: string, args: string[], input?: string): string {
  const result = gitProbe(repo, args, input);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed; inspect repository state`);
  return result.stdout.trimEnd();
}
/** Resolve only commits, protecting option parsing and rejecting ambiguous refs. */
export function commit(repo: string, ref: string): string {
  return git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
}
/** Test existence without converting a missing branch into a command failure. */
export function branchExists(repo: string, branch: string): boolean {
  return optionalGitProbe(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
}
/** Read changed paths relative to the true common ancestor, preserving unusual names. */
export function changedFiles(repo: string, base: string, branch: string): string[] {
  const ancestor = git(repo, ['merge-base', base, branch]);
  return git(repo, ['diff', '--name-only', '-z', `${ancestor}..${branch}`]).split('\0').filter(Boolean);
}
/** Ask Git's real merge engine, including configured low-level merge drivers. */
export function predict(repo: string, left: string, right: string): Prediction {
  const result = gitProbe(repo, ['merge-tree', '--write-tree', '--name-only', '-z', '--messages', left, right]);
  if (result.status !== 0 && result.status !== 1) throw new Error('merge-tree failed; conflict prediction unavailable');
  // pm drivers write their human receipt before Git writes its NUL-delimited result.
  // The tree record is the first SHA followed by NUL, following a line boundary.
  const record = /(?:^|\n)([a-f0-9]{40,64})\0/.exec(result.stdout);
  if (record === null) throw new Error('merge-tree returned no tree; conflict prediction unavailable');
  const tree = record[1];
  const entries = result.stdout.slice(record.index + record[0].length).split('\0');
  const separator = entries.indexOf('');
  const conflicts = entries.slice(0, separator);
  const messages: string[] = [];
  for (let cursor = separator + 1; cursor < entries.length - 1;) {
    const count = Number(entries[cursor]);
    messages.push(entries[cursor + count + 2].trimEnd());
    cursor += count + 3;
  }
  return { left, right, tree, clean: result.status === 0, conflicts, messages, tracker_conflicts: conflicts.filter(path => path.startsWith('.agents/pm/')) };
}
/** Create an unreferenced merge commit so subsequent simulations retain ancestry. */
export function chain(repo: string, left: string, right: string, tree: string): string {
  return git(repo, ['-c', 'user.name=SteveBot', '-c', 'user.email=1153461+unbraind@users.noreply.github.com', 'commit-tree', tree, '-p', left, '-p', right], 'Simulate swarm landing\n');
}
/** Inspect every driver declared by tracked attributes in the worktree's context. */
export function missingDrivers(repo: string): string[] {
  if (optionalGitProbe(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']).status === 1) return ['pm merge attributes'];
  if (git(repo, ['ls-tree', '--name-only', 'HEAD', '--', '.gitattributes']) === '') return ['pm merge attributes'];
  const attrs = git(repo, ['show', 'HEAD:.gitattributes']);
  const names = [...new Set([...attrs.matchAll(/merge=(pm-[\w-]+)/g)].map(match => match[1]))];
  if (names.length === 0) return ['pm merge attributes'];
  return names.filter(name => optionalGitProbe(repo, ['config', '--get', `merge.${name}.driver`]).status === 1);
}
