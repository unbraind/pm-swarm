import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanMutationSecrets, isPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import { validateCommandInputs } from '../src/admission.ts';
import { runCommand } from '../src/commands.ts';
import { assertPrivatePathSafe, SettingsRefusal, updateSettings } from '../src/settings.ts';
import { containsPrivatePath } from '../src/privacy.ts';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { ResourceReservations } from '../src/resources.ts';
import { trackerResourceBackend } from '../src/resource-tracker.ts';
import { PlanProgress } from '../src/progress.ts';
import { privacyCorpus, rejectedCorpus, embeddedCorpus, malformedCorpus } from './privacy-corpus.ts';
import { homeFuzz, allowedFuzz } from './privacy-fuzz.ts';
import { sharedFixture } from './shared-helpers.ts';
import { hostSdk, swarmHost, assertPrivacyRendering } from './settings-helpers.ts';
import { mutationInputs, mutationVariants, ownedPlan } from './privacy-mutations.ts';
import { snapshot, unchanged } from './privacy-snapshot.ts';

test('SDK privacy oracle results are measured for every encoding and normalized guards refuse all', () => {
  let detected = 0;
  for (const [name, value] of rejectedCorpus) {
    if (privacyCorpus.some(([id]) => id === name) && scanMutationSecrets(value).some(finding => finding.rule === 'absolute_home_path')) detected++;
    assert.equal(containsPrivatePath(value), true, name);
    assert.throws(() => assertPrivatePathSafe({ nested: [value] }), SettingsRefusal, name);
    assert.throws(() => assertPrivatePathSafe({ [value]: 'public' }), SettingsRefusal, name);
  }
  assert.equal(privacyCorpus.length, 50); assert.equal(detected, 10);
  for (const safe of ['public', ['password', 'synthetic'].join('='), '%ff public', 'https://example.test/public', join('src', 'settings', 'index.ts')]) assertPrivatePathSafe(safe);
});

