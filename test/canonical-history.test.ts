import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { getHistoryPath } from '@unbrained/pm-cli/sdk';
import { clientMutationSnapshot } from '../src/inspection.ts';
import { sharedFixture } from './shared-helpers.ts';
import { declareService } from './privacy-mutations.ts';

for (const service of [false, true]) test(`canonical native identity precedes every history stream selection (services ${service})`, async t => {
  const f = await sharedFixture(t); const id = await f.item(); if (service) declareService(f); const short = id.split('-').at(-1)!;
  const wrong = getHistoryPath(f.pmRoot, short); const native = getHistoryPath(f.pmRoot, id); const reads: string[] = []; const original = fs.readFile;
  const hook = t.mock.method(fs, 'readFile', new Proxy(original, { async apply(target, receiver, args: unknown[]) { if ([wrong, native].includes(String(args[0]))) reads.push(String(args[0])); return Reflect.apply(target, receiver, args); } })); syncBuiltinESMExports();
  try { const snapshot = await clientMutationSnapshot(f.pmRoot, f.client, short); assert.equal(snapshot.item.id, id); assert.ok(snapshot.historyHead.length > 0); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(reads.includes(wrong), false); assert.ok(reads.includes(native));
});
