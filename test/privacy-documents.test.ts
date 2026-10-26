import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { getHistoryPath } from '@unbrained/pm-cli/sdk';
import { commitItemMutation, SettingsRefusal, updateSettings } from '../src/settings.ts';
import { ResourceReservations } from '../src/resources.ts';
import { trackerResourceBackend } from '../src/resource-tracker.ts';
import { sharedFixture } from './shared-helpers.ts';
import { hostSdk, swarmHost } from './settings-helpers.ts';
import { ownedPlan } from './privacy-mutations.ts';
import { durableSnapshot } from './privacy-snapshot.ts';

/** All core field/link families are written through real SDK operations when preparing foreign test data. */
const FIELDS = ['title', 'description', 'body', 'acceptance_criteria', 'comments', 'notes', 'files', 'docs', 'tests', 'swarm_preferred_agent'] as const;

/** Seed one private value without invoking the package guard scope, as an independent core writer would. */
async function seed(f: Awaited<ReturnType<typeof sharedFixture>>, id: string, field: typeof FIELDS[number], value: string) {
  switch (field) {
    case 'comments': await f.client.comments(id, { add: value }); break;
    case 'notes': await f.client.notes(id, { add: value }); break;
    case 'files': await f.client.files(id, { add: [value] }); break;
    case 'docs': await f.client.docs(id, { add: [value] }); break;
    case 'tests': await f.client.run('test', { id, options: { add: [`command=${value}`] } }); break;
    case 'acceptance_criteria': await f.client.update(id, { acceptanceCriteria: value }); break;
    case 'swarm_preferred_agent': await f.client.update(id, { field: [`${field}=${value}`] }); break;
    default: await f.client.update(id, { [field]: value });
  }
}

test('whole-document admission refuses every resource action and item writer until all existing private fields are repaired', async t => {
  const f = await sharedFixture(t); const resources = new ResourceReservations(trackerResourceBackend(f.shared.engine), 'shared-test');
  const privateValue = encodeURIComponent(['', 'home', 'private', 'resource'].join('/'));
  const actions = ['reserve', 'renew', 'publish', 'release', 'start', 'handoff', 'sync', 'close', 'progress'] as const;
  let refused = 0;
  for (const field of FIELDS) for (const action of actions) {
    const resource = ['reserve', 'renew', 'publish', 'release'].includes(action);
    const planned = action === 'progress' ? await ownedPlan(f) : undefined;
    const id = planned !== undefined ? String(planned.plan.id) : resource ? (await f.client.create({ type: 'Task', title: 'Shared resource', tags: 'swarm-resource' })).item.id : await f.item([`src/${field}-${action}.ts`]);
    const token = resource ? action === 'reserve' ? '0' : (await resources.reserve(id)).token : ['start', 'progress'].includes(action) ? '0' : (await f.shared.start(id)).token;
    await seed(f, id, field, privateValue);
    // The baseline includes legitimate peer writes and SDK reads; no package record may change.
    await f.client.get(id, { depth: 'full' });
    const revision = planned === undefined ? undefined : (await planned.progress.view(id)).revision;
    const before = durableSnapshot(f.pmRoot); let returned = false;
    await assert.rejects(async () => {
      switch (action) {
        case 'reserve': await resources.reserve(id); break;
        case 'renew': await resources.renew(id, token); break;
        case 'publish': await resources.publish(id, token, 'Public receipt'); break;
        case 'release': await resources.release(id, token); break;
        case 'start': await f.shared.start(id); break;
        case 'handoff': await f.shared.handoff(id, 'receiver', 'Public handoff', token); break;
        case 'sync': await f.shared.sync(id, true, ['src/added.ts'], token); break;
        case 'close': await f.shared.close(id, 'Public completion', token); break;
        case 'progress': await planned!.progress.witness(id, { stage: 'claimed', step: planned!.view.steps[0].id, revision: revision!, evidence: 'Public evidence', apply: true }); break;
      }
      returned = true;
    }, (error: unknown) => {
      assert.ok(error instanceof SettingsRefusal); assert.equal(error.code, 'swarm_private_path');
      assert.ok(error.field?.includes(field), `Missing field name for ${action}/${field}`);
      assert.match(error.remedy, /project-relative/); assert.equal(String(error).includes(privateValue), false);
      return true;
    }, `${action}/${field}`);
    assert.equal(returned, false); assert.equal(durableSnapshot(f.pmRoot), before, `${action}/${field}: durable state changed`); refused++;
  }
  const id = (await f.client.create({ type: 'Task', title: privateValue, tags: 'swarm-resource' })).item.id;
  await assert.rejects(resources.reserve(id), SettingsRefusal);
  await f.client.update(id, { title: 'Repaired resource' });
  const receipt = await resources.reserve(id); assert.equal(receipt.token, '1'); assert.equal(receipt.owner, 'shared-test');
  const cliId = (await f.client.create({ type: 'Task', title: privateValue, tags: 'swarm-resource' })).item.id;
  const result = f.cli('swarm', 'resource', cliId, '--action', 'reserve', '--json');
  assert.equal(result.status, 2); const diagnostics = result.stdout + result.stderr;
  assert.match(diagnostics, /swarm_private_path/); assert.match(diagnostics, /document\.title/); assert.equal(diagnostics.includes(privateValue), false);
  console.log(JSON.stringify({ existing_fields: FIELDS.length, mutating_actions: actions.length, whole_document_refusals: refused, durable_changes: 0, partial_receipts: 0, repaired_successor_token: receipt.token }));
});

