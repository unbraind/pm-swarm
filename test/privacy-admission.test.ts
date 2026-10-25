import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { scanMutationSecrets, isPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import { createExtensionTestHarness } from '@unbrained/pm-cli/sdk/testing';
import extension from '../index.ts';
import { validateCommandInputs } from '../src/admission.ts';
import { runCommand } from '../src/commands.ts';
import { assertPrivatePathSafe, SettingsRefusal, updateSettings } from '../src/settings.ts';
import { containsPrivatePath } from '../src/privacy.ts';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { ResourceReservations } from '../src/resources.ts';
import { trackerResourceBackend } from '../src/resource-tracker.ts';
import { PlanProgress } from '../src/progress.ts';
import { privacyCorpus } from './privacy-corpus.ts';
import { sharedFixture } from './shared-helpers.ts';
import { hostSdk } from './settings-helpers.ts';

/** Fingerprint every directory, file byte and symlink in the tracker, including runtime and history. */
function snapshot(root: string): string {
  const entries = readdirSync(root, { recursive: true, encoding: 'utf8' }).sort().map(name => {
    const path = join(root, name); const stat = lstatSync(path);
    return [name, stat.isSymbolicLink() ? ['link', readlinkSync(path)] : stat.isDirectory() ? ['directory'] : ['file', createHash('sha256').update(readFileSync(path)).digest('hex')]];
  });
  return JSON.stringify(entries);
}
/** Refusal must have no returned receipt, stream bytes or partial tracker write. */
async function unchanged(root: string, action: () => Promise<unknown>, label: string, accepts: (error: unknown) => boolean = () => true): Promise<void> {
  const before = snapshot(root); let writes = 0; const original = process.stdout.write;
  process.stdout.write = new Proxy(original, { apply() { writes++; return true; } });
  try { await assert.rejects(action, accepts, label); }
  finally { process.stdout.write = original; }
  assert.equal(writes, 0, `${label}: partial output`);
  assert.equal(snapshot(root), before, `${label}: tracker changed`);
}

test('SDK privacy oracle results are measured for every encoding and normalized guards refuse all', () => {
  let detected = 0;
  for (const [name, value] of privacyCorpus) {
    if (scanMutationSecrets(value).some(finding => finding.rule === 'absolute_home_path')) detected++;
    assert.equal(containsPrivatePath(value), true, name);
    assert.throws(() => assertPrivatePathSafe({ nested: [value] }), SettingsRefusal, name);
    assert.throws(() => assertPrivatePathSafe({ [value]: 'public' }), SettingsRefusal, name);
  }
  assert.equal(privacyCorpus.length, 50); assert.equal(detected, 10);
  for (const safe of ['public', ['password', 'synthetic'].join('='), '%ff public', 'https://example.test/public', join('src', 'home', 'index.ts')]) assertPrivatePathSafe(safe);
});

test('every mutating command cross rejected encoding and input position is byte-identical with no receipt', async t => {
  const f = await sharedFixture(t); const sdk = await hostSdk(f.pmRoot);
  const id = await f.item(['src/work.ts']); const ready = await f.item(['src/ready.ts']);
  const claim = await f.shared.start(id);
  const resource = (await f.client.create({ type: 'Task', title: 'Resource', tags: 'swarm-resource' })).item.id;
  const resources = new ResourceReservations(trackerResourceBackend(f.shared.engine), 'shared-test');
  const reservation = await resources.reserve(resource);
  const plan = f.run('plan', 'create', '--title', 'Privacy plan', '--step', 'Produce');
  const progress = new PlanProgress({ cwd: f.repo, pmRoot: f.pmRoot, author: 'shared-test' }, true);
  let view = await progress.view(String(plan.id));
  f.run('plan', 'update-step', String(plan.id), view.steps[0].id, '--step-owner', 'shared-test');
  view = await progress.view(String(plan.id));
  const scenarios = [
    ['schedule', [], { skills: 'typescript' }], ['next', [], { parent: 'public-parent' }],
    ['start', [ready], { root: 'lanes', base: 'main', branchPrefix: 'work/' }],
    ['sync', [id], { files: 'src/work.ts,test/work.ts', token: claim.token, apply: true }],
    ['heartbeat', [id], { token: claim.token }], ['reclaim', [], { staleAfter: '120', to: 'receiver' }],
    ['handoff', [id], { token: claim.token, to: 'receiver', note: 'Public context' }],
    ['close', [id], { token: claim.token, note: 'Public completion' }],
    ['land', [], { execute: true }], ['reap', [], { agent: 'shared-test' }],
    ['settings', [], { apply: true, base: 'main', root: 'lanes', branchPrefix: 'work/', progressOrchestrator: 'coordinator', limit: '2', operationId: 'public-operation' }],
    ['progress', [String(plan.id)], { apply: true, stage: 'claimed', step: view.steps[0].id, revision: view.revision, evidence: 'Public proof', agent: 'shared-test' }],
    ...['reserve', 'renew', 'release', 'publish'].map(action => ['resource', [resource], { action, token: reservation.token, ttl: '300', note: 'Public publication' }] as const),
  ] as const;
  let checked = 0;
  for (const [command, args, options] of scenarios) {
    const base: CommandHandlerContext = { command: `swarm ${command}`, pm_root: f.pmRoot, source_workspace_root: f.repo, sdk, args: [...args], options: { ...options }, global: { author: 'shared-test' } };
    const slots = [...['author', 'path', 'outputInclude', 'outputLimit', 'outputBudget', 'outputFormat', 'outputSession', 'outputCursor', 'defaultOutputFormat'].map(key => `global:${key}`), ...base.args.map((_, index) => `arg:${index}`), ...Object.entries(base.options).filter(([, value]) => typeof value === 'string').map(([key]) => `flag:${key}`)];
    for (const [encoding, value] of privacyCorpus) for (const slot of slots) {
      const ctx = { ...base, args: [...base.args], options: { ...base.options }, global: { ...base.global } };
      if (slot.startsWith('global:')) Object.assign(ctx.global, { [slot.slice(7)]: value });
      else if (slot.startsWith('arg:')) ctx.args[Number(slot.slice(4))] = value;
      else ctx.options[slot.slice(5)] = value;
      await unchanged(f.pmRoot, () => runCommand(command, ctx), `${command}/${encoding}/${slot}`, (error: unknown) => isPmCliExpectedError(error) && error.code === 'swarm_private_path');
      checked++;
    }
    for (const rejected of ['', null, ['repeated'], 4]) {
      const ctx = { ...base, options: { ...base.options, agent: rejected } };
      await unchanged(f.pmRoot, () => runCommand(command, ctx), `${command}/invalid-scalar`); checked++;
    }
  }
  assert.equal(scenarios.length, 16); assert.ok(checked > 2000);
  console.log(JSON.stringify({ mutating_variants: scenarios.length, encodings: privacyCorpus.length, refused_input_cases: checked, tracker_changes: 0, partial_receipts: 0 }));
});

test('SDK mutation entries refuse every encoding before leases, settings journals or item writes', async t => {
  const f = await sharedFixture(t); const sdk = await hostSdk(f.pmRoot); const id = await f.item(['src/work.ts']);
  const resources = new ResourceReservations(trackerResourceBackend(f.shared.engine), 'shared-test');
  const progress = new PlanProgress({ cwd: f.repo, pmRoot: f.pmRoot, author: 'shared-test' }, true);
  const operations = (value: string) => [
    () => f.shared.schedule({ skills: [value] }), () => f.shared.next(value), () => f.shared.start(value),
    () => f.shared.sync(id, true, [value]), () => f.shared.heartbeat(value), () => f.shared.reclaim(120, value),
    () => f.shared.handoff(id, 'receiver', value), () => f.shared.close(id, value),
    () => new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, value)).reap(),
    () => new Swarm(f.repo, f.pmRoot, f.client, value).land(true),
    () => updateSettings(sdk, f.pmRoot, { base: value }, { apply: true }),
    () => progress.witness(id, { stage: 'claimed', step: 'step', revision: 'a'.repeat(64), evidence: value, apply: true }),
    () => f.shared.engine.start(value), () => f.shared.engine.next(value), () => f.shared.engine.sync(id, true, [value]),
    () => f.shared.engine.schedule({ skills: [value] }), () => new Swarm(f.repo, f.pmRoot, f.client, value).reap(),
    () => resources.reserve(value), () => resources.renew(id, value), () => resources.release(id, value), () => resources.publish(id, '1', value),
  ];
  for (const [name, value] of privacyCorpus) for (const [index, operation] of operations(value).entries()) await unchanged(f.pmRoot, operation, `${name}/sdk:${index}`);
  console.log(JSON.stringify({ sdk_mutation_entries: operations('public').length, sdk_refusals: operations('public').length * privacyCorpus.length, tracker_changes: 0 }));
});

