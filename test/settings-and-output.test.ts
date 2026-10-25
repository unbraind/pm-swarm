import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createExtensionTestHarness, decodeToon } from '@unbrained/pm-cli/sdk/testing';
import extension from '../index.ts';
import { assertPrivatePathSafe, resolveSwarmSettings, settings, SettingsRefusal, swarmSettingsSection, updateSettings } from '../src/settings.ts';
import type { SettingsBoundary, SettingsReceipt } from '../src/settings.ts';
import { runWatch } from '../src/watch.ts';
import { swarmCommandNames } from '../src/commands.ts';
import { hostSdk } from './settings-helpers.ts';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { processExit } from './process-helpers.ts';
import { sharedFixture } from './shared-helpers.ts';

/** Read exact raw settings for preservation checks. */
function document(pmRoot: string): Record<string, unknown> { return JSON.parse(readFileSync(join(pmRoot, 'settings.json'), 'utf8')) as Record<string, unknown>; }
/** Seed foreign values through the fixture boundary, outside product writes. */
async function seed(pmRoot: string, swarm: unknown): Promise<void> {
  const sdk = await hostSdk(pmRoot);
  await sdk.mutateWorkspaceSettings({ operationId: randomUUID(), mutate: current => ({ ...current, foreign_section: { keep: true }, swarm }) });
}

const boundaries: SettingsBoundary[] = ['before_transaction', 'locked_read', 'validated', 'committed'];

test('typed settings resolve all leaves with explicit flag precedence and foreign-key isolation', async t => {
  const f = await sharedFixture(t);
  await seed(f.pmRoot, { base: 'develop', root: 'lanes', branch_prefix: 'parallel/', lane_limit: 2, progress_orchestrator: 'coordinator', future: { untouched: true } });
  assert.equal(swarmSettingsSection.name, 'swarm');
  assert.deepEqual(await settings(join(f.repo, 'absent-tracker')), swarmSettingsSection.defaults);
  assert.deepEqual(await settings(f.pmRoot), { base: 'develop', root: 'lanes', branch_prefix: 'parallel/', lane_limit: 2, progress_orchestrator: 'coordinator' });
  assert.deepEqual(await settings(f.pmRoot, { base: 'main', root: 'other', branch_prefix: 'review/', lane_limit: 3, progress_orchestrator: 'reviewer' }), { base: 'main', root: 'other', branch_prefix: 'review/', lane_limit: 3, progress_orchestrator: 'reviewer' });
  assert.deepEqual(resolveSwarmSettings({}), swarmSettingsSection.defaults);
  const sdk = await hostSdk(f.pmRoot);
  const before = readFileSync(join(f.pmRoot, 'settings.json'), 'utf8');
  const preview = await updateSettings(sdk, f.pmRoot, { lane_limit: 3 });
  assert.equal(preview.dry_run, true); assert.equal(preview.changed, true); assert.equal(preview.skipped.count, 1);
  assert.equal(readFileSync(join(f.pmRoot, 'settings.json'), 'utf8'), before);
  const result = await updateSettings(sdk, f.pmRoot, { lane_limit: 3 }, { apply: true, operationId: 'settings-owned-fields' });
  assert.equal(result.changed, true); assert.equal(result.replayed, false);
  assert.deepEqual((document(f.pmRoot).swarm as Record<string, unknown>).future, { untouched: true });
  assert.deepEqual(document(f.pmRoot).foreign_section, { keep: true });
  assert.equal((await updateSettings(sdk, f.pmRoot, {}, { apply: true })).changed, false);
  const replay = await updateSettings(sdk, f.pmRoot, { lane_limit: 8 }, { apply: true, operationId: 'settings-owned-fields' });
  assert.equal(replay.replayed, true); assert.equal(replay.changed, false); assert.equal(replay.swarm.lane_limit, 3);
});

for (const value of [null, [], true, 'invalid', 3]) test(`settings refuse non-object sections (${JSON.stringify(value)})`, async t => {
  const f = await sharedFixture(t); await seed(f.pmRoot, value);
  await assert.rejects(settings(f.pmRoot), (error: unknown) => error instanceof SettingsRefusal && error.code === 'swarm_settings_invalid');
});

