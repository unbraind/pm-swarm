import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { git } from './git.ts';

/** Validate lane location and orphan provenance before permitting recursive cleanup. */
export function lanePathRefusal(repo: string, root: string, id: string, path: string, orphan: boolean): string | null {
  const expected = resolve(repo, root, `${basename(repo)}-${id}`);
  if (path !== expected) return 'Stored lane path is outside its configured lane location';
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry === undefined) return null;
  if (!entry.isDirectory() || realpathSync(path) !== join(realpathSync(resolve(repo, root)), basename(expected))) return 'Lane path must be a directory inside the configured swarm root without symlink redirection';
  if (!orphan) return null;
  const marker = join(path, '.git');
  if (!lstatSync(marker, { throwIfNoEntry: false })?.isFile()) return 'Leftover directory has no worktree marker';
  const pointer = /^gitdir: (.+)\n?$/.exec(readFileSync(marker, 'utf8'));
  if (pointer === null) return 'Leftover directory has an invalid worktree marker';
  const admin = resolve(path, pointer[1].trimEnd());
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (dirname(admin) !== join(common, 'worktrees') || existsSync(admin)) return 'Leftover directory is not an orphaned worktree of this repository';
  return null;
}