test('the native SDK guard rechecks peer-modified documents across writers on one non-Git tracker', async t => {
  const f = await sharedFixture(t);
  for (const writer of ['update', 'files', 'comments', 'claim', 'release'] as const) for (const field of ['title', 'body', 'comments'] as const) await t.test(`the native SDK guard rechecks peer-modified ${field} during ${writer} under the item lock`, async () => {
    const id = await f.item(['src/public.ts']);
    if (writer === 'release') await f.client.claim(id);
    const item = (await f.client.get(id, { depth: 'full' })).item;
    const value = encodeURIComponent(['', 'home', 'private', 'peer-document'].join('/')); let peerHistory = '';
    await assert.rejects(commitItemMutation({ id, item, options: { author: 'shared-test' }, note: 'Public update', files: ['src/added.ts'] }, async admitted => {
      const args = field === 'comments' ? [f.host, 'comment', id, value, '--json'] : [f.host, 'update', id, `--${field}`, value, '--json'];
      const peer = spawnSync(process.execPath, args, { cwd: f.repo, encoding: 'utf8', env: { ...f.env, PATH: process.env.PATH } });
      assert.equal(peer.status, 0, 'Independent core writer failed');
      peerHistory = readFileSync(getHistoryPath(f.pmRoot, id), 'utf8');
      switch (writer) {
        case 'update': await f.client.update(admitted.id, { ...admitted.options, description: admitted.note }); break;
        case 'files': await f.client.files(admitted.id, { ...admitted.options, add: admitted.files }); break;
        case 'comments': await f.client.comments(admitted.id, { ...admitted.options, add: admitted.note }); break;
        case 'claim': await f.client.claim(admitted.id, admitted.options); break;
        case 'release': await f.client.release(admitted.id, admitted.options); break;
      }
    }), (error: unknown) => {
      assert.ok(error instanceof SettingsRefusal);
      assert.equal(error.code, 'swarm_private_path'); assert.ok(error.field?.includes(field)); return true;
    });
    assert.equal(readFileSync(getHistoryPath(f.pmRoot, id), 'utf8'), peerHistory, 'The guard must preserve the peer success without a second mutation');
    const after = (await f.client.get(id, { depth: 'full' })).item;
    if (field === 'comments') assert.equal(after.comments!.at(-1)!.text, value); else assert.equal(after[field], value);
  });
});

for (const target of ['swarm', 'foreign', 'output'] as const) test(`settings admit complete ${target} source fields before audited persistence`, async t => {
  const f = await sharedFixture(t); const sdk = await hostSdk(f.pmRoot); const value = encodeURIComponent(['', 'home', 'private', 'settings'].join('/'));
  await sdk.mutateWorkspaceSettings({ operationId: 'prepare-foreign-document', replaceSubtrees: [target === 'output' ? 'output.foreign' : target], mutate: current => ({
    ...current,
    ...(target === 'swarm' ? { swarm: { nested: { title: value } } } : target === 'foreign' ? { foreign: { title: value } } : { output: { ...current.output, foreign: { title: value } } }),
  }) });
  const before = durableSnapshot(f.pmRoot);
  const field = target === 'swarm' ? 'settings.swarm.nested.title' : target === 'foreign' ? 'settings.foreign.title' : 'settings.output.foreign.title';
  await assert.rejects(updateSettings(sdk, f.pmRoot, { lane_limit: 3 }, { apply: true }), (error: unknown) => {
    assert.ok(error instanceof SettingsRefusal); assert.equal(error.field, field); return true;
  });
  assert.equal(durableSnapshot(f.pmRoot), before);
});

test('native whole-document scope allows deletion and explicit core repairs without leaking into later requests', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const item = (await f.client.get(id, { depth: 'full' })).item;
  await commitItemMutation({ id, item, options: { force: true } }, admitted => f.client.delete(admitted.id, admitted.options));
  const other = await f.item(); const value = encodeURIComponent(['', 'home', 'private', 'core-only'].join('/'));
  await f.client.update(other, { title: value }); await f.client.update(other, { title: 'Explicitly repaired' });
  assert.equal((await f.client.get(other)).item.title, 'Explicitly repaired');
  const host = await swarmHost(); assert.equal(host.activation.hook_counts.before_mutation, 1);
});

test('item sinks refuse missing snapshots and opaque private keys without echoing them', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const value = ['$HOME', 'private'].join('/');
  assert.throws(() => commitItemMutation({ id, item: null as unknown as Record<string, unknown>, options: {} }, async () => undefined), error => error instanceof SettingsRefusal && error.code === 'swarm_input_invalid');
  assert.throws(() => commitItemMutation({ id, item: { [value]: 'Public' }, options: {} }, async () => undefined), error => error instanceof SettingsRefusal && error.field === 'document.[foreign-key]' && !String(error).includes(value));
  for (const missing of [undefined, 'partial', []]) assert.throws(() => commitItemMutation({ id, item: missing as unknown as Record<string, unknown>, options: {} }, async () => undefined), error => error instanceof SettingsRefusal && error.code === 'swarm_input_invalid');
  const item = (await f.client.get(id)).item;
  await assert.rejects(commitItemMutation({ id, item, options: {} }, async () => { throw new Error('Refused backend'); }), /Refused backend/);
});
