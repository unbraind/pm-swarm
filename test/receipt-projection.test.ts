import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';
import { test } from 'node:test';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import { commitImportedItem, getItemPath, readSettings, resolveItemTypeRegistry } from '@unbrained/pm-cli/sdk';
import { admitReceipt, assertReceiptSafe, projectReceipt } from '../src/receipts.ts';
import { SettingsRefusal } from '../src/settings.ts';
import { historySnapshot } from '../src/inspection.ts';
import { heartbeatPath } from '../src/lease.ts';
import { branchExists } from '../src/git.ts';
import { fixture } from './helpers.ts';
import { swarmHost } from './settings-helpers.ts';
import { durableSnapshot } from './privacy-snapshot.ts';

test('operator worktree projection is portable and idempotent while domain content remains private', () => {
  const workspace = join(homedir(), 'public-project'); const worktree = join(homedir(), 'lanes', 'public-item');
  const once = admitReceipt({ id: 'public-item', worktree }, workspace);
  assert.equal(once.worktree, join('..', 'lanes', 'public-item')); assert.deepEqual(projectReceipt(once, workspace), once);
  const drive = win32.join('X:', win32.sep, 'public');
  assert.equal(projectReceipt({ worktree: win32.join(drive, 'lanes', 'item') }, win32.join(drive, 'project')).worktree, win32.join('..', 'lanes', 'item'));
  for (const value of [null, 1, 'Public receipt', [], {}, { worktree: 7 }]) { assert.deepEqual(projectReceipt(value, workspace), value); assert.doesNotThrow(() => assertReceiptSafe(value)); }
  assert.deepEqual(projectReceipt({ worktree }, undefined), { worktree });
  const secret = ['', 'home', 'private', 'project'].join('/');
  for (const value of [secret, encodeURIComponent(secret), `file://${secret}`, '~/', '$HOME', '${HOME}', '%HOME%', '%USERPROFILE%', '$env:USERPROFILE']) assert.throws(() => assertReceiptSafe({ worktree: value }));
  assert.throws(() => assertReceiptSafe({ worktree: win32.join('X:', win32.sep, 'Users', 'private', 'project') }));
  assert.throws(() => admitReceipt({ worktree: win32.join('Y:', win32.sep, 'Users', 'private', 'project') }, win32.join('X:', win32.sep, 'project')));
  let excessive = secret; for (let depth = 0; depth < 20; depth++) excessive = encodeURIComponent(excessive);
  assert.throws(() => assertReceiptSafe({ worktree: excessive }));
  const relative = posix.join('..', 'home', 'private', 'project');
  assert.doesNotThrow(() => assertReceiptSafe({ worktree: relative }));
  assert.throws(() => assertReceiptSafe({ worktree: relative, context: { worktree: secret } }));
  for (const folder of ['file:literal', '~fixture', '%2Fhome', excessive]) {
    const absolute = join(workspace, folder, 'lane'); const receipt = admitReceipt({ worktree: absolute }, workspace);
    assert.equal(resolve(workspace, receipt.worktree), absolute);
  }
});

test('receipts written by the published package retain their domain data and portable operator coordinates', async () => {
  const fixture = JSON.parse(readFileSync(new URL('fixtures/legacy-receipts.json', import.meta.url), 'utf8')) as { package: string; version: string; integrity: string; receipts: { worktree: string; id: string }[] };
  assert.equal(fixture.package, 'pm-swarm'); assert.equal(fixture.version, '2026.10.15'); assert.match(fixture.integrity, /^sha512-/);
  const host = await swarmHost(); const workspace = join(homedir(), 'legacy-project');
  for (const legacy of fixture.receipts) {
    const absolute = { ...legacy, worktree: legacy.worktree.replace('@operator-home@', homedir()) };
    const receipt = admitReceipt(absolute, workspace); assert.equal(posix.isAbsolute(receipt.worktree), false);
    const { worktree: _before, ...before } = legacy; const { worktree: _after, ...after } = receipt; assert.deepEqual(after, before);
    for (const format of ['json', 'toon'] as const) {
      const result = await host.runRendererOverride({ command: 'swarm start', format, result: receipt });
      assert.equal(result.overridden, true); assert.doesNotMatch(result.rendered!, /swarm_private_path/); assert.equal(result.rendered!.includes(homedir()), false);
    }
  }
});

