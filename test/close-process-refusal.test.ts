import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { sharedFixture } from './shared-helpers.ts';
import { blockedDependent } from './close-native-helpers.ts';
import { durableSnapshot } from './privacy-snapshot.ts';
import { SettingsRefusal } from '../src/settings.ts';

test('SIGKILL after native close refuses recovery and preserves the complete native result and peer edit', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const claim = await f.shared.start(id); const dependent = await blockedDependent(f, id);
  const child = fork(fileURLToPath(new URL('./close-refusal-worker.ts', import.meta.url)), [JSON.stringify({ repo: f.repo, pmRoot: f.pmRoot, id, token: claim.token })], { cwd: f.repo, env: f.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], timeout: 120000 });
  let diagnostic = ''; child.stderr!.setEncoding('utf8').on('data', (value: string) => { diagnostic += value; });
  const exit = once(child, 'exit'); void exit.catch(() => {});
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await Promise.race([once(child, 'message'), exit.then(([code, signal]) => { throw new Error(`Native worker exited before its barrier: ${String(code)}/${String(signal)} ${diagnostic}`); })]);
  assert.equal(child.kill('SIGKILL'), true); assert.deepEqual(await exit, [null, 'SIGKILL']);
  await f.client.update(dependent, { title: 'Independent peer work after native close' });
  const before = durableSnapshot(f.pmRoot);
  for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(f.shared.close(id, 'Public native completion', claim.token), error => error instanceof SettingsRefusal && error.code === 'swarm_close_recovery_unsupported' && error.remedy.includes(id));
    assert.equal(durableSnapshot(f.pmRoot), before);
  }
  assert.equal((await f.client.get(id)).item.status, 'closed'); assert.equal((await f.client.get(dependent)).item.status, 'open');
});
