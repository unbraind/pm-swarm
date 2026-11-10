import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { branchExists, changedFiles, commit, git, missingDrivers, optionalGitProbe, predict } from '../src/git.ts';
import { fixture } from './helpers.ts';
import { snapshotGitResources } from './git-helpers.ts';

/** Fault only the OS transport boundary; every unaffected operation uses the real Git executable. */
function failProbe(t: TestContext, matches: (argv: unknown[]) => boolean, kind: string | number = 'ETIMEDOUT') {
  const original = childProcess.spawnSync;
  const mocked = t.mock.method(childProcess, 'spawnSync', new Proxy(original, { apply(target, receiver, args: unknown[]) {
    const argv = args[1];
    if (args[0] === 'git' && Array.isArray(argv) && matches(argv)) return { status: typeof kind === 'number' ? kind : kind === 'contradictory' ? 0 : null, signal: typeof kind === 'number' ? null : 'SIGTERM', error: typeof kind === 'number' || kind === 'signal' ? undefined : Object.assign(new Error('Opaque transport detail'), { code: kind }), stdout: '', stderr: '', pid: 0, output: [] };
    return Reflect.apply(target, receiver, args);
  } })); syncBuiltinESMExports();
  return () => { mocked.mock.restore(); syncBuiltinESMExports(); };
}

for (const probe of ['show-ref', 'ls-tree', 'show', 'config', 'merge-tree', 'rev-parse', 'merge-base', 'diff']) test(`unavailable ${probe} cannot produce a successful Git state classification`, async t => {
  const f = await fixture(t);
  const operations: Record<string, () => unknown> = {
    'show-ref': () => branchExists(f.repo, 'main'), 'ls-tree': () => missingDrivers(f.repo), show: () => missingDrivers(f.repo), config: () => missingDrivers(f.repo),
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
  const before = snapshotGitResources(f.repo);
  for (const kind of ['ETIMEDOUT', 2, 128, 255]) {
    const restore = failProbe(t, argv => argv[0] === probe && (probe !== 'config' || String(argv.at(-1)).startsWith('swarm.lane.')), kind);
    try { await assert.rejects(f.swarm.reap(), /failed; probe unavailable/); }
    finally { restore(); }
    assert.deepEqual(snapshotGitResources(f.repo), before);
  }
  assert.equal(branchExists(f.repo, `swarm/${id}`), true);
  assert.deepEqual(snapshotGitResources(f.repo), before);
});


test('optional Git probes reject every fatal exit, preserving only documented absence', async t => {
  const f = await fixture(t);
  for (let status = 0; status <= 255; status++) {
    const restore = failProbe(t, argv => argv[0] === 'config', status);
    try {
      if (status <= 1) assert.equal(optionalGitProbe(f.repo, ['config', '--get', 'public.optional']).status, status);
      else assert.throws(() => optionalGitProbe(f.repo, ['config', '--get', 'public.optional']), /failed; probe unavailable/);
    } finally { restore(); }
  }
});

for (const probe of ['show-ref', 'rev-parse', 'ls-tree', 'show', 'config', 'merge-tree']) test(`fatal ${probe} cannot masquerade as branch, attributes, driver absence or conflicts`, async t => {
  const f = await fixture(t);
  const operation = probe === 'show-ref' ? () => branchExists(f.repo, 'main') : probe === 'merge-tree' ? () => predict(f.repo, 'main', 'main') : () => missingDrivers(f.repo);
  for (const status of [2, 128, 255]) {
    const restore = failProbe(t, argv => argv[0] === probe, status);
    try { assert.throws(operation, /failed/); }
    finally { restore(); }
  }
});


test('missing tracked attributes remain an ordinary merge-driver absence after a real commit', async t => {
  const f = await fixture(t);
  git(f.repo, ['rm', '.gitattributes']);
  git(f.repo, ['-c', 'user.name=SteveBot', '-c', 'user.email=1153461+unbraind@users.noreply.github.com', 'commit', '-m', 'Remove fixture attributes']);
  assert.deepEqual(missingDrivers(f.repo), ['pm merge attributes']);
});