test('native CLI handoff admission leaves ownership, fence, history and the entire tracker unchanged', async t => {
  const f = await sharedFixture(t); const id = await f.item(['src/work.ts']); const claim = await f.shared.start(id);
  // Warm native host reads once so the baseline includes its read caches.
  f.run('swarm', 'settings');
  for (const name of ['unix-home', 'angle-file-url']) {
    const value = privacyCorpus.find(([encoding]) => encoding === name)![1];
    const before = snapshot(f.pmRoot);
    const result = f.cli('swarm', 'handoff', id, '--token', claim.token, '--to', 'receiver', '--note', value, '--json');
    assert.equal(result.status, 2); const body = JSON.parse(result.stdout || result.stderr) as Record<string, unknown>;
    assert.equal(body.code, 'swarm_private_path'); assert.equal('context' in body, false);
    assert.equal(snapshot(f.pmRoot), before); assert.equal((result.stdout + result.stderr).includes(value), false);
  }
});

test('host rendering refuses every encoded private value before JSON or TOON serialization', async () => {
  const host = await createExtensionTestHarness(extension, { name: 'pm-swarm', capabilities: ['commands', 'schema', 'renderers'] });
  for (const [, value] of privacyCorpus) for (const format of ['toon', 'json'] as const) {
    for (const output of [value, [value], { unexpected: value }, { id: 'public-item', note: value }]) {
      const result = await host.runRendererOverride({ command: 'swarm handoff', format, result: output });
      assert.equal(result.overridden, true); assert.deepEqual(result.warnings, []);
      assert.match(result.rendered!, /swarm_private_path/); assert.equal(result.rendered!.includes(value), false);
    }
  }
});

