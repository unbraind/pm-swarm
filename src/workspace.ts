import { existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { git } from './git.ts';

/** Detect a worktree once, without starting Git when no worktree marker exists. */
export function repositoryRoot(directory: string): string | undefined {
  const ceilings = (process.env.GIT_CEILING_DIRECTORIES ?? '').split(delimiter)
    .filter(entry => entry === '' || isAbsolute(entry))
    .map(entry => entry === '' ? entry : resolve(entry));
  let current = resolve(directory);
  while (true) {
    if (existsSync(join(current, '.git'))) return git(directory, ['rev-parse', '--show-toplevel']);
    const parent = dirname(current);
    if (parent === current || ceilings.includes(parent)) break;
    current = parent;
  }
  return undefined;
}
