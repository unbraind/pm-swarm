import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { getHistoryPath, locateItem } from '@unbrained/pm-cli/sdk';
import { inspectItem } from '../src/inspection.ts';
import { PlanProgress } from '../src/progress.ts';
import { assertPrivatePathSafe } from '../src/settings.ts';
import { sharedFixture } from './shared-helpers.ts';
import { ownedPlan, declareService } from './privacy-mutations.ts';

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
});

test('reclaim skips unsafe foreign context and truthfully retains other completed transfers', async t => {
  const f = await sharedFixture(t); const safe = await f.item(['src/safe.ts'], 0); const foreign = await f.item(['src/foreign.ts']); const malformed = await f.item(['../foreign.ts'], 3);
  const encoded = encodeURIComponent(['', 'var', 'private', 'foreign'].join('/'));
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
