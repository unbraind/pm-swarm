import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { sharedFixture } from './shared-helpers.ts';
import { assertCompensated, recoveryFixture } from './close-recovery-helpers.ts';

/** Kill an actual native close after its return and before swarm receives the result. */
async function loseNativeReturn(f: Awaited<ReturnType<typeof sharedFixture>>, id: string, token: string) {
  const child = fork(fileURLToPath(new URL('./close-refusal-worker.ts', import.meta.url)), [JSON.stringify({ repo: f.repo, pmRoot: f.pmRoot, id, token })], { cwd: f.repo, env: f.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], timeout: 60000 });
  const exit = once(child, 'exit');
  let diagnostic = ''; child.stderr!.on('data', value => { diagnostic += String(value); });
  try {
    await Promise.race([once(child, 'message'), exit.then(() => { throw new Error(`Worker missed native barrier: ${diagnostic}`); })]);
    child.kill('SIGKILL'); assert.deepEqual(await exit, [null, 'SIGKILL']);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}

for (const count of [1, 2, 3]) test(`lost native return compensates all ${count} dependents with exact bytes and append-only history`, async t => {
  const { f, id, token, ids, before } = await recoveryFixture(t, count);
  await loseNativeReturn(f, id, token);
  for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(f.shared.close(id, 'Public native completion', token), { code: 'swarm_close_compensated' });
    assertCompensated(f, ids, before);
  }
});
