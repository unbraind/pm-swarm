import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import fs, { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import { validateCommandInputs } from '../src/admission.ts';
import { runCommand, swarmCommandDefinitions } from '../src/commands.ts';
import { heartbeatPath, withSwarmLease } from '../src/lease.ts';
import { SettingsRefusal } from '../src/settings.ts';
import { rejectedCorpus } from './privacy-corpus.ts';
import { mutationInputs, mutationVariants, declareService } from './privacy-mutations.ts';
import { unchanged, snapshot } from './privacy-snapshot.ts';
import { sharedFixture } from './shared-helpers.ts';
import { hostSdk, swarmHost } from './settings-helpers.ts';
import { assertTrackerInvocations, assertIncomingHandoffRefusals } from './invocation-helpers.ts';

/** Count real runtime writes without substituting SDK behavior or filesystem results. */
function runtimeWrites(t: TestContext, pmRoot: string) {
  let count = 0;
  const observations = (['writeFileSync', 'mkdirSync', 'linkSync', 'unlinkSync'] as const).map(name => t.mock.method(fs, name, new Proxy(fs[name], {
    apply(target, receiver, args: unknown[]) {
      if (String(args[0]).startsWith(join(pmRoot, 'runtime/swarm'))) count++;
      return Reflect.apply(target, receiver, args);
    },
  })));
  syncBuiltinESMExports();
  t.after(() => { for (const observation of observations) observation.mock.restore(); syncBuiltinESMExports(); });
  return () => count;
}

test('every registered command admits private tracker coordinates while keeping all content refusals', () => {
  let cases = 0;
  for (const [command, definition] of Object.entries(swarmCommandDefinitions)) {
    const variants = mutationVariants().filter(variant => variant.command === command);
    if (variants.length === 0) variants.push({ command, id: definition.id, flags: definition.flags, options: {} });
    for (const variant of variants) for (const [, location] of rejectedCorpus) {
      const input = mutationInputs(variant);
      const ctx: CommandHandlerContext = { command: `swarm ${command}`, ...input, global: { author: 'shared-test', path: location }, pm_root: location, source_workspace_root: location, repo_root: location };
      validateCommandInputs(command, ctx);
      assert.throws(() => validateCommandInputs(command, { ...ctx, global: { ...ctx.global, author: location } }), SettingsRefusal);
      cases++;
    }
  }
  assert.equal(cases, 22 * rejectedCorpus.length);
  console.log(JSON.stringify({ invocation_admissions: cases, content_refusals: cases, preserved_encodings: rejectedCorpus.length }));
});

test('real non-Git home trackers admit absolute relative environment and cwd locations in both formats', async t => {
  const f = await sharedFixture(t);
  let cases = assertTrackerInvocations({ runtime: process.execPath, host: f.host, project: f.repo, pmRoot: f.pmRoot, environment: f.env });
  for (const name of ['project', 'space \u03a9 project']) {
    const project = join(f.repo, name); const pmRoot = join(project, '.agents/pm'); mkdirSync(project);
    cpSync(f.pmRoot, pmRoot, { recursive: true });
    cases += assertTrackerInvocations({ runtime: process.execPath, host: f.host, project, pmRoot, environment: f.env });
  }
  const sdk = await hostSdk(f.pmRoot);
  const result = await runCommand('settings', { command: 'swarm settings', args: [], options: {}, global: { path: f.pmRoot, author: 'shared-test' }, sdk, pm_root: f.pmRoot, source_workspace_root: f.repo });
  const host = await swarmHost();
  for (const format of ['toon', 'json'] as const) {
    const rendered = await host.runRendererOverride({ command: 'swarm settings', format, result, global: { path: f.pmRoot }, pm_root: f.pmRoot });
    assert.equal(rendered.overridden, true); assert.doesNotMatch(rendered.rendered!, /swarm_private_path/);
    assert.equal(rendered.rendered!.includes(f.pmRoot), false);
  }
  assert.equal(cases, 36);
});

for (const command of ['next', 'schedule'] as const) test(`${command} refuses the entire incoming handoff corpus before any lease liveness or token effects`, async t => {
  const f = await sharedFixture(t); const id = await f.item(['src/public.ts']);
  await f.shared.start(id); await f.client.update(id, { field: ['swarm_token=7'] });
  writeFileSync(heartbeatPath(f.pmRoot, 'shared-test'), '{"heartbeat":"2000-01-01T00:00:00.000Z"}');
  const writes = runtimeWrites(t, f.pmRoot);
  for (const [name, value] of rejectedCorpus) {
    await f.client.update(id, { field: [`swarm_handoff=${JSON.stringify({ token: '7', nested: { note: value } })}`] });
    await f.shared.engine.corpus();
    for (const dryRun of [true, false]) {
      await unchanged(f.pmRoot, () => command === 'next' ? f.shared.next(undefined, dryRun) : f.shared.schedule({ skills: [], dryRun }), `${command}/${name}/${dryRun}`, error => error instanceof SettingsRefusal && error.code === 'swarm_private_path');
      assert.equal(writes(), 0, 'refusal entered a runtime writer');
    }
  }
  // Refused receipt must not replace the worker's cached generation with seven.
  await f.client.update(id, { field: ['swarm_handoff={"token":"7","note":"Public"}'] });
  await assert.rejects(f.shared.close(id, 'Public completion'), /swarm_stale_fence/);
});

test('incoming handoff shape and fence refusals precede lease acquisition and preserve liveness', async t => {
  const f = await sharedFixture(t); const id = await f.item(); await f.shared.start(id);
  const writes = runtimeWrites(t, f.pmRoot);
  for (const context of ['{', 'null', '[]', '{"token":"0"}', '{"token":1}', '{"token":"bad"}']) {
    await f.client.update(id, { field: [`swarm_handoff=${context}`] }); await f.shared.engine.corpus();
    for (const action of [() => f.shared.next(), () => f.shared.schedule({ skills: [] })]) await unchanged(f.pmRoot, action, 'incoming/fence', error => String(error).includes('swarm_stale_fence'));
  }
  assert.equal(writes(), 0);
});

test('provider-capable incoming preflight uses the bound host corpus and never a local selection fallback', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const claim = await f.shared.start(id);
  declareService(f);
  const value = encodeURIComponent(['', 'home', 'private', 'provider'].join('/'));
  await f.client.update(id, { field: [`swarm_handoff=${JSON.stringify({ token: claim.token, note: value })}`] });
  await f.shared.engine.corpus(); const writes = runtimeWrites(t, f.pmRoot);
  await unchanged(f.pmRoot, () => f.shared.next(), 'provider/incoming', error => error instanceof SettingsRefusal);
  assert.equal(writes(), 0);
  await f.client.update(id, { field: [`swarm_handoff=${JSON.stringify({ token: claim.token, note: 'Public provider context' })}`] });
  assert.equal((await f.shared.next()).context?.note, 'Public provider context');
});

