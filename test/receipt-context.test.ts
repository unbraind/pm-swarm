import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { getHistoryPath } from '@unbrained/pm-cli/sdk';
import { assertMutationReceipt, SettingsRefusal } from '../src/settings.ts';
import { historySnapshot } from '../src/inspection.ts';
import { ResourceReservations, trackerResourceBackend } from '../index.ts';
import { PlanProgress } from '../src/progress.ts';
import { sharedFixture } from './shared-helpers.ts';
import { peerBytes } from './history-aba-helpers.ts';

/** Change a real extension's declared storage context without replacing any SDK operation. */
function serviceContext(pmRoot: string): void {
  const path = join(pmRoot, 'extensions/pm-swarm/manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { capabilities: string[] };
  manifest.capabilities.push('services'); writeFileSync(path, JSON.stringify(manifest));
}

test('all native receipt equality checks share SDK comparison and a content-free refusal', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const before = await historySnapshot(f.pmRoot, id);
  await f.client.update(id, { title: 'Independent native receipt' }); const after = await historySnapshot(f.pmRoot, id);
  for (const [left, right] of [[before.historyHead.hash, after.historyHead.hash], [before.document, after.document]]) {
    assertMutationReceipt(left, left, 'Refresh the native receipt.');
    assert.throws(() => assertMutationReceipt(left, right, 'Refresh the native receipt.'), error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed' && error.message === 'swarm_document_changed: Refresh the native receipt.');
  }
  assertMutationReceipt({ token: '1', expiry: undefined }, { expiry: undefined, token: '1' }, 'Refresh native fields.');
});

test('resource admission refuses a storage-context switch between native head and document reads', async t => {
  const f = await sharedFixture(t); const id = (await f.client.create({ type: 'Task', title: 'Public admission resource', tags: 'swarm-resource' })).item.id;
  const original = peerBytes(f.pmRoot, id); const history = getHistoryPath(f.pmRoot, id); let switched = false;
  const read = fs.readFile; const hook = t.mock.method(fs, 'readFile', new Proxy(read, { async apply(target, receiver, args: unknown[]) {
    const value: unknown = await Reflect.apply(target, receiver, args);
    if (!switched && String(args[0]) === history) { switched = true; serviceContext(f.pmRoot); }
    return value;
  } })); syncBuiltinESMExports();
  try { await assert.rejects(new ResourceReservations(trackerResourceBackend(f.shared.engine), 'shared-test').reserve(id), { code: 'resource_backend_refused' }); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(switched, true); assert.deepEqual(peerBytes(f.pmRoot, id), original);
});

test('Plan witnesses retain bound SDK reads when local inspection yields to a service context', async t => {
  const f = await sharedFixture(t); const plan = await f.client.plan('create', undefined, { title: 'Public service Plan', step: ['Verify native context'] });
  const id = plan.plan.id; const item = (await f.client.get(id, { depth: 'full' })).item; const step = item.plan_steps![0].id;
  await f.client.plan('update-step', id, { stepOwner: 'shared-test' }, step);
  serviceContext(f.pmRoot); const progress = new PlanProgress({ cwd: f.repo, pmRoot: f.pmRoot, author: 'shared-test' });
  const view = await progress.view(id);
  const result = await progress.witness(id, { step, revision: view.revision, stage: 'claimed', evidence: 'Public SDK context checked', apply: true });
  assert.equal(result.actor, 'shared-test'); assert.equal(result.dry_run, false);
  assert.equal((await progress.view(id)).counts.claimed, 1);
});