test('embedded SDK lane receipts keep their local filesystem coordinates while shared projections remain relative', async t => {
  const base = mkdtempSync(join(homedir(), '.swarm-sdk-receipt-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const f = await fixture(t, base);
  for (const command of ['start', 'next', 'schedule'] as const) await t.test(command, async () => {
    const id = await f.item([`src/sdk-${command}.ts`]); f.save();
    const result = command === 'start' ? await f.swarm.start(id) : command === 'next' ? await f.swarm.next() : await f.swarm.schedule({ skills: [] });
    assert.equal(result.worktree, join(f.root, '.pm-swarm', `repo-${id}`));
    assert.equal(admitReceipt(result, f.repo).worktree, join('..', '.pm-swarm', `repo-${id}`));
  });
});

for (const command of ['start', 'next', 'schedule'] as const) test(`${command} beneath a real home returns relative worktrees through both host renderers`, async t => {
  const base = mkdtempSync(join(homedir(), '.swarm-receipt-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const f = await fixture(t, base); const id = await f.item(['src/public.ts']); f.save(); const host = await swarmHost();
  const response = await host.runCommand({ command: `swarm ${command}`, pmRoot: f.pmRoot, args: command === 'start' ? [id] : [], options: {}, global: { author: 'swarm-test' } });
  const result = response.result as Record<string, unknown>;
  assert.equal(result.worktree, join('..', '.pm-swarm', `repo-${id}`)); assert.equal((await f.client.get(id)).item.assignee, 'swarm-test');
  for (const format of ['json', 'toon'] as const) {
    const rendered = await host.runRendererOverride({ command: `swarm ${command}`, format, result });
    assert.equal(rendered.overridden, true); assert.deepEqual(rendered.warnings, []);
    const decoded = format === 'json' ? JSON.parse(rendered.rendered!) : decodeToon(rendered.rendered!);
    assert.equal(decoded.worktree, result.worktree); assert.equal(rendered.rendered!.includes(homedir()), false);
  }
});

test('relative operator paths from older receipts stay allowed without exempting nested content', async () => {
  const host = await swarmHost(); const worktree = posix.join('..', 'home', 'fixture', 'lanes', 'route (group)', '[id]');
  for (const format of ['toon', 'json'] as const) {
    const result = await host.runRendererOverride({ command: 'swarm schedule', format, result: { selected: 'public-item', worktree } });
    assert.equal(result.overridden, true); assert.doesNotMatch(result.rendered!, /swarm_private_path/);
    const secret = ['', 'Users', 'private', 'project'].join('/');
    const refused = await host.runRendererOverride({ command: 'swarm schedule', format, result: { selected: 'public-item', worktree, context: { note: secret } } });
    assert.match(refused.rendered!, /swarm_private_path/); assert.equal(refused.rendered!.includes(secret), false);
  }
});

test('schedule admits every decision row before acquiring an otherwise valid lane', async t => {
  const f = await fixture(t); const id = await f.item(['src/public.ts']);
  const document = structuredClone((await historySnapshot(f.pmRoot, id)).document);
  const foreign = `legacy-${encodeURIComponent(['', 'home', 'private', 'foreign'].join('/'))}`;
  document.metadata.id = foreign; document.metadata.tags = ['skill:other'];
  const settings = await readSettings(f.pmRoot);
  const imported = await commitImportedItem({ pmRoot: f.pmRoot, id: foreign, itemPath: getItemPath(f.pmRoot, 'Task', foreign, undefined, resolveItemTypeRegistry(settings).type_to_folder), document, author: 'fixture-importer', message: 'Legacy decision fixture', settings, conflictWarningPrefix: 'fixture_import_conflict' });
  assert.equal(imported.committed, true); f.save();
  writeFileSync(heartbeatPath(f.pmRoot, 'swarm-test'), '{"heartbeat":"2000-01-01T00:00:00.000Z"}');
  const before = durableSnapshot(f.pmRoot);
  await assert.rejects(f.swarm.schedule({ skills: [] }), error => error instanceof SettingsRefusal && error.code === 'swarm_private_path');
  assert.equal(durableSnapshot(f.pmRoot), before); assert.equal((await f.client.get(id)).item.assignee, undefined);
  assert.equal(branchExists(f.repo, `swarm/${id}`), false);
});