test('native non-Git next and schedule refusals have no partial JSON or TOON receipt or heartbeat effect', async t => {
  const f = await sharedFixture(t); const id = await f.item(['src/public.ts']); const claim = await f.shared.start(id);
  await f.client.update(id, { tags: 'skill:typescript' });
  assert.equal(assertIncomingHandoffRefusals({ runtime: process.execPath, host: f.host, project: f.repo, pmRoot: f.pmRoot, environment: f.env }, id, claim.token, ['typescript']), 16);
});

test('handoff validates existing document and prospective context before entering its lease', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const claim = await f.shared.start(id);
  const value = encodeURIComponent(['', 'home', 'private', 'handoff'].join('/'));
  await f.client.update(id, { title: value });
  const writes = runtimeWrites(t, f.pmRoot);
  await unchanged(f.pmRoot, () => f.shared.handoff(id, 'receiver', 'Public note', claim.token), 'handoff/stored', error => error instanceof SettingsRefusal);
  await unchanged(f.pmRoot, () => f.shared.handoff(id, 'receiver', value, claim.token), 'handoff/input', error => error instanceof SettingsRefusal);
  assert.equal(writes(), 0);
});

test('lease completion admits every private result before publishing principal liveness', async t => {
  const f = await sharedFixture(t); await f.shared.heartbeat();
  for (const [name, value] of rejectedCorpus) {
    const before = snapshot(f.pmRoot);
    await assert.rejects(withSwarmLease(f.pmRoot, 'shared-test', async () => ({ nested: [value] })), SettingsRefusal, name);
    assert.equal(snapshot(f.pmRoot), before, name);
  }
});

test('lease result admission projects only the local Git worktree coordinate and still refuses private content', async t => {
  const f = await sharedFixture(t);
  const workspace = ['', 'home', 'private', 'project'].join('/');
  const value = { worktree: `${workspace}/lanes/item`, note: 'Public receipt' };
  assert.equal(await withSwarmLease(f.pmRoot, 'shared-test', async () => value, { receiptWorkspace: workspace }), value);
  await unchanged(f.pmRoot, () => withSwarmLease(f.pmRoot, 'shared-test', async () => ({ ...value, note: workspace }), { receiptWorkspace: workspace }), 'lease/projected-private-content');
  assert.equal(await withSwarmLease(f.pmRoot, 'shared-test', async () => null, { receiptWorkspace: workspace }), null);
  assert.equal(await withSwarmLease(f.pmRoot, 'shared-test', async () => 'Public', { receiptWorkspace: workspace }), 'Public');
  assert.equal(await withSwarmLease(f.pmRoot, 'shared-test', async () => ({ worktree: 4 }), { receiptWorkspace: workspace }).then(value => value.worktree), 4);
  assert.equal(await withSwarmLease(f.pmRoot, 'shared-test', async () => ({ id: 'public' }), { receiptWorkspace: workspace }).then(value => value.id), 'public');
});