test('every mutating command cross rejected encoding and input position is byte-identical with no receipt', async t => {
  const f = await sharedFixture(t); const sdk = await hostSdk(f.pmRoot);
  const id = await f.item(['src/work.ts']); const ready = await f.item(['src/ready.ts']);
  const claim = await f.shared.start(id);
  const resource = (await f.client.create({ type: 'Task', title: 'Resource', tags: 'swarm-resource' })).item.id;
  const resources = new ResourceReservations(trackerResourceBackend(f.shared.engine), 'shared-test');
  const reservation = await resources.reserve(resource);
  const { plan, view } = await ownedPlan(f);
  const inputs: Record<string, { args: string[]; options: Record<string, unknown> }> = {
    schedule: { args: [], options: { skills: 'typescript' } }, next: { args: [], options: { parent: 'public-parent' } },
    start: { args: [ready], options: { root: 'lanes', base: 'main', branchPrefix: 'work/' } },
    sync: { args: [id], options: { files: 'src/work.ts,test/work.ts', token: claim.token, apply: true } },
    heartbeat: { args: [id], options: { token: claim.token } }, reclaim: { args: [], options: { staleAfter: '120', to: 'receiver' } },
    handoff: { args: [id], options: { token: claim.token, to: 'receiver', note: 'Public context' } },
    close: { args: [id], options: { token: claim.token, note: 'Public completion' } },
    land: { args: [], options: { execute: true } }, reap: { args: [], options: { agent: 'shared-test' } },
    settings: { args: [], options: { apply: true, base: 'main', root: 'lanes', branchPrefix: 'work/', progressOrchestrator: 'coordinator', limit: '2', operationId: 'public-operation' } },
    progress: { args: [String(plan.id)], options: { apply: true, stage: 'claimed', step: view.steps[0].id, revision: view.revision, evidence: 'Public proof', agent: 'shared-test' } },
    resource: { args: [resource], options: { token: reservation.token, ttl: '300', note: 'Public publication' } },
  };
  const scenarios = mutationVariants().map(variant => {
    const input = inputs[variant.command]; assert.ok(input, `Missing fixture for registered mutator ${variant.command}`);
    return [variant.command, input.args, { ...input.options, ...variant.options }] as const;
  });
  let checked = 0;
  for (const [command, args, options] of scenarios) {
    const base: CommandHandlerContext = { command: `swarm ${command}`, pm_root: f.pmRoot, source_workspace_root: f.repo, sdk, args: [...args], options: { ...options }, global: { author: 'shared-test' } };
    // Tracker location is an invocation coordinate, covered by the must-allow property.
    const slots = [...['author', 'outputInclude', 'outputLimit', 'outputBudget', 'outputFormat', 'outputSession', 'outputCursor', 'defaultOutputFormat'].map(key => `global:${key}`), ...base.args.map((_, index) => `arg:${index}`), ...Object.entries(base.options).filter(([, value]) => typeof value === 'string').map(([key]) => `flag:${key}`)];
    for (const [encoding, value] of rejectedCorpus) for (const slot of slots) {
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
  assert.equal(scenarios.length, 19); assert.ok(checked > 2000);
  console.log(JSON.stringify({ mutating_variants: scenarios.length, encodings: rejectedCorpus.length, refused_input_cases: checked, tracker_changes: 0, partial_receipts: 0 }));
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
  for (const [name, value] of rejectedCorpus) for (const [index, operation] of operations(value).entries()) await unchanged(f.pmRoot, operation, `${name}/sdk:${index}`);
  console.log(JSON.stringify({ sdk_mutation_entries: operations('public').length, sdk_refusals: operations('public').length * rejectedCorpus.length, tracker_changes: 0 }));
});

test('native CLI handoff admission leaves ownership, fence, history and the entire tracker unchanged', async t => {
  const f = await sharedFixture(t); const id = await f.item(['src/work.ts']); const claim = await f.shared.start(id);
  // Warm native host reads once so the baseline includes its read caches.
  f.run('swarm', 'settings');
  const values = [...rejectedCorpus.filter(([name]) => ['unix-home', 'angle-file-url', 'dot-segment-root', 'forward-unc-authority'].includes(name)), ...embeddedCorpus, ...malformedCorpus];
  for (const [, value] of values) {
    const before = snapshot(f.pmRoot);
    const result = f.cli('swarm', 'handoff', id, '--token', claim.token, '--to', 'receiver', '--note', value, '--json');
    assert.equal(result.status, 2); const body = JSON.parse(result.stdout || result.stderr) as Record<string, unknown>;
    assert.equal(body.code, 'swarm_private_path'); assert.equal('context' in body, false);
    assert.equal(snapshot(f.pmRoot), before); assert.equal((result.stdout + result.stderr).includes(value), false);
  }
});

test('host rendering refuses every encoded private value before JSON or TOON serialization', async () => {
  const host = await swarmHost();
  for (const [, value] of rejectedCorpus) for (const format of ['toon', 'json'] as const) {
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
    ['resource', ['public-item'], { action: 'publish', note: 'x'.repeat(4097), token: '1' }], ['resource', ['public-item'], { action: 'publish', token: '1' }],
    ['resource', ['public-item'], { action: 'renew' }], ['resource', ['public-item'], { action: 'release', token: 'invalid' }],
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
  for (const [command, args, options] of cases) {
    const ctx = { ...base, args, options };
    assert.throws(() => validateCommandInputs(command, ctx), `${command}/pure-admission`);
    await unchanged(f.pmRoot, () => runCommand(command, ctx), `${command}/invalid-domain`);
  }
  await unchanged(f.pmRoot, () => runCommand('settings', { ...base, global: { author: '' } }), 'empty-author');
  const before = snapshot(f.pmRoot);
  validateCommandInputs('settings', { ...base, options: { base: 'main', root: 'lanes', branchPrefix: 'work/', progressOrchestrator: 'coordinator', limit: '2', apply: false, unused: undefined } });
  validateCommandInputs('sync', { ...base, args: ['public-item'], options: { files: 'src/a,src/b', apply: false } });
  validateCommandInputs('resource', { ...base, args: ['public-resource'], options: {} });
  assert.equal(snapshot(f.pmRoot), before);
  console.log(JSON.stringify({ malformed_inputs: cases.length + 1, tracker_changes: 0 }));
});

test('SDK settings reject invalid root inputs before entering their audited transaction', async t => {
  const f = await sharedFixture(t); const sdk = await hostSdk(f.pmRoot);
  for (const root of [join(f.repo, 'lanes'), 'D:/lanes']) {
    const checkpoints: string[] = [];
    await unchanged(f.pmRoot, () => updateSettings(sdk, f.pmRoot, { root }, { apply: true, checkpoint: boundary => { checkpoints.push(boundary); } }), 'settings/invalid-root');
    assert.deepEqual(checkpoints, [], 'refuse before even entering the transaction boundary');
  }
});

test('settings validate the fresh locked section after a competing transition changes preflight inputs', async t => {
  const f = await sharedFixture(t); const sdk = await hostSdk(f.pmRoot);
  for (const [index, root] of [join(f.repo, 'lanes'), 'D:/lanes'].entries()) {
    await sdk.mutateWorkspaceSettings({ operationId: `reset-${index}`, mutate: current => ({ ...current, swarm: { base: 'main', root: 'lanes' } }) });
    let peerSettings = ''; let peerHistory = '';
    await assert.rejects(updateSettings(sdk, f.pmRoot, { base: 'ours' }, { apply: true, operationId: `racing-${index}`,
      /** Inject the real peer writer between preflight and acquisition of our audited lock. */
      checkpoint: async boundary => {
        if (boundary !== 'before_transaction') return;
        await sdk.mutateWorkspaceSettings({ operationId: `peer-${index}`, mutate: current => ({ ...current, swarm: { root, base: 'peer' } }) });
        peerSettings = readFileSync(join(f.pmRoot, 'settings.json'), 'utf8');
        peerHistory = readFileSync(join(f.pmRoot, 'history/_workspace.jsonl'), 'utf8');
      },
    }), /relative|swarm_private_path/);
    assert.equal(readFileSync(join(f.pmRoot, 'settings.json'), 'utf8'), peerSettings);
    assert.equal(readFileSync(join(f.pmRoot, 'history/_workspace.jsonl'), 'utf8'), peerHistory);
  }
});

test('command admission snapshots accepted inputs before awaiting the host SDK', async t => {
  const f = await sharedFixture(t); const sdk = await hostSdk(f.pmRoot); const id = await f.item(['src/work.ts']);
  const claim = await f.shared.start(id);
  const ctx: CommandHandlerContext = { command: 'swarm handoff', args: [id], options: { to: 'receiver', note: 'Accepted public context', token: claim.token }, global: { author: 'shared-test' }, source_workspace_root: f.repo, pm_root: f.pmRoot, sdk };
  const operation = runCommand('handoff', ctx);
  ctx.options.note = privacyCorpus.find(([name]) => name === 'angle-file-url')![1];
  const result = await operation;
  assert.equal((result.context as { note: string }).note, 'Accepted public context');
  const item = (await f.client.get(id)).item;
  assert.match(String(item.swarm_handoff), /Accepted public context/);
  assert.equal(String(item.swarm_handoff).includes(String(ctx.options.note)), false);
});

test('SDK resource tokens are validated before entering a backend lease', async t => {
  const f = await sharedFixture(t);
  const id = (await f.client.create({ type: 'Task', title: 'Resource', tags: 'swarm-resource' })).item.id;
  const backend = trackerResourceBackend(f.shared.engine); let entries = 0;
  // Observe the real adapter; every admitted call still runs its real lease and mutation.
  backend.transact = new Proxy(backend.transact, { apply(target, receiver, args: unknown[]) { entries++; return Reflect.apply(target, receiver, args); } });
  const resources = new ResourceReservations(backend, 'shared-test');
  await resources.reserve(id); entries = 0;
  for (const token of ['invalid', '01']) {
    await unchanged(f.pmRoot, () => resources.renew(id, token), 'resource/renew-invalid-token');
    await unchanged(f.pmRoot, () => resources.release(id, token), 'resource/release-invalid-token');
    await unchanged(f.pmRoot, () => resources.publish(id, token, 'Public receipt'), 'resource/publish-invalid-token');
  }
  assert.equal(entries, 0, 'invalid tokens must never enter the backend');
});

test('native schedule preserves an admitted max-wait override without claiming work', async t => {
  const f = await sharedFixture(t); const id = await f.item(['src/work.ts']);
  const result = f.run('swarm', 'schedule', '--skills', 'typescript', '--max-wait', '17', '--limit', '1', '--dry-run');
  assert.equal(result.max_wait_seconds, 17); assert.equal(result.selected, id);
  assert.equal((await f.client.get(id, { fields: 'claim_state' })).claim_state?.claimed, false);
});

/** Valid command domains keep privacy as the only reason a fuzz command can be refused. */
function fuzzCommands(): [string, string[], Record<string, unknown>][] {
  return mutationVariants().map(variant => { const input = mutationInputs(variant); return [variant.command, input.args, input.options]; });
}

/** Use a real shared tracker, injected SDK and registered renderer for both generators. */
async function fuzzFixture(t: TestContext) {
  const fixture = await sharedFixture(t);
  return { ...fixture, sdk: await hostSdk(fixture.pmRoot), host: await swarmHost() };
}
test('seeded compositional home paths are refused by every mutator and both renderers', async t => {
  const f = await fuzzFixture(t); const { sdk, host } = f;
  const before = snapshot(f.pmRoot); const seed = 0x51a7c0de;
  const cases = homeFuzz(seed, 5000);
  for (const [index, value] of cases.entries()) {
    assert.equal(containsPrivatePath(value), true, `absolute seed=${seed} case=${index} ${JSON.stringify(value)}`);
    for (const [command, args, options] of fuzzCommands()) {
      const ctx: CommandHandlerContext = { command: `swarm ${command}`, args, options: { ...options }, global: { author: value }, pm_root: f.pmRoot, source_workspace_root: f.repo, sdk };
      await assert.rejects(runCommand(command, ctx), (error: unknown) => isPmCliExpectedError(error) && error.code === 'swarm_private_path', `${index}/${command}`);
    }
    await assertPrivacyRendering(host, value, true);
  }
  assert.equal(snapshot(f.pmRoot), before);
  console.log(JSON.stringify({ home_seed: seed, home_cases: cases.length, command_refusals: cases.length * fuzzCommands().length, renderer_refusals: cases.length * 2, tracker_changes: 0 }));
});

test('seeded relative paths and web URLs have no false privacy refusals', async t => {
  const f = await fuzzFixture(t); const { sdk, host } = f;
  const seed = 0x6a09e667; const cases = allowedFuzz(seed, 5000);
  for (const [index, value] of cases.entries()) {
    assert.equal(containsPrivatePath(value), false, `allowed seed=${seed} case=${index} ${JSON.stringify(value)}`);
    for (const [command, args, options] of fuzzCommands()) validateCommandInputs(command, { command: `swarm ${command}`, args, options: { ...options }, global: { author: value }, sdk, pm_root: f.pmRoot, source_workspace_root: f.repo });
    await assertPrivacyRendering(host, value, false);
  }
  console.log(JSON.stringify({ allowed_seed: seed, relative_paths: cases.length / 2, web_urls: cases.length / 2, admitted_command_inputs: cases.length * fuzzCommands().length, false_refusals: 0 }));
});


test('canonicalization handles bounded nested escapes and both filesystem grammars', () => {
  const root = ['', 'home', 'private', 'work'].join('/');
  const paths = [
    root, root.replaceAll('/', '&#47;'), root.replaceAll('/', '&sol;'), root.replaceAll('/', '&frasl;'), root.replaceAll('/', '&Backslash;'),
    root.replaceAll('/', String.raw`\u{2f}`), root.replaceAll('/', String.raw`\x2f`),
    root.replaceAll('/', String.raw`\u002f`), root.replaceAll('/', String.raw`\uFF0F`),
    root.replaceAll('/', '\u2216'), root.replaceAll('/', '&bsol;'),
    `file:${root}`, `path:${root}`, `note:file:${root}`, `[outer]([inner](${root}))`, `![image](<${root}>)`, `{${root}}`, `note:${'${HOME}'}/work`, root.replaceAll('/', '//../'),
    '$env:USERPROFILE/work', '${HOME}/work',
  ];
  for (const path of paths) assert.equal(containsPrivatePath(path), true, JSON.stringify(path));
  for (const safe of ['&#x110000; public', '&#1114112; public', '&unknown; public', 'public &amp; text', 'Z:relative-drive-root', 'src/../work', 'http://example.test/a', 'https://example.test/a', 'link:https://example.test/a']) assert.equal(containsPrivatePath(safe), false, safe);
  let nested = root;
  for (let round = 0; round < 18; round++) nested = encodeURIComponent(nested);
  assert.equal(containsPrivatePath(nested), true, 'bounded decoder refuses unresolved nesting');
  let boundary = root;
  for (let round = 0; round < 16; round++) boundary = encodeURIComponent(boundary);
  assert.equal(containsPrivatePath(boundary), true, 'fixed point reached at exact bound');
});
