import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { git } from './git.ts';

/** Detect a worktree once, without starting Git when no worktree marker exists. */
export function repositoryRoot(directory: string): string | undefined {
  const ceilings = (process.env.GIT_CEILING_DIRECTORIES ?? '').split(delimiter);
  let current = resolve(directory);
  while (!ceilings.includes(current)) {
    if (existsSync(join(current, '.git'))) return git(directory, ['rev-parse', '--show-toplevel']);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}
