import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ITEM_MUTATION_BOUNDARIES, assertSdkInstance, SettingsRefusal, withItemMutationObserver, commitItemMutation } from '../src/settings.ts';
import { PlanProgress } from '../src/progress.ts';
import { sharedFixture } from './shared-helpers.ts';
import { hostSdk } from './settings-helpers.ts';
import { snapshot, durableSnapshot } from './privacy-snapshot.ts';
import { ownedPlan } from './privacy-mutations.ts';

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

test('installed package copies preserve every after-preflight peer transition with one SDK or refuse a distinct SDK', { timeout: 240000 }, async t => {
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
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./privacy-sdk-worker.ts', import.meta.url)), JSON.stringify({ cwd: f.repo, pmRoot: f.pmRoot, host: f.host, id, layout, boundary, private: privateValue })], { cwd: f.repo, encoding: 'utf8', env: f.env, timeout: 30000 });
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
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {assertSdkInstance} from ${JSON.stringify(module)}; import {assertSdkInstance as second} from ${JSON.stringify(module + '?second-package-copy')}; assertSdkInstance(); second(); process.stdout.write('one-sdk');`], { encoding: 'utf8', env: f.env });
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
  await assert.rejects(commitItemMutation({ id, item, options: { description: 'Our stale update' } }, admitted => f.client.update(admitted.id, admitted.options)), error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed');
  assert.equal(durableSnapshot(f.pmRoot), before);
  await assert.rejects(commitItemMutation({ id, item: (await f.client.get(id, { depth: 'full' })).item, options: { type: 'Task', title: 'Unexpected create' } }, admitted => f.client.create(admitted.options)), error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed');
  assert.equal(durableSnapshot(f.pmRoot), before);
});

test('metadata-only admission cannot overwrite an unobserved nonempty item body', async t => {
  const f = await sharedFixture(t); const id = await f.item(); await f.client.update(id, { body: 'Public body that must survive' });
  const { body: _body, ...metadata } = (await f.client.get(id, { depth: 'full' })).item;
  const before = durableSnapshot(f.pmRoot);
  await assert.rejects(commitItemMutation({ id, item: metadata, options: { description: 'Unobserved update' } }, admitted => f.client.update(admitted.id, admitted.options)), error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed');
  assert.equal(durableSnapshot(f.pmRoot), before);
});

for (const transitions of [1, 8]) test(`progress re-evaluates native conflicts after ${transitions} independent peer appends`, async t => {
  const f = await sharedFixture(t); const plan = await ownedPlan(f); const id = String(plan.plan.id); let peers = 0;
  const operation = () => withItemMutationObserver(boundary => {
    if (boundary !== 'before_commit' || peers >= transitions) return;
    const peer = f.cli('comment', id, `Public peer ${peers}`, '--json'); assert.equal(peer.status, 0); peers++;
  }, () => plan.progress.witness(id, { stage: 'claimed', step: plan.view.steps[0].id, revision: plan.view.revision, evidence: 'Public evidence', apply: true }));
  if (transitions === 1) assert.equal((await operation()).dry_run, false);
  else await assert.rejects(operation(), error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed');
  assert.equal(peers, transitions);
  const comments = (await f.client.get(id, { depth: 'full' })).item.comments!;
  assert.equal(comments.filter(comment => comment.text.startsWith('Public peer ')).length, transitions);
  assert.equal(comments.filter(comment => comment.text.startsWith('swarm-progress/v2 ')).length, transitions === 1 ? 1 : 0);
});
