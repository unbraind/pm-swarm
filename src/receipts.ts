import { posix, relative, win32 } from 'node:path';
import { canonicalize, containsPrivatePath } from './privacy.ts';
import { assertPrivatePathSafe } from './settings.ts';

/** Recognize a relative operator coordinate without accepting encoded absolute or home-alias roots. */
function relativeCoordinate(value: string): boolean {
  if (/^\.\.?(?:[/\\]|$)/.test(value)) return true;
  const decoded = canonicalize(value);
  if (decoded === null || posix.isAbsolute(decoded) || win32.isAbsolute(decoded) || /^[a-z][a-z0-9+.-]*:/i.test(decoded)) return false;
  return !containsPrivatePath(`${decoded.split('/')[0]}/`);
}

/** Admit shared content while retaining a relative top-level worktree as an operator coordinate. */
export function assertReceiptSafe(value: unknown): void {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'worktree' in value && typeof value.worktree === 'string' && relativeCoordinate(value.worktree)) {
    const { worktree: _coordinate, ...content } = value; assertPrivatePathSafe(content); return;
  }
  assertPrivatePathSafe(value);
}

/** Project every local lane receipt once, using the already resolved invocation workspace. */
export function projectReceipt<Result>(value: Result, workspace?: string): Result {
  if (workspace === undefined || typeof value !== 'object' || value === null || !('worktree' in value) || typeof value.worktree !== 'string') return value;
  let coordinate = value.worktree;
  if (win32.isAbsolute(coordinate) && !posix.isAbsolute(coordinate)) coordinate = win32.relative(workspace, coordinate);
  else if (posix.isAbsolute(coordinate)) coordinate = relative(workspace, coordinate);
  // Make literal URI/home-alias-looking folder names explicitly relative without changing their filesystem target.
  if (!posix.isAbsolute(coordinate) && !win32.isAbsolute(coordinate) && !relativeCoordinate(coordinate)) coordinate = `./${coordinate}`;
  return { ...value, worktree: coordinate };
}

/** Validate the exact portable receipt before returning it to a renderer or completing an acquisition. */
export function admitReceipt<Result>(value: Result, workspace?: string): Result {
  const receipt = projectReceipt(value, workspace); assertReceiptSafe(receipt); return receipt;
}
