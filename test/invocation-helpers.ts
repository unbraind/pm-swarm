import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import { durableSnapshot } from './privacy-snapshot.ts';

/** Real host coordinates used by both source and packed-consumer admission tests. */
export interface TrackerInvocation {
  runtime: string;
  host: string;
  project: string;
  pmRoot: string;
  environment: NodeJS.ProcessEnv;
}

/** Exercise explicit, environment and discovery locations without exposing them in shared output. */
export function assertTrackerInvocations(input: TrackerInvocation): number {
  const { runtime, host, project, pmRoot, environment } = input;
  let checked = 0;
  const cases = [
    { cwd: project, flags: ['--path', pmRoot], target: undefined },
    { cwd: project, flags: ['--path', relative(project, pmRoot)], target: undefined },
    { cwd: project, flags: [], target: pmRoot },
    { cwd: project, flags: [], target: relative(project, pmRoot) },
    { cwd: project, flags: [], target: undefined },
    { cwd: pmRoot, flags: [], target: undefined },
  ];
  for (const location of cases) for (const format of ['json', 'toon'] as const) {
    const env: NodeJS.ProcessEnv = { ...environment, PM_SOURCE_WORKSPACE_ROOT: project };
    delete env.PM_SOURCE_PM_PATH;
    if (location.target === undefined) delete env.PM_PATH; else env.PM_PATH = location.target;
    const result = spawnSync(runtime, [host, ...location.flags, 'swarm', 'settings', ...(format === 'json' ? ['--json'] : [])], { cwd: location.cwd, env, encoding: 'utf8', timeout: 300000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /swarm_private_path|Extension activation failures/);
    assert.equal((result.stdout + result.stderr).includes(pmRoot), false, 'tracker location leaked');
    const receipt = (format === 'json' ? JSON.parse(result.stdout) : decodeToon(result.stdout)) as { swarm: { base: string } };
    assert.equal(receipt.swarm.base, 'main');
    checked++;
  }
  return checked;
}

/** Verify installed/source CLI refusal ordering in both renderers without changing heartbeat or lease bytes. */
export function assertIncomingHandoffRefusals(input: TrackerInvocation, id: string, token: string): number {
  const { runtime, host, project, pmRoot, environment } = input;
  /** Preserve real core SDK writes for fixture setup, never replacing a read or mutation result. */
  const invoke = (args: string[]) => spawnSync(runtime, [host, '--path', pmRoot, ...args], { cwd: project, env: environment, encoding: 'utf8', timeout: 300000 });
  let checked = 0;
  const values = [encodeURIComponent(['', 'home', 'private', 'incoming'].join('/')), `[context](${['', 'Users', 'private', 'incoming'].join('/')})`];
  for (const value of values) {
    const seeded = invoke(['update', id, '--field', `swarm_handoff=${JSON.stringify({ token, note: value })}`, '--json']);
    assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
    const warmed = invoke(['swarm', 'plan', '--json']); assert.equal(warmed.status, 0, warmed.stdout + warmed.stderr);
    for (const command of ['next', 'schedule']) for (const dryRun of [false, true]) for (const json of [false, true]) {
      const before = durableSnapshot(pmRoot);
      const result = invoke(['swarm', command, ...(dryRun ? ['--dry-run'] : []), ...(json ? ['--json'] : [])]);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /swarm_private_path/);
      assert.doesNotMatch(result.stdout + result.stderr, /(?:"selected"|selected:)/, 'partial receipt');
      assert.equal((result.stdout + result.stderr).includes(value), false);
      assert.equal(durableSnapshot(pmRoot), before, `${command}: durable tracker or liveness changed`);
      checked++;
    }
  }
  const reset = invoke(['update', id, '--unset', 'swarm_handoff', '--json']);
  assert.equal(reset.status, 0, reset.stdout + reset.stderr);
  return checked;
}
