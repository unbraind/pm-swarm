import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResourceReservations } from '../src/resources.ts';
import { trackerResourceBackend } from '../src/resource-tracker.ts';
import { createExtensionTestHarness } from '@unbrained/pm-cli/sdk/testing';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import extension from '../index.ts';
import { runCommand, swarmCommandDefinitions } from '../src/commands.ts';
import { validateCommandInputs } from '../src/admission.ts';
import { mutationVariants, mutationInputs, ownedPlan, declareService } from './privacy-mutations.ts';
import { unchanged, matchesRefusal } from './privacy-snapshot.ts';
import { sharedFixture } from './shared-helpers.ts';
import { hostSdk } from './settings-helpers.ts';

test('registered mutators refuse every input admission class without tracker changes or partial receipts', async t => {
  const f = await sharedFixture(t); const sdk = await hostSdk(f.pmRoot);
  const host = await createExtensionTestHarness(extension, { name: 'pm-swarm', capabilities: ['commands', 'schema', 'renderers'] });
  const registered = host.activation.registrations.commands.map(definition => definition.command.replace(/^swarm /, ''));
  assert.deepEqual([...registered].sort(), Object.keys(swarmCommandDefinitions).sort());
  const variants = registered.flatMap(command => mutationVariants().filter(variant => variant.command === command));
  assert.equal(variants.length, 19); assert.ok(variants.some(variant => variant.command === 'start'));
  const codes = new Set<string>(); const counts: Record<string, number> = {};
  const privateValue = encodeURIComponent(['', 'home', 'private', 'project'].join('/'));
  for (const variant of variants) {
    const input = mutationInputs(variant);
    const base: CommandHandlerContext = { command: `swarm ${variant.command}`, ...input, global: { author: 'shared-test' }, sdk, pm_root: f.pmRoot, source_workspace_root: f.repo };
    validateCommandInputs(variant.command, base);
    /** Snapshot the complete tracker for each rejected invocation, not just the target item. */
    const refuse = async (label: string, ctx: CommandHandlerContext, code?: string) => {
      await unchanged(f.pmRoot, () => runCommand(variant.command, ctx), `${variant.command}/${label}`, (error: unknown) => matchesRefusal(error, code, codes));
      counts[variant.command] = (counts[variant.command] ?? 0) + 1;
    };
    await refuse('privacy', { ...base, global: { author: privateValue } }, 'swarm_private_path');
    await refuse('empty-author', { ...base, global: { author: '' } }, 'swarm_input_invalid');
    await refuse('empty-argument', { ...base, args: [''] }, 'swarm_input_invalid');
    if (variant.id) await refuse('missing-id', { ...base, args: [] }, 'swarm_input_invalid');
    for (const flag of variant.flags) {
      const key = flag.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      const boolean = ['dryRun', 'apply', 'execute', 'full', 'strict', 'watch'].includes(key);
      for (const value of boolean ? ['yes', null, 1] : ['', ['repeated'], null, 1]) {
        await refuse(`shape/${key}`, { ...base, options: { ...base.options, [key]: value } }, 'swarm_input_invalid');
      }
      if (['limit', 'ttl', 'maxWait', 'offset', 'staleAfter', 'token'].includes(key)) {
        const value = key === 'offset' ? '-1' : key === 'token' ? 'invalid' : '0';
        const ctx = { ...base, options: { ...base.options, [key]: value } };
        // A reserve token is unused, but still must satisfy the common scalar-token contract.
        await refuse(`domain/${key}`, ctx);
      }
      if (['base', 'root', 'branchPrefix', 'progressOrchestrator'].includes(key)) {
        await refuse(`settings/${key}`, { ...base, options: { ...base.options, [key]: '\u0000' } }, 'swarm_settings_invalid');
      }
    }
    if (variant.command === 'schedule') await refuse('skill-domain', { ...base, options: { ...base.options, skills: 'invalid skill' } }, 'schedule_invalid');
    if (variant.command === 'handoff') await refuse('note-bound', { ...base, options: { ...base.options, note: 'x'.repeat(4097) } }, 'swarm_input_invalid');
    if (variant.command === 'resource') {
      await refuse('action-domain', { ...base, options: { ...base.options, action: 'invalid' } }, 'resource_invalid');
      if (variant.options.action === 'publish') await refuse('note-bound', { ...base, options: { ...base.options, note: 'x'.repeat(4097) } }, 'resource_invalid');
    }
    if (variant.command === 'progress') {
      for (const patch of [{ stage: 'invalid' }, { step: '' }, { revision: 'invalid' }, { evidence: 'x'.repeat(4097) }]) await refuse('witness-domain', { ...base, options: { ...base.options, ...patch } });
    }
  }
  assert.deepEqual([...codes].sort(), ['progress_invalid', 'resource_invalid', 'resource_stale_fence', 'schedule_invalid', 'swarm_input_invalid', 'swarm_private_path', 'swarm_settings_invalid'].sort());
  console.log(JSON.stringify({ registered_commands: registered.length, mutating_commands: Object.keys(counts).length, mutation_variants: variants.length, refused_input_cases: Object.values(counts).reduce((sum, value) => sum + value, 0), refusal_codes: [...codes].sort(), cases_per_command: counts, tracker_changes: 0, partial_receipts: 0 }));
});

