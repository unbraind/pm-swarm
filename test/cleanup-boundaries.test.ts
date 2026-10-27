import assert from 'node:assert/strict';
import fs, { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { fixture } from './helpers.ts';
import { fixtureGit as git } from './git-helpers.ts';
import { sharedFixture } from './shared-helpers.ts';
import { withStartTransitionObserver } from '../src/swarm.ts';
import { StaleFenceError, withSwarmLease, heartbeatPath } from '../src/lease.ts';
import { SettingsRefusal } from '../src/settings.ts';

for (const changed of ['worktree', 'dirty worktree', 'branch'] as const) test(`failed start preserves a peer-changed ${changed} while releasing its own native claim`, async t => {
  const f = await fixture(t); const id = await f.item(); f.save(); const branch = `swarm/${id}`; const path = join(f.root, '.pm-swarm', `repo-${id}`); let peer = '';
  await assert.rejects(withStartTransitionObserver(transition => {
    if (changed !== 'branch' && transition === 'worktree_created') {
      f.write('peer.txt', 'Public peer work', path); peer = changed === 'worktree' ? f.save(['peer.txt'], path) : git(path, ['rev-parse', 'HEAD']); throw new Error('Stop after peer worktree commit');
    }
    if (changed === 'branch' && transition === 'branch_created') {
      peer = git(f.repo, ['-c', 'user.name=SteveBot', '-c', 'user.email=1153461+unbraind@users.noreply.github.com', 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Public peer branch']);
      git(f.repo, ['update-ref', `refs/heads/${branch}`, peer]); throw new Error('Stop after peer ref transition');
    }
  }, () => f.swarm.start(id)), error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed');
  assert.notEqual(peer, ''); assert.equal(git(f.repo, ['rev-parse', branch]), peer);
  assert.equal((await f.client.get(id)).item.assignee, undefined);
  if (changed !== 'branch') assert.equal(readFileSync(join(path, 'peer.txt'), 'utf8'), 'Public peer work');
});

test('failed publication preserves peer lane metadata and reports why its Git resources remain', async t => {
  const f = await fixture(t); const id = await f.item(); f.save();
  /** Replace the published registration through a real peer SDK transition. */
  const replaceRegistration = async (transition: string) => {
    if (transition === 'published') { await f.client.update(id, { field: ['swarm_branch=peer/branch'] }); throw new Error('Fail after metadata peer transition'); }
  };
  await assert.rejects(withStartTransitionObserver(replaceRegistration, () => f.swarm.start(id)), SettingsRefusal);
  const item = (await f.client.get(id)).item;
  assert.equal(item.swarm_branch, 'peer/branch'); assert.equal(item.assignee, undefined);
  assert.equal(git(f.repo, ['rev-parse', '--verify', `swarm/${id}`]), git(f.repo, ['rev-parse', 'HEAD']));
});

test('final receipt checks its pin generation and preserves a peer replacement without liveness', async t => {
  const f = await sharedFixture(t); const root = join(f.pmRoot, 'runtime/swarm'); const peer = '{"token":"peer-generation"}';
  await assert.rejects(withSwarmLease(f.pmRoot, 'shared-test', async () => {
    const candidate = join(root, 'peer-pin.json'); writeFileSync(candidate, peer); renameSync(candidate, join(root, 'operation-pin.json')); return 'Public receipt';
  }), StaleFenceError);
  assert.equal(readFileSync(join(root, 'operation-pin.json'), 'utf8'), peer);
  assert.deepEqual(readdirSync(root), ['operation-pin.json']); assert.equal(existsSync(heartbeatPath(f.pmRoot, 'shared-test')), false);
});

test('a void acquisition callback still rolls back and refuses its lost generation', async t => {
  const f = await sharedFixture(t); const root = join(f.pmRoot, 'runtime/swarm'); let cleaned = false;
  await assert.rejects(withSwarmLease(f.pmRoot, 'shared-test', async lease => {
    lease.onFailure(async () => { cleaned = true; });
    writeFileSync(join(root, 'operation-pin.json'), '{"token":"peer"}');
  }), StaleFenceError);
  assert.equal(cleaned, true); assert.equal(existsSync(heartbeatPath(f.pmRoot, 'shared-test')), false);
});

test('successful claim receipts do not perform a fallible empty-directory cleanup after releasing their scope', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const root = join(f.pmRoot, 'runtime/swarm'); let attempts = 0;
  const original = fs.rmdirSync;
  const observation = t.mock.method(fs, 'rmdirSync', new Proxy(original, { apply(target, receiver, args: unknown[]) {
    if (String(args[0]) === root) { attempts++; throw new Error('Forbidden cleanup after successful acquisition'); }
    return Reflect.apply(target, receiver, args);
  } })); syncBuiltinESMExports();
  try { assert.equal((await f.shared.start(id)).id, id); }
  finally { observation.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(attempts, 0); assert.equal((await f.client.get(id)).item.assignee, 'shared-test');
});
