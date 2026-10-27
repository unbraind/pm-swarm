import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { getHistoryPath } from '@unbrained/pm-cli/sdk';
import { historySnapshot } from '../src/inspection.ts';
import { SettingsRefusal } from '../src/settings.ts';
import { sharedFixture } from './shared-helpers.ts';

/** Native history access remains useful for fenced cleanup independently of close recovery. */
test('historical snapshots retain exact native prefixes and refuse unavailable versions', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const first = await historySnapshot(f.pmRoot, id);
  await f.client.update(id, { title: 'Public next native version' });
  const old = await historySnapshot(f.pmRoot, id, first.version); assert.deepEqual(old.historyHead, first.historyHead);
  await assert.rejects(historySnapshot(f.pmRoot, id, 99999), SettingsRefusal);
  const path = getHistoryPath(f.pmRoot, id); const saved = readFileSync(path, 'utf8');
  writeFileSync(path, ''); try { await assert.rejects(historySnapshot(f.pmRoot, id), SettingsRefusal); } finally { writeFileSync(path, saved); }
});

test('native history snapshot refuses an independent append between its certified reads', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const path = getHistoryPath(f.pmRoot, id); let injected = false; const original = fs.readFile;
  const hook = t.mock.method(fs, 'readFile', new Proxy(original, { async apply(target, receiver, args: unknown[]) {
    const result: unknown = await Reflect.apply(target, receiver, args);
    if (!injected && String(args[0]) === path) { injected = true; f.run('update', id, '--title', 'Public peer history append'); }
    return result;
  } })); syncBuiltinESMExports();
  try { await assert.rejects(historySnapshot(f.pmRoot, id), error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed'); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(injected, true); assert.equal((await f.client.get(id)).item.title, 'Public peer history append');
});
