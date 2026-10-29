import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readItemHistoryHead, ITEM_MUTATION_BOUNDARIES, assertSdkInstance, SettingsRefusal, withItemMutationObserver, commitItemMutation } from '../src/settings.ts';
import { PlanProgress } from '../src/progress.ts';
import { sharedFixture } from './shared-helpers.ts';
import { hostSdk } from './settings-helpers.ts';
import { snapshot, durableSnapshot } from './privacy-snapshot.ts';
import { ownedPlan } from './privacy-mutations.ts';
import { getHistoryPath } from '@unbrained/pm-cli/sdk';
import { requireItemRead } from '../src/inspection.ts';

/** Install real package/SDK files without network access; a physical SDK copy has its own module identity. */
function installed(root: string, separate: boolean): string {
  const packageRoot = join(root, separate ? 'separate' : 'shared'); mkdirSync(packageRoot, { recursive: true });
  cpSync(new URL('../dist', import.meta.url), join(packageRoot, 'dist'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'pm-swarm', type: 'module' }));
  const sdkRoot = fileURLToPath(new URL('../../', import.meta.resolve('@unbrained/pm-cli/sdk')));
  const target = join(packageRoot, 'node_modules/@unbrained/pm-cli'); mkdirSync(join(packageRoot, 'node_modules/@unbrained'), { recursive: true });
  if (separate) {
    cpSync(sdkRoot, target, { recursive: true, filter: source => !source.slice(sdkRoot.length).split('/').includes('node_modules') });
    const dependencies = fileURLToPath(new URL('../node_modules', import.meta.url));
    symlinkSync(existsSync(join(sdkRoot, 'node_modules')) ? join(sdkRoot, 'node_modules') : dependencies, join(target, 'node_modules'), 'dir');
    for (const entry of readdirSync(dependencies)) {
      if (entry === '@unbrained' || entry === '.bin') continue;
      symlinkSync(join(dependencies, entry), join(packageRoot, 'node_modules', entry));
    }
  } else symlinkSync(sdkRoot, target, 'dir');
  return pathToFileURL(join(packageRoot, 'dist/index.js')).href;
}

test('installed package copies preserve every after-preflight peer transition with one SDK or refuse a distinct SDK', { timeout: 600000 }, async t => {
  const f = await sharedFixture(t); const extension = join(f.pmRoot, 'extensions/pm-swarm');
  const manifest = readFileSync(join(extension, 'manifest.json'), 'utf8');
  for (const layout of ['shared', 'separate'] as const) writeFileSync(join(extension, `${layout}-entry.js`), `export {default} from ${JSON.stringify(installed(join(f.repo, 'installed'), layout === 'separate'))};\n`);
  assert.deepEqual(ITEM_MUTATION_BOUNDARIES, ['admitted', 'scoped', 'before_commit']);
  const boundaries = ['corpus-return', 'snapshot-return', ...ITEM_MUTATION_BOUNDARIES, 'writer-entry'];
  let cases = 0;
  for (const layout of ['shared', 'separate'] as const) for (const boundary of boundaries) for (const privateValue of [true, false]) {
    if (!privateValue && boundary === 'corpus-return') continue;
    writeFileSync(join(extension, 'manifest.json'), manifest);
    const id = await f.item(['src/public.ts']); await f.client.get(id, { depth: 'full' });
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./privacy-sdk-worker.ts', import.meta.url)), JSON.stringify({ cwd: f.repo, pmRoot: f.pmRoot, host: f.host, id, layout, boundary, private: privateValue })], { cwd: f.repo, encoding: 'utf8', env: f.env, timeout: 90000 });
    assert.equal(child.status, 0, `Installed ${layout}, ${boundary}, private ${privateValue}: ${child.stderr.replaceAll(f.repo, '[fixture]')}`);
    assert.deepEqual(JSON.parse(child.stdout), { injected: 1, tracker_changes_by_package: 0, partial_receipts: 0, peer_history_preserved: true }); cases++;
  }
  writeFileSync(join(extension, 'manifest.json'), manifest);
  const control = await f.item(['src/control.ts']);
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ ...JSON.parse(manifest), entry: 'shared-entry.js' }));
  assert.equal(f.run('swarm', 'start', control).token, '1');
  const refused = await f.item(['src/refused.ts']); await f.client.get(refused, { depth: 'full' });
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ ...JSON.parse(manifest), entry: 'separate-entry.js' }));
  const before = snapshot(f.pmRoot);
  const result = f.cli('swarm', 'start', refused, '--json');
  assert.equal(result.status, 2); assert.match(result.stdout + result.stderr, /swarm_sdk_mismatch/);
  assert.equal(snapshot(f.pmRoot), before, 'Different-SDK command startup cannot change the tracker');
  writeFileSync(join(extension, 'manifest.json'), manifest);
  console.log(JSON.stringify({ trackers: 1, git: false, layouts: 2, boundaries: boundaries.length, private_cases: 12, benign_stale_cases: 10, interleavings: cases, shared_sdk_successes: 1, separate_sdk_startup_refusals: 1, lost_peer_transitions: 0, partial_receipts: 0 }));
});

