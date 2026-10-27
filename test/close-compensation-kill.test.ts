import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { SharedTracker } from '../src/shared-tracker.ts';
import { CompensationPartialRefusal } from '../src/close-compensation.ts';
import { sharedFixture } from './shared-helpers.ts';
import { blockedDependent, closeClaim } from './close-native-helpers.ts';
import { peerBytes } from './history-aba-helpers.ts';

/** IPC is only a barrier; every mutation and journal transition executes in the actual SDK. */
interface Message { event: string; code?: string; restored?: string[]; pending?: string[] }
/** Start one native transaction and retain every process failure while waiting for its durable barrier. */
function worker(t: TestContext, input: { repo: string; pmRoot: string; id: string; token: string }, env: NodeJS.ProcessEnv) {
  const child = fork(fileURLToPath(new URL('./close-compensation-worker.ts', import.meta.url)), [JSON.stringify(input)], { cwd: input.repo, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 120000 });
  let stderr = ''; child.stderr!.setEncoding('utf8').on('data', (value: string) => { stderr += value; });
  const exit = once(child, 'exit'); void exit.catch(() => {});
  const messages: Message[] = [];
  const ready = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('message', (message: Message) => { messages.push(message); if (message.event === 'ready') resolve(); });
    void exit.then(([code, signal]) => { if (!messages.some(message => message.event === 'ready')) reject(new Error(`Worker exited before its barrier: ${String(code)}/${String(signal)} ${stderr}`)); }, reject);
  });
  void ready.catch(() => {}); t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return { child, ready, exit, messages };
}

for (const count of [1, 2, 3]) test(`SIGKILL before compensation preserves all ${count} native dependents on every retry`, async t => {
  const f = await sharedFixture(t); const { id, claim } = await closeClaim(f); const ids = [id];
  for (let index = 0; index < count; index++) ids.push(await blockedDependent(f, id));
  const run = worker(t, { repo: f.repo, pmRoot: f.pmRoot, id, token: claim.token }, f.env);
  await run.ready; const native = ids.map(id => peerBytes(f.pmRoot, id));
  assert.equal(run.child.kill('SIGKILL'), true); assert.deepEqual(await run.exit, [null, 'SIGKILL']);
  for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(new SharedTracker(f.shared.engine).close(id, 'Public completion', claim.token), error => error instanceof CompensationPartialRefusal && error.code === 'swarm_compensation_partial' && error.restored.length === 0 && ids.every(member => error.pending.includes(member)));
    assert.deepEqual(ids.map(id => peerBytes(f.pmRoot, id)), native);
  }
  assert.equal((await f.client.get(id)).item.status, 'closed');
  for (const dependent of ids.slice(1)) assert.equal((await f.client.get(dependent)).item.status, 'open');
});

test('a peer edit at the compensation barrier survives the typed SDK and CLI refusals', async t => {
  const f = await sharedFixture(t); const { id, claim } = await closeClaim(f); const dependent = await blockedDependent(f, id);
  const run = worker(t, { repo: f.repo, pmRoot: f.pmRoot, id, token: claim.token }, f.env); await run.ready;
  await f.client.update(dependent, { description: 'Independent peer progress' }); const native = [id, dependent].map(member => peerBytes(f.pmRoot, member));
  run.child.send({ event: 'continue' }); assert.deepEqual(await run.exit, [0, null]);
  const refusal = run.messages.find(message => message.event === 'refused');
  assert.equal(refusal?.code, 'swarm_compensation_partial'); assert.deepEqual(refusal.restored, []); assert.ok(refusal.pending?.includes(id) && refusal.pending.includes(dependent));
  for (const json of [true, false]) {
    const result = f.cli('swarm', 'close', id, '--note', 'Public completion', '--token', claim.token, ...(json ? ['--json'] : []));
    assert.equal(result.status, 2); assert.match(result.stdout + result.stderr, /swarm_compensation_partial/); assert.match(result.stdout + result.stderr, new RegExp(dependent));
    if (json) {
      const problem = JSON.parse(result.stdout.trim() || result.stderr.trim()) as { required: string };
      const marker = 'Compensation receipt: '; const offset = problem.required.indexOf(marker); assert.ok(offset >= 0);
      const value = JSON.parse(problem.required.slice(offset + marker.length)) as { restored: string[]; pending: string[] };
      assert.deepEqual(value.restored, []); assert.ok(value.pending.includes(dependent));
    }
  }
  assert.deepEqual([id, dependent].map(member => peerBytes(f.pmRoot, member)), native);
});
