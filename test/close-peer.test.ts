import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { test } from 'node:test';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { SettingsRefusal } from '../src/settings.ts';
import { sharedFixture } from './shared-helpers.ts';
import { peerBytes } from './history-aba-helpers.ts';

test('a peer native close immediately before the native call is preserved without an adopted receipt', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const claim = await f.shared.start(id); const request = new AsyncResource('independent-native-close'); t.after(() => request.emitDestroy());
  const native = f.client.close.bind(f.client); let changed = false; let peer: string[] = [];
  const client = new Proxy(f.client, { get(target, key) {
    if (key === 'close') return async (...args: Parameters<typeof native>) => {
      await request.runInAsyncScope(() => native(id, 'Public completion')); changed = true; peer = peerBytes(f.pmRoot, id);
      return Reflect.apply(native, target, args);
    };
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  await assert.rejects(new SharedTracker(new Swarm(f.repo, f.pmRoot, client, 'shared-test')).close(id, 'Public completion', claim.token), error => error instanceof SettingsRefusal && ['swarm_superseded', 'swarm_close_recovery_unsupported'].includes(error.code));
  assert.equal(changed, true); assert.deepEqual(peerBytes(f.pmRoot, id), peer);
});