test('host binding rejects foreign SDK clients and progress reuses the exact native context client', async t => {
  const f = await sharedFixture(t); const sdk = await hostSdk(f.pmRoot);
  assertSdkInstance(sdk.client);
  assert.throws(() => assertSdkInstance({}), error => error instanceof SettingsRefusal && error.code === 'swarm_sdk_mismatch');
  assert.equal(new PlanProgress({ cwd: f.repo, pmRoot: f.pmRoot }, sdk.client).client, sdk.client);
  const module = new URL('../src/settings.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--import', new URL('../dist/src/settings.js', import.meta.url).href, '--input-type=module', '-e', `import {assertSdkInstance} from ${JSON.stringify(module)}; assertSdkInstance(); process.stdout.write('one-sdk');`], { encoding: 'utf8', env: f.env });
  assert.equal(child.status, 0, child.stderr.replaceAll(f.repo, '[fixture]')); assert.equal(child.stdout, 'one-sdk');
});

test('interruption at every item admission boundary writes nothing and a rerun converges once', async t => {
  const f = await sharedFixture(t);
  for (const boundary of ITEM_MUTATION_BOUNDARIES) {
    const id = await f.item(['src/public.ts']); await f.client.get(id, { depth: 'full' });
    const before = durableSnapshot(f.pmRoot);
    await assert.rejects(withItemMutationObserver(step => { if (step === boundary) throw new Error('Injected interruption'); }, () => f.shared.start(id)), /Injected interruption/);
    assert.equal(durableSnapshot(f.pmRoot), before);
    assert.equal((await f.shared.start(id)).token, '1');
  }
});

test('the locked comparison rejects benign title edits without replacing the peer success', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const item = (await f.client.get(id, { depth: 'full' })).item;
  await f.client.update(id, { title: 'Peer success' }); const before = durableSnapshot(f.pmRoot);
  await assert.rejects(commitItemMutation({ id, item, options: { description: 'Our stale update' } }, admitted => f.client.update(admitted.id, admitted.options), { history: await readItemHistoryHead(f.pmRoot, id) }), documentChange);
  assert.equal(durableSnapshot(f.pmRoot), before);
  await assert.rejects(commitItemMutation({ id, item: (await f.client.get(id, { depth: 'full' })).item, options: { type: 'Task', title: 'Unexpected create' } }, admitted => f.client.create(admitted.options), { history: await readItemHistoryHead(f.pmRoot, id) }), documentChange);
  assert.equal(durableSnapshot(f.pmRoot), before);
});

test('metadata-only admission cannot overwrite an unobserved nonempty item body', async t => {
  const f = await sharedFixture(t); const id = await f.item(); await f.client.update(id, { body: 'Public body that must survive' });
  const { body: _body, ...metadata } = (await f.client.get(id, { depth: 'full' })).item;
  const before = durableSnapshot(f.pmRoot); const history = await readItemHistoryHead(f.pmRoot, id);
  await assert.rejects(commitItemMutation({ id, item: metadata, options: { description: 'Unobserved update' } }, admitted => f.client.update(admitted.id, admitted.options), { history }), documentChange);
  assert.equal(durableSnapshot(f.pmRoot), before);
});

test('mutation comparisons retain large public bodies and annotations beyond agent output budgets', async t => {
  const f = await sharedFixture(t); const id = await f.item(['src/public.ts']);
  const body = 'Public complete document '.repeat(2000); const comment = 'Public full annotation '.repeat(500);
  await f.client.update(id, { body }); await f.client.comments(id, { add: comment });
  const output = { depth: 'full', outputBudget: 'unbounded', outputLimit: 'unbounded' } as const;
  const before = requireItemRead(await f.client.get(id, output)).item;
  assert.ok(before.body!.length > 40000); assert.ok(before.comments![0].text.length > 10000);
  const start = await f.shared.start(id); await f.shared.close(id, 'Public completion', start.token);
  const item = requireItemRead(await f.client.get(id, output)).item;
  assert.equal(item.body, before.body); assert.equal(item.comments![0].text, before.comments![0].text); assert.equal(item.status, 'closed');
  const refused = await f.client.get(id, { depth: 'full', outputBudget: 1, outputLimit: 'unbounded' });
  assert.throws(() => requireItemRead(refused), error => error instanceof SettingsRefusal && error.code === 'swarm_input_invalid');
});

