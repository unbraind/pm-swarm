import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, promises as filesystem, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { getHistoryPath, locateItem } from '@unbrained/pm-cli/sdk';
import { inspectItem } from '../src/inspection.ts';
import { PlanProgress } from '../src/progress.ts';
import { assertPrivatePathSafe, SettingsRefusal } from '../src/settings.ts';
import { sharedFixture } from './shared-helpers.ts';
import { ownedPlan, declareService } from './privacy-mutations.ts';
import { trackerResourceBackend } from '../src/resource-tracker.ts';

test('service declarations defer metadata reads to the bound client without using a local shadow', async t => {
  const f = await sharedFixture(t); const id = await f.item(['src/provider.ts']);
  const { plan } = await ownedPlan(f); declareService(f);
  assert.equal(await inspectItem(f.pmRoot, f.repo, id), null);
  const started = f.run('swarm', 'start', id); assert.equal(started.id, id);
  const sync = f.run('swarm', 'sync', id, '--files', 'src/linked.ts', '--apply', '--token', String(started.token)); assert.deepEqual(sync.add, ['src/linked.ts']);
  f.run('swarm', 'heartbeat', id, '--token', String(started.token));
  const view = await new PlanProgress({ cwd: f.repo, pmRoot: f.pmRoot, author: 'shared-test' }, true).view(String(plan.id));
  assert.equal(view.id, plan.id);
  f.run('swarm', 'handoff', id, '--token', String(started.token), '--to', 'receiver', '--note', 'Public provider-owned context');
  assert.equal((await f.client.get(id)).item.assignee, 'receiver');
  const manifest = join(f.pmRoot, 'extensions/refusal-storage/manifest.json');
  for (const declaration of [{}, { capabilities: [] }]) {
    writeFileSync(manifest, JSON.stringify({ name: 'refusal-storage', version: '1.0.0', entry: 'entry.js', ...declaration }));
    assert.equal(await inspectItem(f.pmRoot, f.repo, id), null, 'Unspecified capabilities cannot certify a local-only read');
  }
});

test('reclaim skips unsafe foreign context and truthfully retains other completed transfers', async t => {
  const f = await sharedFixture(t); const safe = await f.item(['src/safe.ts'], 0); const foreign = await f.item(['src/foreign.ts']); const malformed = await f.item(['../foreign.ts'], 3);
  const encoded = encodeURIComponent(['', 'home', 'private', 'foreign'].join('/'));
  for (const id of [safe, foreign, malformed]) await f.client.update(id, { assignee: 'absent-worker', field: ['swarm_token=1', 'swarm_claimed_at=2000-01-01T00:00:00.000Z'], ...(id === foreign ? { title: encoded } : {}) });
  const located = await locateItem(f.pmRoot, foreign); assert.ok(located);
  const history = getHistoryPath(f.pmRoot, foreign);
  const itemBefore = readFileSync(located.itemPath, 'utf8'); const historyBefore = readFileSync(history, 'utf8');
  assert.equal((await f.shared.engine.corpus()).items.filter(item => [safe, foreign, malformed].includes(item.id))[0].id, safe);
  const result = await f.shared.reclaim(60, 'receiver');
  assert.deepEqual(result.recovered.map(row => row.id), [safe]);
  assert.deepEqual(result.refused.map(row => row.id).sort(), [foreign, malformed].sort());
  assert.match(result.refused[0].reason, /Unsafe foreign context/); assertPrivatePathSafe(result);
  assert.equal(readFileSync(located.itemPath, 'utf8'), itemBefore); assert.equal(readFileSync(history, 'utf8'), historyBefore);
  assert.equal((await f.client.get(safe)).item.assignee, 'receiver');
});

test('reclaim propagates real storage failures instead of misreporting foreign privacy and a rerun converges', async t => {
  const f = await sharedFixture(t); const id = await f.item(['src/recover.ts']);
  await f.client.update(id, { assignee: 'absent-worker', field: ['swarm_token=1', 'swarm_claimed_at=2000-01-01T00:00:00.000Z'] });
  const located = await locateItem(f.pmRoot, id); assert.ok(located);
  const history = getHistoryPath(f.pmRoot, id); const before = readFileSync(history, 'utf8');
  const saved = `${located.itemPath}.retained`; const update = f.client.update.bind(f.client);
  // Inject an actual storage obstruction at the write boundary, forwarding the real SDK update.
  f.client.update = async (...args) => {
    renameSync(located.itemPath, saved); mkdirSync(located.itemPath);
    try { return await update(...args); }
    finally { rmdirSync(located.itemPath); renameSync(saved, located.itemPath); }
  };
  try { await assert.rejects(f.shared.reclaim(60, 'receiver'), error => error instanceof Error && !(error instanceof SettingsRefusal)); }
  finally { f.client.update = update; }
  assert.equal(readFileSync(history, 'utf8'), before);
  assert.equal((await f.client.get(id)).item.assignee, 'absent-worker');
  const rerun = await f.shared.reclaim(60, 'receiver'); assert.deepEqual(rerun.recovered.map(row => row.id), [id]);
  assert.deepEqual((await f.shared.reclaim(60, 'receiver')).recovered, []);
  assert.equal((await f.client.get(id)).item.swarm_token, '2');
});

test('resource reads refuse a provider installed between ownership discovery and metadata inspection', async t => {
  const f = await sharedFixture(t); const id = await f.item();
  let discoveries = 0; const directory = join(f.pmRoot, 'extensions');
  const original = filesystem.readdir;
  const observer = t.mock.method(filesystem, 'readdir', new Proxy(original, { apply(target, receiver, args: unknown[]) {
    if (String(args[0]) === directory && ++discoveries === 2) declareService(f);
    return Reflect.apply(target, receiver, args);
  } }));
  syncBuiltinESMExports();
  const located = await locateItem(f.pmRoot, id); assert.ok(located);
  const history = getHistoryPath(f.pmRoot, id); const before = readFileSync(history, 'utf8');
  try { await assert.rejects(trackerResourceBackend(f.shared.engine).read(id), { code: 'resource_backend_refused' }); }
  finally { observer.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(discoveries >= 2, true, 'A real provider declaration reaches the second discovery boundary');
  assert.equal(readFileSync(history, 'utf8'), before);
});
