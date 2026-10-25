import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getHistoryPath } from '@unbrained/pm-cli/sdk';
import { readFileSync } from 'node:fs';
import { assertPrivatePathSafe, SettingsRefusal } from '../src/settings.ts';
import { runCommand } from '../src/commands.ts';
import { relativePathSamples, pathPresentations } from './privacy-path-samples.ts';
import { fixture } from './helpers.ts';
import { sharedFixture } from './shared-helpers.ts';
import { hostSdk, swarmHost } from './settings-helpers.ts';
import { unchanged } from './privacy-snapshot.ts';

test('path delimiters inside framework routes survive bare prose and Markdown rendering', async () => {
  const host = await swarmHost();
  for (const path of relativePathSamples) for (const value of pathPresentations(path)) {
    assertPrivatePathSafe(value);
    for (const format of ['json', 'toon'] as const) {
      const result = await host.runRendererOverride({ command: 'swarm status', format, result: { lanes: [{ files: [value] }] } });
      assert.equal(result.overridden, true); assert.deepEqual(result.warnings, []);
      assert.doesNotMatch(result.rendered!, /swarm_private_path/);
    }
  }
});

test('real non-Git plan start and status accept whole framework route paths', async t => {
  const f = await sharedFixture(t);
  const ids: string[] = [];
  for (const path of relativePathSamples.slice(0, 6)) ids.push(await f.item([path]));
  const plan = f.run('swarm', 'plan'); assert.equal((plan.suggested_start_set as unknown[]).length > 0, true);
  for (const [index, id] of ids.entries()) {
    const start = f.run('swarm', 'start', id);
    assert.deepEqual(start.files, [relativePathSamples[index]]);
    assert.equal((await f.client.get(id)).item.assignee, 'shared-test');
  }
  const status = f.run('swarm', 'status'); assert.equal((status.lanes as unknown[]).length, ids.length);
});

test('start rejects a private stored receipt before ownership or runtime changes even on a cold tracker', async t => {
  const f = await sharedFixture(t); const sdk = await hostSdk(f.pmRoot);
  const path = encodeURIComponent(['', 'home', 'private', 'work.ts'].join('/'));
  const id = await f.item([path]);
  await unchanged(f.pmRoot, () => runCommand('start', { command: 'swarm start', args: [id], options: {}, global: { author: 'shared-test' }, sdk, pm_root: f.pmRoot, source_workspace_root: f.repo }), 'start/private-stored-receipt');
  assert.equal((await f.client.get(id)).claim_state?.claimed, false);
});


for (const boundary of ['corpus return', 'client read'] as const) {
  test(`start validates a peer-changed receipt at ${boundary} before claiming`, async t => {
    const f = await sharedFixture(t); const id = await f.item(['src/public.ts']);
    const encoded = encodeURIComponent(['', 'home', 'private', 'changed.ts'].join('/'));
    let injected = false; let peerHistory = '';
    /** A real competing SDK transition, never a substituted read result. */
    const peer = async () => {
      injected = true; await f.client.files(id, { add: [encoded] });
      peerHistory = readFileSync(getHistoryPath(f.pmRoot, id), 'utf8');
    };
    if (boundary === 'corpus return') {
      const corpus = f.shared.engine.corpus.bind(f.shared.engine);
      f.shared.engine.corpus = async () => { const result = await corpus(); if (!injected) await peer(); return result; };
    } else {
      const get = f.client.get.bind(f.client);
      f.client.get = async (...args) => { if (args[0] === id && !injected) await peer(); return get(...args); };
    }
    await assert.rejects(f.shared.start(id), SettingsRefusal);
    assert.equal(injected, true); assert.equal(readFileSync(getHistoryPath(f.pmRoot, id), 'utf8'), peerHistory);
    assert.equal((await f.client.get(id)).claim_state?.claimed, false);
  });
}

test('Git start admits stored footprints before ownership or derived tracker writes', async t => {
  const f = await fixture(t);
  const id = await f.item([encodeURIComponent(['', 'home', 'private', 'git.ts'].join('/'))]); f.save();
  await unchanged(f.pmRoot, () => f.swarm.start(id), 'Git/start-private-stored-footprint', error => error instanceof SettingsRefusal);
  assert.equal((await f.client.get(id)).claim_state?.claimed, false);
});

for (const mode of ['shared', 'Git'] as const) {
  test(`${mode} next validates skipped-candidate explanations before claiming safe work`, async t => {
    const f = mode === 'shared' ? await sharedFixture(t) : await fixture(t);
    const encoded = encodeURIComponent(['', 'home', 'private', 'overlap.ts'].join('/'));
    const active = await f.item([encoded]); await f.client.claim(active, { author: 'peer' });
    await f.item([encoded]); const safe = await f.item(['src/safe.ts']);
    const engine = 'shared' in f ? f.shared : f.swarm;
    // Ensure deterministic preference without replacing any SDK read result.
    await f.client.update(safe, { priority: 0 });
    if ('swarm' in f) f.save();
    await ('shared' in f ? f.shared.engine : f.swarm).corpus();
    await unchanged(f.pmRoot, () => engine.next(), `${mode}/next-private-explanation`, error => error instanceof SettingsRefusal);
    assert.equal((await f.client.get(safe)).claim_state?.claimed, false);
  });
}
