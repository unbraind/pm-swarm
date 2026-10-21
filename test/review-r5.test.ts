import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { sharedFixture } from './shared-helpers.ts';

for (const previousClaim of [false, true]) {
  test(`start preserves a foreign assignment with previous claim ${previousClaim}`, async t => {
    const f = await sharedFixture(t); const id = await f.item(['assigned']);
    if (previousClaim) { await f.client.claim(id); await f.client.release(id); }
    await f.client.update(id, { assignee: 'foreign-worker' });
    const view = await f.client.get(id, { depth: 'full' });
    assert.equal(view.claim_state?.claimed, true, 'the pinned SDK derives ownership from assignee');
    assert.equal(view.claim_state?.assignee, 'foreign-worker');
    assert.equal(view.claim_state?.last_claim === null, !previousClaim);
    const history = join(f.pmRoot, 'history', `${id}.jsonl`); const before = readFileSync(history, 'utf8');
    await assert.rejects(f.shared.start(id), /Item claimed by foreign-worker/);
    assert.equal(readFileSync(history, 'utf8'), before, 'refused start must not mutate the item');
    const after = (await f.client.get(id, { depth: 'full' })).item;
    assert.equal(after.assignee, 'foreign-worker'); assert.equal(after.swarm_token, undefined);
  });
}

for (const transport of ['SDK', 'CLI'] as const) {
  test(`reclaim normalizes receiver identity through ${transport}`, async t => {
    const f = await sharedFixture(t); const id = await f.item(['stale']);
    await f.client.update(id, { assignee: 'absent-worker', field: ['swarm_claimed_at=2000-01-01T00:00:00.000Z'] });
    await assert.rejects(f.shared.reclaim(60, ' \t '), /nonempty optional --to/);
    const result = transport === 'SDK' ? await f.shared.reclaim(60, ' receiver ') : f.run('swarm', 'reclaim', '--stale-after', '60', '--to', ' receiver ');
    assert.equal((result.recovered as { agent: string }[])[0].agent, 'receiver');
    const item = (await f.client.get(id, { depth: 'full' })).item;
    assert.equal(item.assignee, 'receiver');
    const context = JSON.parse(String(item.swarm_handoff)) as { to: string; token: string; note: string };
    assert.equal(context.to, 'receiver'); assert.match(context.note, /destination receiver;/);
    const receiver = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'receiver'));
    const next = await receiver.next();
    assert.equal(next.selected, id); assert.equal(next.token, context.token);
    await receiver.sync(id, true, ['recovered/result.ts']);
  });
}

test('README defines the per-item reclaim staleness snapshot boundary', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /Each item's eligibility is fixed when reclaim reads that evidence; later heartbeat renewals do not change that decision in the current invocation\./);
});
