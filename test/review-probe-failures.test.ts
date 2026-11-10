import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { branchExists, changedFiles, commit, git, missingDrivers, predict } from '../src/git.ts';
import { fixture } from './helpers.ts';

/** Fault only the OS transport boundary; every unaffected operation uses the real Git executable. */
function failProbe(t: TestContext, matches: (argv: unknown[]) => boolean, kind = 'ETIMEDOUT') {
  const original = childProcess.spawnSync;
  const mocked = t.mock.method(childProcess, 'spawnSync', new Proxy(original, { apply(target, receiver, args: unknown[]) {
    const argv = args[1];
    if (args[0] === 'git' && Array.isArray(argv) && matches(argv)) return { status: kind === 'contradictory' ? 0 : null, signal: 'SIGTERM', error: kind === 'signal' ? undefined : Object.assign(new Error('Opaque transport detail'), { code: kind }), stdout: '', stderr: '', pid: 0, output: [] };
    return Reflect.apply(target, receiver, args);
  } })); syncBuiltinESMExports();
  return () => { mocked.mock.restore(); syncBuiltinESMExports(); };
}

for (const probe of ['show-ref', 'show', 'config', 'merge-tree', 'rev-parse', 'merge-base', 'diff']) test(`unavailable ${probe} cannot produce a successful Git state classification`, async t => {
  const f = await fixture(t);
  const operations: Record<string, () => unknown> = {
    'show-ref': () => branchExists(f.repo, 'main'), show: () => missingDrivers(f.repo), config: () => missingDrivers(f.repo),
    'merge-tree': () => predict(f.repo, 'main', 'main'), 'rev-parse': () => commit(f.repo, 'main'),
    'merge-base': () => changedFiles(f.repo, 'main', 'main'), diff: () => changedFiles(f.repo, 'main', 'main'),
  };
  for (const kind of ['ETIMEDOUT', 'ENOENT', 'signal', 'contradictory']) {
    const restore = failProbe(t, argv => argv[0] === probe, kind);
    try { assert.throws(operations[probe], /failed; probe unavailable; inspect repository state/); }
    finally { restore(); }
  }
  assert.equal(branchExists(f.repo, 'main'), true); assert.equal(branchExists(f.repo, 'absent'), false);
  assert.throws(() => git(f.repo, ['definitely-not-a-command']), /failed; inspect repository state/);
});

for (const probe of ['merge-base', 'config']) test(`reap preserves all lane resources when its ${probe} probe is unavailable`, async t => {
  const f = await fixture(t);
  const id = await f.item(['src/probe-cleanup.ts']);
  f.save();
  await f.swarm.start(id);
  await f.client.close(id, 'Public probe cleanup fixture completed');
  const before = git(f.repo, ['worktree', 'list', '--porcelain']);
  const restore = failProbe(t, argv => argv[0] === probe && (probe !== 'config' || String(argv.at(-1)).startsWith('swarm.lane.')));
  try { await assert.rejects(f.swarm.reap(), /failed; probe unavailable/); }
  finally { restore(); }
  assert.equal(branchExists(f.repo, `swarm/${id}`), true);
  assert.equal(git(f.repo, ['worktree', 'list', '--porcelain']), before);
});
