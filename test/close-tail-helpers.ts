import assert from 'node:assert/strict';
import fs from 'node:fs';
import { basename, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import type { TestContext } from 'node:test';
import type { OnWriteHook } from '@unbrained/pm-cli/sdk/authoring';
import type { PmClient } from '@unbrained/pm-cli/sdk';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { completeClaim } from '../src/close.ts';
import type { sharedFixture } from './shared-helpers.ts';

/** All synchronous filesystem operations used by lease publication, admission and release. */
const FILE_OPERATIONS = ['mkdirSync', 'openSync', 'writeFileSync', 'closeSync', 'renameSync', 'rmSync', 'readFileSync', 'unlinkSync', 'rmdirSync'] as const;
/** A primary native commit arms faults without substituting any SDK mutation or receipt. */
const COMMIT_PROBE = Symbol.for('pm-swarm.test.close-tail-commit');
/** Observable fallible operations, including each occurrence inside atomic publication. */
export interface CloseTailTrace { committed: boolean; events: string[]; injected: boolean }
/** Install the real commit observer before this fixture first activates its project extension. */
export function installCloseTailProbe(f: Awaited<ReturnType<typeof sharedFixture>>): void {
  fs.writeFileSync(join(f.pmRoot, 'extensions/pm-swarm/entry.js'), `import extension from '${new URL('../index.ts', import.meta.url).href}';\nexport default {activate(api){extension.activate(api);api.hooks.onWrite(context=>globalThis[Symbol.for('pm-swarm.test.close-tail-commit')]?.(context));}};\n`);
}
/** Keep the host client and every native method intact while observing only its real close call. */
function forwardClose(client: PmClient, close: (...args: Parameters<PmClient['close']>) => Promise<unknown>): PmClient {
  return new Proxy(client, { get(target, key) {
    if (key === 'close') return close;
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
/** Route real native hooks and transparent getter/filesystem observations into one operation sequence. */
export function traceCloseTail(t: TestContext, f: Awaited<ReturnType<typeof sharedFixture>>, id: string, fail?: { index: number | ((event: string) => boolean); value: () => unknown }, before = false, settle?: () => Promise<void>) {
  const state: CloseTailTrace = { committed: false, events: [], injected: false };
  const root = join(f.pmRoot, 'runtime/swarm'); const descriptors = new Map<number, string>();
  /** Keep filesystem names stable across fresh trackers and random temporary generations. */
  const role = (path: string) => basename(path).replace(/\.json\..*$/, '.json.temporary').replace(/^agent-[^.]+/, 'agent').replace(/^request-.*\.json$/, 'request.json');
  /** Fail one selected occurrence, leaving every later owned cleanup operation real and available. */
  const hit = (event: string) => {
    if (state.committed === before) return;
    const index = state.events.push(event) - 1;
    if (fail !== undefined && (typeof fail.index === 'number' ? fail.index === index : fail.index(event))) { state.injected = true; throw fail.value(); }
  };
  Reflect.set(globalThis, COMMIT_PROBE, (context: Parameters<OnWriteHook>[0]) => { if (context.item_id === id && context.op === 'close') state.committed = true; });
  t.after(() => Reflect.deleteProperty(globalThis, COMMIT_PROBE));
  const mocks = FILE_OPERATIONS.map(name => {
    const original = fs[name];
    return t.mock.method(fs, name, new Proxy(original, { apply(target, receiver, args: unknown[]) {
      const path = typeof args[0] === 'string' && args[0].startsWith(root) ? role(args[0]) : typeof args[0] === 'number' ? descriptors.get(args[0]) : undefined;
      // Close the actual descriptor before simulating its lost return, so the probe cannot leak descriptors.
      if (name === 'closeSync' && path !== undefined) {
        const result: unknown = Reflect.apply(target, receiver, args); descriptors.delete(args[0] as number); hit(`${name}:${path}`); return result;
      }
      if (path !== undefined) hit(`${name}:${path}`);
      const result: unknown = Reflect.apply(target, receiver, args);
      if (name === 'openSync' && path !== undefined) descriptors.set(result as number, path);
      return result;
    } }));
  });
  syncBuiltinESMExports();
  /** Restore builtins before verifying native state or removing the owned fixture. */
  const restore = () => { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); };
  t.after(restore);
  const native = f.client.close.bind(f.client);
  const client = forwardClose(f.client, async (...args) => {
      const result = await native(...args);
      await settle?.();
      assert.ok('warnings' in result, 'The native fixture uses ordinary close receipts');
      const warnings = new Proxy(result.warnings, { get(array, field, receiver) {
        if (field === Symbol.iterator || field === 'entries' || field === 'length' || typeof field === 'string' && /^\d+$/.test(field)) hit(`warnings.${field === Symbol.iterator ? 'iterator' : typeof field === 'string' && /^\d+$/.test(field) ? 'element' : String(field)}`);
        return Reflect.get(array, field, receiver);
      } });
      return new Proxy(result, { get(receipt, field, receiver) { if (field === 'warnings') { hit('native.warnings'); return warnings; } return Reflect.get(receipt, field, receiver); } });
  });
  const tokens = new Map<string, string>(); const remove = tokens.delete.bind(tokens);
  tokens.delete = key => { hit('tokens.delete'); return remove(key); };
  const engine = new Swarm(f.repo, f.pmRoot, client, 'shared-test');
  return { state, restore, close: (token: string) => completeClaim(engine, id, 'Public completion', token, tokens) };
}

/** Fail the actual asynchronous native call before invocation or immediately after its real return. */
export function rejectNativeClose(f: Awaited<ReturnType<typeof sharedFixture>>, value: () => unknown, after: boolean): SharedTracker {
  const native = f.client.close.bind(f.client);
  const client = forwardClose(f.client, async (...args) => { if (after) await native(...args); return Promise.reject(value()); });
  return new SharedTracker(new Swarm(f.repo, f.pmRoot, client, 'shared-test'));
}
