import { spawnSync } from 'node:child_process';
import { gitEnvironment } from '../src/git-environment.ts';

/** Enumerate complete tracked names; only a verified non-repository may be skipped. */
export function fleetTrackedPaths(repo: string): string | undefined {
  const result = spawnSync('git', ['-C', repo, 'ls-files', '-z'], { timeout: 300000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...gitEnvironment(), GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } });
  if (result.error !== undefined || result.status === null) throw new Error('Fleet Git inventory probe unavailable; incomplete inventory cannot pass.', { cause: result.error });
  if (result.status === 0) return result.stdout;
  if (result.status === 128 && /^fatal: not a git repository(?: \(or any of the parent directories\))?: \.git\s*$/.test(result.stderr)) return undefined;
  throw new Error('Fleet Git inventory failed; incomplete inventory cannot pass.');
}
