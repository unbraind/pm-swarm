import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { withStartTransitionObserver } from '../src/swarm.ts';
import { fixture } from './helpers.ts';
import { historyPeerProcess, gitResources } from './history-aba-helpers.ts';

for (const phase of ['rollback', 'reap'] as const) test(`the native history check and Git ${phase} deletion share one lock`, async t => {
  const f = await fixture(t); const id = await f.item(); f.save();
  if (phase === 'reap') { await f.swarm.start(id); await f.client.update(id, { status: 'closed', message: 'Locked deletion fixture complete' }); }
  const run = childProcess.spawnSync; let injected = false; let peerStatus: number | null = null; let diagnostics = ''; let resources: string[] = [];
  const hook = t.mock.method(childProcess, 'spawnSync', new Proxy(run, { apply(target, receiver, input: unknown[]) {
    if (!injected && input[0] === 'git' && (input[1] as string[]).includes('--unset')) {
      injected = true; const peer = historyPeerProcess(f.repo, f.pmRoot, 'swarm-test', id); assert.equal(peer.error, undefined);
      peerStatus = peer.status; diagnostics = peer.stdout + peer.stderr; if (peer.status === 0) resources = gitResources(f.repo);
    }
    return Reflect.apply(target, receiver, input);
  } })); syncBuiltinESMExports();
  try { await Promise.allSettled([phase === 'reap' ? f.swarm.reap() : withStartTransitionObserver(step => { if (step === 'configured') throw new Error('Interrupted Git acquisition'); }, () => f.swarm.start(id))]); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(injected, true); if (peerStatus === 0) assert.deepEqual(gitResources(f.repo), resources, 'Git deletion removed resources after a successful peer transition');
  assert.notEqual(peerStatus, 0); assert.match(diagnostics, /locked|lock_held|contention/i);
  const retry = historyPeerProcess(f.repo, f.pmRoot, 'swarm-test', id); assert.equal(retry.status, 0, retry.stdout + retry.stderr);
});