test('settings refuse malformed JSON and document shapes with value-free typed remedies', async t => {
  const f = await sharedFixture(t);
  for (const raw of ['{', 'null', '[]', '4']) {
    writeFileSync(join(f.pmRoot, 'settings.json'), raw);
    await assert.rejects(settings(f.pmRoot), (error: unknown) => error instanceof SettingsRefusal && error.remedy.length > 10);
  }
  for (const field of ['base', 'root', 'branch_prefix', 'progress_orchestrator']) {
    for (const value of ['', '\n', 'a\0b', 3, null]) assert.throws(() => resolveSwarmSettings({ [field]: value }), /Invalid swarm/);
  }
  for (const lane_limit of [0, 9, 1.2, NaN, '2', null]) assert.throws(() => resolveSwarmSettings({ lane_limit }), /integer/);
  assert.equal(resolveSwarmSettings({ lane_limit: 'invalid' }, { lane_limit: 2 }).lane_limit, 2);
});

for (const boundary of boundaries) test(`settings preserve peer transitions at ${boundary} on one non-git tracker`, async t => {
  const f = await sharedFixture(t); await seed(f.pmRoot, { future: { preserved: true } });
  const sdk = await hostSdk(f.pmRoot); let peer: Promise<SettingsReceipt> | undefined;
  const first = await updateSettings(sdk, f.pmRoot, { lane_limit: 2 }, { apply: true, operationId: `first-${boundary}`,
    /** Start a competing audited transition at each package boundary, including inside its lock. */
    checkpoint: async step => {
      if (step !== boundary) return;
      peer = updateSettings(sdk, f.pmRoot, { base: 'peer' }, { apply: true, operationId: `peer-${boundary}` });
      if (step === 'before_transaction' || step === 'committed') await peer;
    },
  });
  assert.ok(peer); const second = await peer;
  assert.equal(first.swarm.lane_limit, 2); assert.equal(second.swarm.base, 'peer');
  assert.equal((await settings(f.pmRoot)).base, 'peer'); assert.equal((await settings(f.pmRoot)).lane_limit, 2);
  assert.deepEqual((document(f.pmRoot).swarm as Record<string, unknown>).future, { preserved: true });
  assert.deepEqual(document(f.pmRoot).foreign_section, { keep: true });
});

for (const boundary of boundaries) test(`settings rerun converges after interruption at ${boundary}`, async t => {
  const f = await sharedFixture(t); await seed(f.pmRoot, { future: { preserved: true } }); const sdk = await hostSdk(f.pmRoot);
  const operationId = `crash-${boundary}`;
  await assert.rejects(updateSettings(sdk, f.pmRoot, { lane_limit: 2 }, { apply: true, operationId,
    /** Interrupt the operation before or after the host's atomic durable commit. */
    checkpoint: step => { if (step === boundary) throw new Error('Injected interruption'); },
  }), /Injected interruption/);
  const rerun = await updateSettings(sdk, f.pmRoot, { lane_limit: 2 }, { apply: true, operationId });
  assert.equal(rerun.swarm.lane_limit, 2); assert.equal(rerun.replayed, boundary === 'committed');
  const before = readFileSync(join(f.pmRoot, 'settings.json'), 'utf8');
  assert.equal((await updateSettings(sdk, f.pmRoot, {}, { apply: true, operationId })).replayed, true);
  assert.equal(readFileSync(join(f.pmRoot, 'settings.json'), 'utf8'), before);
  assert.deepEqual((document(f.pmRoot).swarm as Record<string, unknown>).future, { preserved: true });
});

test('host renderer owns all package outputs while unrelated results use native rendering', async () => {
  const host = await createExtensionTestHarness(extension, { name: 'pm-swarm', capabilities: ['commands', 'schema', 'renderers'] });
  for (const format of ['toon', 'json'] as const) {
    for (const command of swarmCommandNames) {
      const result = { mode: 'shared-tracker', selected: 'public-task' };
      const rendered = await host.runRendererOverride({ format, command: `swarm ${command}`, result });
      assert.equal(rendered.overridden, true);
      assert.deepEqual(format === 'json' ? JSON.parse(rendered.rendered!) : decodeToon(rendered.rendered!), result);
      assert.ok(rendered.rendered!.length < 100);
    }
    assert.equal((await host.runRendererOverride({ format, command: 'list', result: { mode: 'shared-tracker' } })).overridden, false);
    assert.equal((await host.runRendererOverride({ format, command: 'swarm settings', result: null })).overridden, false);
    assert.equal((await host.runRendererOverride({ format, command: 'swarm settings', result: [] })).overridden, false);
    assert.equal((await host.runRendererOverride({ format, command: 'swarm settings', result: { swarm_watch_complete: true } })).rendered, '');
  }
});

