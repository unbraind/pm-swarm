import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { heartbeatPath } from '../src/lease.ts';
import { sharedFixture } from './shared-helpers.ts';

test('reclaim preview and apply preserve the invoking principal while recovering another owner', async t => {
  const fixture = await sharedFixture(t);
  const principal = fixture.shared.engine.author;
  const mine = await fixture.item(['mine']); const abandoned = await fixture.item(['abandoned']);
  const old = '2000-01-01T00:00:00.000Z';
  for (const [id, owner] of [[mine, principal], [abandoned, 'absent-worker']]) {
    await fixture.client.update(id, { assignee: owner, field: ['swarm_token=7', `swarm_claimed_at=${old}`] });
  }
  const heartbeat = heartbeatPath(fixture.pmRoot, principal);
  writeFileSync(heartbeat, JSON.stringify({ heartbeat: old }));
  const history = join(fixture.pmRoot, 'history', `${mine}.jsonl`); const before = readFileSync(history, 'utf8');
  const preview = fixture.run('swarm', 'reclaim', '--stale-after', '60', '--dry-run') as { recovered: { id: string }[]; refused: unknown[] };
  assert.equal(JSON.parse(readFileSync(heartbeat, 'utf8')).heartbeat, old, 'preview does not announce liveness');
  const applied = fixture.run('swarm', 'reclaim', '--stale-after', '60') as typeof preview;
  assert.deepEqual(preview.recovered.map(row => row.id).sort(), applied.recovered.map(row => row.id).sort());
  assert.deepEqual(preview.recovered.map(row => row.id), [abandoned]);
  assert.deepEqual(preview.refused, []); assert.deepEqual(applied.refused, []);
  assert.equal(readFileSync(history, 'utf8'), before, 'neither mode can change the invoking principal claim');
  const retained = (await fixture.client.get(mine, { depth: 'full' })).item;
  assert.equal(retained.assignee, principal); assert.equal(retained.swarm_token, '7');
  await fixture.shared.sync(mine, true, ['mine/result'], '7');
  assert.equal((await fixture.client.get(abandoned)).claim_state?.claimed, false);
});

test('current verification introduction distinguishes Git fencing from external SDK contracts', () => {
  const introduction = readFileSync(new URL('../docs/fenced-leases-verification.md', import.meta.url), 'utf8').split('\n## Regressions')[0];
  assert.match(introduction, /Shared-mode operation records have a 30-second heartbeat expiry/);
  assert.match(introduction, /Git-mode writers retain the live process pin across synchronous subprocesses/);
  assert.match(introduction, /Git sync validates item ownership and any persisted swarm token under the tracker pin/);
  assert.match(introduction, /All other Git lane ownership writes validate operation and process-pin generations before SDK mutations/);
  assert.match(introduction, /Core pm commands and external SDK clients remain outside this protocol/);
});