for (const transitions of [1, 8]) test(`progress re-evaluates native conflicts after ${transitions} independent peer appends`, async t => {
  const f = await sharedFixture(t); const plan = await ownedPlan(f); const id = String(plan.plan.id); let peers = 0;
  const operation = () => withItemMutationObserver(boundary => {
    if (boundary !== 'before_commit' || peers >= transitions) return;
    const peer = f.cli('comment', id, `Public peer ${peers}`, '--json'); assert.equal(peer.status, 0); peers++;
  }, () => plan.progress.witness(id, { stage: 'claimed', step: plan.view.steps[0].id, revision: plan.view.revision, evidence: 'Public evidence', apply: true }));
  if (transitions === 1) assert.equal((await operation()).dry_run, false);
  else await assert.rejects(operation(), error => error instanceof SettingsRefusal && error.code === 'swarm_superseded' && error.field === 'history');
  assert.equal(peers, transitions);
  const comments = (await f.client.get(id, { depth: 'full' })).item.comments!;
  assert.equal(comments.filter(comment => comment.text.startsWith('Public peer ')).length, transitions);
  assert.equal(comments.filter(comment => comment.text.startsWith('swarm-progress/v2 ')).length, transitions === 1 ? 1 : 0);
});

test('native close advances only its exact committed successor and ignores unrelated write notifications', async t => {
  const f = await sharedFixture(t); const events: string[] = []; const key = Symbol.for('pm-swarm.test.native-steps');
  Reflect.set(globalThis, key, events); t.after(() => { Reflect.deleteProperty(globalThis, key); });
  const entry = `import extension from ${JSON.stringify(new URL('../index.ts', import.meta.url).href)};
import {recordItemCommit} from ${JSON.stringify(new URL('../src/settings.ts', import.meta.url).href)};
export default {activate(api){api.hooks.onWrite(context=>{
if(context.before && context.after){
recordItemCommit({...context,before:undefined}); recordItemCommit({...context,after:undefined});
recordItemCommit({...context,before:{...context.before,metadata:{...context.before.metadata,title:'Unrelated public before'}}});
recordItemCommit({...context,after:{...context.after,metadata:{...context.after.metadata,title:'Unrelated public after'}}});
}
if(['update','close'].includes(context.op)) globalThis[Symbol.for('pm-swarm.test.native-steps')]?.push(context.op);
});extension.activate(api);}};`;
  writeFileSync(join(f.pmRoot, 'extensions/pm-swarm/entry.js'), entry);
  const id = await f.item(['src/public.ts']); const receipt = await f.shared.start(id); events.length = 0;
  await f.shared.close(id, 'Public completion', receipt.token);
  assert.deepEqual(events, ['close'], 'Swarm delegates exactly one primary native close');
  const item = (await f.client.get(id, { depth: 'full' })).item;
  assert.equal(item.status, 'closed'); assert.equal(item.assignee, undefined); assert.equal(item.swarm_token, receipt.token);
});

test('compound native writes preserve later peer state and truthfully report an already committed prefix', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const item = (await f.client.get(id, { depth: 'full' })).item;
  const privateTitle = encodeURIComponent(['', 'home', 'private', 'later-peer'].join('/')); let peerHistory = '';
  await assert.rejects(commitItemMutation({ id, item, options: { add: 'Public first step' } }, async admitted => {
    await f.client.comments(admitted.id, admitted.options);
    const peer = f.cli('update', id, '--title', privateTitle, '--json'); assert.equal(peer.status, 0);
    peerHistory = readFileSync(getHistoryPath(f.pmRoot, id), 'utf8');
    await f.client.update(admitted.id, { description: 'Refused successor' });
  }, { history: await readItemHistoryHead(f.pmRoot, id) }), error => error instanceof SettingsRefusal && error.code === 'swarm_partial_commit' && /1 native item mutation/.test(error.remedy) && !error.remedy.includes(privateTitle));
  assert.equal(readFileSync(getHistoryPath(f.pmRoot, id), 'utf8'), peerHistory);
  const other = await f.item(); const current = (await f.client.get(other, { depth: 'full' })).item;
  await assert.rejects(commitItemMutation({ id: other, item: current, options: { add: 'Public committed step' } }, async admitted => {
    await f.client.comments(admitted.id, admitted.options); throw new Error('Interrupted after commit');
  }, { history: await readItemHistoryHead(f.pmRoot, other) }), error => error instanceof SettingsRefusal && error.code === 'swarm_partial_commit' && /SDK refused a later step/.test(error.remedy));
  assert.equal((await f.client.get(other, { depth: 'full' })).item.comments!.length, 1);
});

/** Preserve the existing exact refusal assertions when supplying the mandatory history coordinate. */
function documentChange(error: unknown): boolean { return error instanceof SettingsRefusal && error.code === 'swarm_document_changed'; }
