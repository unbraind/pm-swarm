import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { failRename } from './rename-faults.ts';
import { swarmHost } from './settings-helpers.ts';
import { isPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import { withStartTransitionObserver } from '../src/swarm.ts';
import { fixture } from './helpers.ts';
import { fixtureGit as git } from './git-helpers.ts';
import { branchExists } from '../src/git.ts';

/** Both direct and late cleanup conflicts must survive the native host transport. */
function typedCleanupConflict(error: unknown): boolean { return isPmCliExpectedError(error) && error.exitCode === 2 && error.context?.code === 'swarm_document_changed'; }

test('branch creation refuses a competing ref without deleting it or retaining the new claim', async t => {
  const f = await fixture(t); const id = await f.item(); f.save(); const branch = `swarm/${id}`;
  await assert.rejects(withStartTransitionObserver(transition => {
    if (transition === 'claim_read') git(f.repo, ['branch', branch]);
  }, () => f.swarm.start(id)), /git update-ref failed/);
  assert.equal(branchExists(f.repo, branch), true); assert.equal((await f.client.get(id)).item.assignee, undefined);
});

test('a replaced Git configuration survives cleanup while other owned resources still release', async t => {
  const f = await fixture(t); const id = await f.item(); f.save();
  const host = await swarmHost();
  await assert.rejects(withStartTransitionObserver(transition => {
    if (transition === 'configured') {
      git(f.repo, ['config', '--local', `swarm.lane.${id}`, 'peer-lane']); throw new Error('Fail after peer replaced configuration');
    }
  }, () => host.runCommand({ command: 'swarm start', args: [id], pmRoot: f.pmRoot, global: { author: 'swarm-test' } })), typedCleanupConflict);
  assert.equal(git(f.repo, ['config', '--local', '--get', `swarm.lane.${id}`]), 'peer-lane');
  assert.equal(branchExists(f.repo, `swarm/${id}`), false); assert.equal((await f.client.get(id)).item.assignee, undefined);
});

test('published lane cleanup preserves a peer content edit in its fresh SDK update', async t => {
  const f = await fixture(t); const id = await f.item(); f.save();
  await assert.rejects(withStartTransitionObserver(async transition => {
    if (transition !== 'published') return;
    await f.client.update(id, { description: 'Public peer description' }); throw new Error('Injected published failure');
  }, () => f.swarm.start(id)), /Injected published failure/);
  const item = (await f.client.get(id)).item;
  assert.equal(item.description, 'Public peer description'); assert.equal(item.swarm_branch, undefined); assert.equal(item.assignee, undefined);
});

test('host receipt projection performs no new Git lookup after lane acquisition', async t => {
  const f = await fixture(t); const id = await f.item(); f.save();
  const host = await swarmHost();
  let acquired = false; let lateReads = 0; const original = childProcess.spawnSync;
  const observation = t.mock.method(childProcess, 'spawnSync', new Proxy(original, { apply(target, receiver, args: unknown[]) {
    if (acquired && args[0] === 'git' && (args[1] as string[]).includes('--show-toplevel')) { lateReads++; throw new Error('Forbidden post-acquisition Git lookup'); }
    return Reflect.apply(target, receiver, args);
  } })); syncBuiltinESMExports();
  try {
    const result = await withStartTransitionObserver(transition => { if (transition === 'receipt') acquired = true; }, () => host.runCommand({ command: 'swarm start', args: [id], pmRoot: f.pmRoot, global: { author: 'swarm-test' } }));
    assert.equal(typeof (result.result as { worktree: string }).worktree, 'string'); assert.equal(lateReads, 0);
  } finally { observation.mock.restore(); syncBuiltinESMExports(); }
});

test('late receipt cleanup preserves a peer replacement and transports its typed conflict', async t => {
  const f = await fixture(t); const id = await f.item(); f.save(); const host = await swarmHost(); let failHeartbeat = false;
  const restore = failRename(t, (_source, target) => failHeartbeat && target.includes('agent-'), 'Injected final heartbeat failure');
  try {
    await assert.rejects(withStartTransitionObserver(async transition => {
      if (transition !== 'receipt') return;
      await f.client.release(id); await f.client.claim(id, { author: 'peer' }); failHeartbeat = true;
    }, () => host.runCommand({ command: 'swarm start', args: [id], pmRoot: f.pmRoot, global: { author: 'swarm-test' } })), typedCleanupConflict);
  } finally { restore(); }
  assert.equal((await f.client.get(id)).item.assignee, 'peer'); assert.equal(branchExists(f.repo, `swarm/${id}`), true);
});