test('malformed command inputs are refused before the first tracker write', async t => {
  const f = await sharedFixture(t); const sdk = await hostSdk(f.pmRoot);
  const base: CommandHandlerContext = { command: 'swarm settings', args: [], options: {}, global: { author: 'shared-test' }, pm_root: f.pmRoot, source_workspace_root: f.repo, sdk };
  const cases: [string, string[], Record<string, unknown>][] = [
    ['settings', [], { apply: 'yes' }], ['settings', [''], {}], ['settings', [], { token: 'not-decimal' }],
    ['settings', [], { root: join(f.repo, 'lanes') }], ['settings', [], { root: 'D:/lanes' }],
    ['start', [], {}], ['sync', ['public-item'], { files: 'src/a,,src/b', apply: true }],
    ['sync', ['public-item'], { files: '../escape', apply: true }],
    ['handoff', ['public-item'], { note: 'Public context' }], ['handoff', ['public-item'], { to: 'receiver', note: 'x'.repeat(4097) }],
    ['close', ['public-item'], {}], ['resource', ['public-item'], { action: 'invalid' }],
    ...['0', '86401', 'NaN', '1.5'].map(ttl => ['resource', ['public-item'], { action: 'reserve', ttl }] as [string, string[], Record<string, unknown>]),
    ['resource', ['public-item'], { action: 'publish', note: 'x'.repeat(4097) }], ['resource', ['public-item'], { action: 'publish' }],
    ['schedule', [], { skills: 'invalid skill' }], ['schedule', [], { maxWait: '0' }], ['schedule', [], { limit: '101' }],
    ['reclaim', [], {}], ['reclaim', [], { staleAfter: '0' }],
    ...['-1', 'NaN', '1.5'].map(offset => ['progress', ['public-plan'], { offset }] as [string, string[], Record<string, unknown>]),
    ...['0', '101', 'NaN'].map(limit => ['progress', ['public-plan'], { limit }] as [string, string[], Record<string, unknown>]),
    ['progress', ['public-plan'], { stage: 'invalid', step: 'step', revision: 'a'.repeat(64), evidence: 'Public' }],
    ['progress', ['public-plan'], { stage: 'claimed' }],
    ['progress', ['public-plan'], { stage: 'claimed', step: 'step' }],
    ['progress', ['public-plan'], { stage: 'claimed', step: 'step', revision: 'a'.repeat(64) }],
    ['progress', ['public-plan'], { apply: true }], ['progress', ['public-plan'], { step: 'step' }], ['progress', ['public-plan'], { evidence: 'Public' }],
  ];
  for (const [command, args, options] of cases) await unchanged(f.pmRoot, () => runCommand(command, { ...base, args, options }), `${command}/invalid-domain`);
  await unchanged(f.pmRoot, () => runCommand('settings', { ...base, global: { author: '' } }), 'empty-author');
  const before = snapshot(f.pmRoot);
  validateCommandInputs('settings', { ...base, options: { base: 'main', root: 'lanes', branchPrefix: 'work/', progressOrchestrator: 'coordinator', limit: '2', apply: false, unused: undefined } });
  validateCommandInputs('sync', { ...base, args: ['public-item'], options: { files: 'src/a,src/b', apply: false } });
  validateCommandInputs('resource', { ...base, args: ['public-resource'], options: {} });
  assert.equal(snapshot(f.pmRoot), before);
  console.log(JSON.stringify({ malformed_inputs: cases.length + 1, tracker_changes: 0 }));
});
