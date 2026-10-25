import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { getHistoryPath, locateItem } from '@unbrained/pm-cli/sdk';
import { sharedFixture } from './shared-helpers.ts';
import { snapshot } from './privacy-snapshot.ts';

test('measure SDK derived writes during a cold corpus-dependent refusal without rolling them back', async t => {
  const f = await sharedFixture(t); const active = await f.item(['src/overlap.ts']); const ready = await f.item(['src/overlap.ts']);
  await f.client.claim(active, { author: 'peer' });
  const located = await locateItem(f.pmRoot, ready); assert.ok(located);
  const history = getHistoryPath(f.pmRoot, ready);
  const itemBefore = readFileSync(located.itemPath, 'utf8'); const historyBefore = readFileSync(history, 'utf8');
  const before = snapshot(f.pmRoot); const names = new Set(readdirSync(f.pmRoot, { recursive: true, encoding: 'utf8' }));
  await assert.rejects(f.shared.start(ready, {}, true), /Overlapping start refused/);
  assert.equal(readFileSync(located.itemPath, 'utf8'), itemBefore); assert.equal(readFileSync(history, 'utf8'), historyBefore);
  const created = readdirSync(f.pmRoot, { recursive: true, encoding: 'utf8' }).filter(name => !names.has(name));
  assert.equal(created.some(name => name.startsWith('runtime/swarm')), false, 'package-owned refusal infrastructure is removed');
  assert.ok(created.every(name => name === 'runtime' || name.startsWith('runtime/metadata-cache')));
  console.log(JSON.stringify({ item_bytes_unchanged: true, history_bytes_unchanged: true, package_runtime_files_created: 0, sdk_runtime_files_created: created.filter(name => name !== 'runtime').length, tracker_byte_identical: before === snapshot(f.pmRoot), sdk: '2026.10.23' }));
});
