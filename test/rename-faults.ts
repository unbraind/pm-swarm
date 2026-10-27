import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import type { TestContext } from 'node:test';

/** Inject a selected filesystem fault while retaining every real nonmatching write and SDK result. */
export function failRename(t: TestContext, predicate: (source: string, target: string) => boolean, message: string): () => void {
  const original = fs.renameSync; let restored = false;
  const observation = t.mock.method(fs, 'renameSync', new Proxy(original, { apply(target, receiver, args: unknown[]) {
    if (predicate(String(args[0]), String(args[1]))) throw new Error(message);
    return Reflect.apply(target, receiver, args);
  } })); syncBuiltinESMExports();
  const restore = () => { if (!restored) { observation.mock.restore(); syncBuiltinESMExports(); restored = true; } };
  t.after(restore); return restore;
}