test('registered mutators preserve a prepared tracker across state and backend refusal classes', async t => {
  const f = await sharedFixture(t); const sdk = await hostSdk(f.pmRoot);
  const variants = mutationVariants(); const counts: Record<string, number> = {}; const codes = new Set<string>();
  /** Every state case must target an actual registered mutating command. */
  const refuse = async (command: string, id: string | undefined, options: Record<string, unknown>, code?: string, author: string | null = 'shared-test') => {
    assert.ok(variants.some(variant => variant.command === command));
    const ctx: CommandHandlerContext = { command: `swarm ${command}`, args: id === undefined ? [] : [id], options, global: author === null ? {} : { author }, sdk, pm_root: f.pmRoot, source_workspace_root: f.repo };
    await unchanged(f.pmRoot, () => runCommand(command, ctx), `${command}/state-refusal`, (error: unknown) => matchesRefusal(error, code, codes));
    counts[command] = (counts[command] ?? 0) + 1;
  };
  const ordinary = await f.item(['src/ordinary.ts']);
  const terminal = await f.item(['src/terminal.ts']); await f.client.update(terminal, { status: 'canceled', message: 'Fixture terminal' });
  const foreign = await f.item(['src/foreign.ts']); await f.client.claim(foreign, { author: 'peer' });
  const malformed = await f.item(['src/malformed.ts']); await f.client.update(malformed, { field: ['swarm_token=malformed'] });
  const active = await f.item(['src/overlap.ts']); await f.client.claim(active, { author: 'peer' });
  const overlapping = await f.item(['src/overlap.ts']);
  const encoded = encodeURIComponent(['', 'home', 'private', 'work.ts'].join('/'));
  const unsafe = await f.item([encoded]);
  const held = await f.item(['src/held.ts']); const claim = await f.shared.start(held);
  const terminalHeld = await f.item(); await f.client.update(terminalHeld, { status: 'canceled', assignee: 'shared-test', message: 'Fixture terminal owner' });
  const privateContext = await f.item(); await f.client.update(privateContext, { assignee: 'shared-test', title: encoded });
  const resource = (await f.client.create({ type: 'Task', title: 'Resource', tags: 'swarm-resource' })).item.id;
  const invalidResource = (await f.client.create({ type: 'Task', title: 'Invalid resource', tags: 'swarm-resource' })).item.id;
  await f.client.update(invalidResource, { field: ['swarm_token=malformed'] });
  const reservation = await reserveResource(f, resource);
  // The source SDK currently persists a complete-list cache; establish it as fixture state.
  await f.shared.engine.corpus();
  for (const id of [resource, terminal, foreign, malformed, unsafe]) {
    await refuse('start', id, {}, id === unsafe ? 'swarm_private_path' : undefined);
  }
  await refuse('start', overlapping, { strict: true });
  await refuse('start', 'missing-item', {});
  for (const command of ['heartbeat', 'handoff', 'close', 'sync']) {
    const options = { token: '0', ...(command === 'sync' ? { files: 'src/new.ts', apply: true } : command === 'handoff' ? { to: 'receiver', note: 'Public' } : command === 'close' ? { note: 'Public' } : {}) };
    await refuse(command, held, options, 'swarm_stale_fence');
  }
  await refuse('sync', ordinary, { files: 'src/new.ts', apply: true });
  await refuse('sync', resource, { files: 'src/new.ts', apply: true });
  await refuse('handoff', terminalHeld, { to: 'receiver', note: 'Public' });
  await refuse('handoff', privateContext, { to: 'receiver', note: 'Public' }, 'swarm_private_path');
  await f.client.release(privateContext);
  await refuse('resource', resource, { action: 'reserve' }, 'resource_busy');
  await refuse('resource', ordinary, { action: 'reserve' }, 'resource_invalid');
  await refuse('resource', invalidResource, { action: 'reserve' }, 'resource_invalid');
  for (const action of ['renew', 'release', 'publish']) await refuse('resource', resource, { action, token: '0', note: 'Public' }, 'resource_stale_fence');
  const expiry = `Thu, 01 Jan 2099 00:00:00 GMT (${['', 'home', 'private', 'expiry'].join('/')})`;
  assert.ok(Number.isFinite(Date.parse(expiry)));
  await f.client.update(resource, { field: [`swarm_resource_expires_at=${expiry}`] });
  await refuse('resource', resource, { action: 'publish', token: reservation.token, note: 'Public' }, 'swarm_private_path');
  await refuse('land', undefined, { execute: true });

  const { plan, view, progress } = await ownedPlan(f);
  const declaration = { apply: true, stage: 'claimed', step: view.steps[0].id, revision: view.revision, evidence: 'Public evidence' };
  await refuse('progress', ordinary, declaration, 'progress_invalid');
  await refuse('progress', String(plan.id), { ...declaration, step: 'missing-step' }, 'progress_invalid');
  await refuse('progress', String(plan.id), { ...declaration, revision: '0'.repeat(64) }, 'progress_stale');
  await refuse('progress', String(plan.id), { ...declaration, agent: 'peer' }, 'progress_role');
  await refuse('progress', String(plan.id), { ...declaration, stage: 'produced' }, 'progress_prerequisite');
  const previousAuthor = process.env.PM_AUTHOR; delete process.env.PM_AUTHOR;
  try {
    await sdk.mutateWorkspaceSettings({ operationId: 'private-default-author', mutate: current => ({ ...current, author_default: encoded }) });
    f.run('plan', 'update-step', String(plan.id), declaration.step, '--step-owner', encoded);
    const privateView = await progress.view(String(plan.id));
    await refuse('progress', String(plan.id), { ...declaration, revision: privateView.revision }, 'swarm_private_path', null);
  } finally {
    if (previousAuthor === undefined) delete process.env.PM_AUTHOR; else process.env.PM_AUTHOR = previousAuthor;
    await sdk.mutateWorkspaceSettings({ operationId: 'restore-default-author', mutate: current => ({ ...current, author_default: 'shared-test' }) });
    f.run('plan', 'update-step', String(plan.id), declaration.step, '--step-owner', 'shared-test');
  }

  const scope = (await f.client.create({ type: 'Feature', title: 'Scheduling refusal scope' })).item.id;
  const incoming = await f.item(['src/incoming.ts']);
  await f.client.update(incoming, { parent: scope, assignee: 'shared-test', tags: 'skill:rust', field: ['swarm_token=1', 'swarm_handoff={"token":"1"}'] });
  await f.shared.engine.corpus();
  await refuse('schedule', undefined, { parent: scope, skills: 'typescript' }, 'schedule_skills');
  const brokenScope = (await f.client.create({ type: 'Feature', title: 'Broken scheduling scope' })).item.id;
  const broken = await f.item(['src/broken.ts']); await f.client.update(broken, { parent: brokenScope, field: ['swarm_handoff_cost=invalid'] });
  await f.shared.engine.corpus();
  await refuse('schedule', undefined, { parent: brokenScope }, 'schedule_invalid');
  await f.client.release(String(plan.id));
  const nextScope = (await f.client.create({ type: 'Feature', title: 'Next refusal scope' })).item.id;
  await f.client.update(unsafe, { parent: nextScope }); await f.shared.engine.corpus();
  const preview = await f.shared.next(nextScope, true);
  assert.equal(preview.selected, unsafe, JSON.stringify(preview));
  await refuse('next', undefined, { parent: nextScope }, 'swarm_private_path');
  await refuse('schedule', undefined, { parent: nextScope }, 'swarm_private_path');

  declareService(f);
  await refuse('resource', resource, { action: 'renew', token: reservation.token }, 'resource_backend_refused');
  await refuse('schedule', undefined, {}, 'schedule_backend_refused');
  assert.equal((await f.client.get(held)).item.swarm_token, claim.token);
  console.log(JSON.stringify({ state_refusal_cases: Object.values(counts).reduce((sum, value) => sum + value, 0), cases_per_command: counts, refusal_codes: [...codes].sort(), tracker_changes: 0, partial_receipts: 0, complete_list_cache: 'prepared by SDK before state checks' }));
});

/** Reserve through the real backend without substituting SDK reads or writes. */
async function reserveResource(f: Awaited<ReturnType<typeof sharedFixture>>, id: string) {
  return new ResourceReservations(trackerResourceBackend(f.shared.engine), 'shared-test').reserve(id);
}
