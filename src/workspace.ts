import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { git } from './git.ts';

/** Detect a worktree once, without starting Git when no worktree marker exists. */
export function repositoryRoot(directory: string): string | undefined {
  const ceilings: string[] = []; let canonicalize = true;
  for (const entry of (process.env.GIT_CEILING_DIRECTORIES ?? '').split(delimiter)) {
    // Git's empty-entry sentinel disables symlink resolution for later ceilings.
    if (entry === '') { ceilings.push(entry); canonicalize = false; continue; }
    if (!isAbsolute(entry)) continue;
    let ceiling = resolve(entry);
    if (canonicalize) {
      try { ceiling = realpathSync(ceiling); } catch { continue; }
    }
    ceilings.push(ceiling);
  }
  let current = resolve(directory);
  if (existsSync(current)) current = realpathSync(current);
  while (true) {
    if (existsSync(join(current, '.git'))) return git(current, ['rev-parse', '--show-toplevel']);
    const ancestor = dirname(current);
    const parent = existsSync(ancestor) ? realpathSync(ancestor) : ancestor;
    if (parent === current || ceilings.includes(parent)) break;
    current = parent;
  }
  return undefined;
}
