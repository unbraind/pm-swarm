import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { getHistoryPath, getItemPath, PmClient } from '@unbrained/pm-cli/sdk';
import { fixture } from './helpers.ts';
import { gitEnvironment } from '../src/git-environment.ts';
import { heartbeatPath } from '../src/lease.ts';
import { withItemMutationObserver, SettingsRefusal } from '../src/settings.ts';
import { snapshot, durableSnapshot } from './privacy-snapshot.ts';
import { historySnapshot } from '../src/inspection.ts';
import { Swarm, withStartTransitionObserver } from '../src/swarm.ts';
import { branchExists } from '../src/git.ts';

/** Make independent native peer mutations without inheriting this request's admission scope. */
function peerCommand(f: Awaited<ReturnType<typeof fixture>>, ...args: string[]): void {
  const result = spawnSync(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), '--path', f.pmRoot, ...args, '--author', 'swarm-test', '--json'], { cwd: f.repo, env: gitEnvironment({ ...process.env, PM_PATH: f.pmRoot, PM_SOURCE_WORKSPACE_ROOT: f.repo, PM_SOURCE_PM_PATH: f.pmRoot, PM_GLOBAL_PATH: join(f.root, 'global-pm') }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

/** Capture the exact native item and append-only history bytes owned by the peer. */
function peerBytes(f: Awaited<ReturnType<typeof fixture>>, id: string): string[] {
  return [getItemPath(f.pmRoot, 'Task', id), getHistoryPath(f.pmRoot, id)].map(path => readFileSync(path, 'utf8'));
}

test('a peer-owned native claim no-op admits its entire fresh document before liveness or Git writes', async t => {
  for (const field of ['title', 'body', 'files']) await t.test(field, async child => {
    const f = await fixture(child); const id = await f.item(); f.save(); const root = join(f.pmRoot, 'runtime/swarm');
    writeFileSync(heartbeatPath(f.pmRoot, 'swarm-test'), '{"heartbeat":"2000-01-01T00:00:00.000Z"}'); const before = snapshot(root);
    const secret = encodeURIComponent(['', 'home', 'private', 'context'].join('/')); let injected = false; let peer: string[] = [];
    await assert.rejects(withItemMutationObserver(boundary => {
      if (boundary !== 'before_commit' || injected) return;
      injected = true; peerCommand(f, 'claim', id);
      if (field === 'files') peerCommand(f, 'files', id, '--add', secret); else peerCommand(f, 'update', id, `--${field}`, secret);
      peer = peerBytes(f, id);
    }, () => f.swarm.start(id)), error => error instanceof SettingsRefusal && ['swarm_private_path', 'swarm_document_changed'].includes(error.code));
    assert.equal(injected, true); assert.deepEqual(peerBytes(f, id), peer);
    assert.equal(snapshot(root), before, 'refused no-op changed heartbeat or lease bytes');
  });
});

test('claim ownership refuses a restored identical document with a different native history head', async t => {
  const f = await fixture(t); const id = await f.item(); f.save();
  const original = await historySnapshot(f.pmRoot, id); let injected = false; let peer: string[] = [];
  const root = join(f.pmRoot, 'runtime/swarm');
  writeFileSync(heartbeatPath(f.pmRoot, 'swarm-test'), '{"heartbeat":"2000-01-01T00:00:00.000Z"}'); const before = snapshot(root);
  await assert.rejects(withItemMutationObserver(boundary => {
    if (boundary !== 'before_commit' || injected) return;
    injected = true; peerCommand(f, 'update', id, '--title', 'Independent public update');
    peerCommand(f, 'restore', id, String(original.version), '--force'); peer = peerBytes(f, id);
  }, () => f.swarm.start(id)), error => error instanceof SettingsRefusal && error.code === 'swarm_superseded' && error.field === 'history');
  assert.equal(injected, true); assert.deepEqual(peerBytes(f, id), peer);
  assert.equal((await f.client.get(id)).item.assignee, undefined);
  assert.equal(snapshot(root), before);
});

test('every Git acquisition path refuses an SDK client without active hooks before native ownership changes', async t => {
  for (const command of ['start', 'next', 'schedule'] as const) for (const owned of command === 'start' ? [false, true] : [false]) await t.test(`${command} owned=${owned}`, async child => {
    const f = await fixture(child); const id = await f.item(); if (owned) await f.client.claim(id); f.save();
    const client = new PmClient({ cwd: f.repo, pmRoot: f.pmRoot, author: 'swarm-test', noExtensions: true });
    writeFileSync(heartbeatPath(f.pmRoot, 'swarm-test'), '{"heartbeat":"2000-01-01T00:00:00.000Z"}');
    const engine = new Swarm(f.repo, f.pmRoot, client, 'swarm-test'); const before = durableSnapshot(f.pmRoot);
    await assert.rejects(command === 'start' ? engine.start(id) : command === 'next' ? engine.next() : engine.schedule({ skills: [] }), error => error instanceof SettingsRefusal && error.code === 'swarm_sdk_mismatch');
    assert.equal(durableSnapshot(f.pmRoot), before, 'inactive SDK changed durable tracker, history or liveness');
    assert.equal(branchExists(f.repo, `swarm/${id}`), false);
    assert.equal((await f.client.get(id)).item.assignee, owned ? 'swarm-test' : undefined);
  });
});

test('a public peer edit after native claim is refused before liveness and survives owned rollback', async t => {
  for (const field of ['title', 'body', 'files'] as const) await t.test(field, async child => {
    const f = await fixture(child); const id = await f.item(); f.save(); let injected = false;
    const heartbeat = heartbeatPath(f.pmRoot, 'swarm-test'); writeFileSync(heartbeat, '{"heartbeat":"2000-01-01T00:00:00.000Z"}'); const before = snapshot(join(f.pmRoot, 'runtime/swarm'));
    const value = field === 'files' ? 'src/public-peer.ts' : `Public peer ${field}`;
    await assert.rejects(withStartTransitionObserver(async transition => {
      if (transition !== 'claimed') return;
      injected = true;
      if (field === 'files') await f.client.files(id, { add: [value] }); else await f.client.update(id, { [field]: value });
    }, () => f.swarm.start(id)), error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed');
    assert.equal(injected, true); const item = (await f.client.get(id, { depth: 'full' })).item;
    if (field === 'files') assert.ok(JSON.stringify(item.files).includes(value)); else assert.equal(item[field], value);
    assert.equal(item.assignee, undefined); assert.equal(branchExists(f.repo, `swarm/${id}`), false);
    assert.equal(snapshot(join(f.pmRoot, 'runtime/swarm')), before, 'refused post-claim peer edit renewed liveness');
  });
});