test('private path guard refuses nested home paths, object keys and Windows paths without echo', async t => {
  const f = await sharedFixture(t);
  const paths = [join('/', 'home', 'private', 'project'), join('/', 'Users', 'private', 'project'), join('/', 'root', 'project'), ['C:', 'Users', 'private', 'project'].join('\\')];
  assertPrivatePathSafe({ values: [null, true, 4, 'src/work.ts', '../lanes'], empty: {} });
  for (const path of paths) {
    for (const value of [{ nested: [path] }, { [path]: true }]) assert.throws(() => assertPrivatePathSafe(value), (error: unknown) => error instanceof SettingsRefusal && error.code === 'swarm_private_path' && !error.message.includes(path));
    await seed(f.pmRoot, { base: path });
    const result = f.cli('swarm', 'settings', '--json');
    assert.equal(result.status, 2); assert.match(result.stdout + result.stderr, /swarm_private_path/); assert.equal((result.stdout + result.stderr).includes(path), false);
  }
  await seed(f.pmRoot, {});
  const privateFlag = f.cli('swarm', 'settings', '--base', paths[0], '--json');
  assert.equal(privateFlag.status, 2); assert.equal((privateFlag.stdout + privateFlag.stderr).includes(paths[0]), false);
  const result = f.cli('swarm', 'settings', '--limit', '9', '--json');
  assert.equal(result.status, 2); assert.match(result.stdout + result.stderr, /swarm_settings_invalid/);
});

for (const boundary of boundaries) test(`settings survive SIGKILL at ${boundary} without duplicate audit events`, { timeout: 90000 }, async t => {
  const f = await sharedFixture(t); const operationId = `killed-${boundary}`;
  const child = fork(new URL('./settings-worker.ts', import.meta.url), [f.pmRoot, boundary, operationId], { env: f.env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exit = processExit(child, 'exit'); let stderr = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  t.after(() => child.kill('SIGKILL'));
  const ready = await Promise.race([once(child, 'message'), exit.then(() => { throw new Error(stderr || 'Worker exited before checkpoint'); })]);
  assert.deepEqual(ready[0], { boundary }); child.kill('SIGKILL'); await exit;
  const sdk = await hostSdk(f.pmRoot);
  const receipt = await updateSettings(sdk, f.pmRoot, { lane_limit: 2 }, { apply: true, operationId });
  assert.equal(receipt.swarm.lane_limit, 2); assert.equal(receipt.replayed, boundary === 'committed');
  const auditPath = join(f.pmRoot, 'history', '_workspace.jsonl');
  const before = readFileSync(auditPath, 'utf8');
  assert.equal((await updateSettings(sdk, f.pmRoot, {}, { apply: true, operationId })).replayed, true);
  assert.equal(readFileSync(auditPath, 'utf8'), before);
});

test('watch refuses private lane values before emitting either format and restores its signal listener', async t => {
  const f = await sharedFixture(t); const id = await f.item(['src/public.ts']);
  await f.client.update(id, { assignee: join('/', 'home', 'private', 'worker') });
  const refusal = f.cli('swarm', 'start', id, '--json');
  assert.equal(refusal.status, 2); assert.match(refusal.stdout + refusal.stderr, /swarm_private_path/);
  assert.equal((refusal.stdout + refusal.stderr).includes(join('/', 'home', 'private', 'worker')), false);
  const listeners = process.listenerCount('SIGINT');
  for (const json of [false, true]) {
    const interrupt = setTimeout(() => process.emit('SIGINT'), 100);
    try { await assert.rejects(runWatch(f.shared, 1, json), (error: unknown) => error instanceof SettingsRefusal && error.code === 'swarm_private_path'); }
    finally { clearTimeout(interrupt); }
  }
  assert.equal(process.listenerCount('SIGINT'), listeners);
});
