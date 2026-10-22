import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SharedTracker } from '../src/shared-tracker.ts';
import { fixture, swarmCli } from './helpers.ts';
import { sharedFixture } from './shared-helpers.ts';

const OLD_CLAIM = '2000-01-01T00:00:00.000Z';
const TOKEN_REASON = 'Malformed swarm_token; repair the fencing generation before reclaiming';
const LANE_REASON = 'Git lane cannot return to the pool; use --to to assign its worktree branch';

/** Require a named ownership refusal instead of a raw BigInt SyntaxError, with no item write. */
async function refusesMalformed(operation: Promise<unknown>, id: string, history: string, historyPath: string) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error instanceof SyntaxError, false);
    assert.match(error.message, new RegExp(`Item ${id} has a malformed swarm_token; repair it before changing ownership`));
    return true;
  });
  assert.equal(readFileSync(historyPath, 'utf8'), history);
}

test('malformed swarm_token refuses start, next, handoff and close before writing', async t => {
  const f = await sharedFixture(t);
  const owned = await f.item(['owned']);
  await f.shared.start(owned);
  await f.client.update(owned, { field: ['swarm_token=abc'] });
  const ownedHistoryPath = join(f.pmRoot, 'history', `${owned}.jsonl`);
  const ownedHistory = readFileSync(ownedHistoryPath, 'utf8');
  await refusesMalformed(f.shared.handoff(owned, 'receiver', 'Continue', 'abc'), owned, ownedHistory, ownedHistoryPath);
  await refusesMalformed(f.shared.close(owned, 'Done', 'abc'), owned, ownedHistory, ownedHistoryPath);
  assert.equal((await f.client.get(owned, { depth: 'full' })).item.assignee, 'shared-test');
  const ready = await f.item(['ready']);
  await f.client.update(ready, { field: ['swarm_token=-1'] });
  assert.equal((await f.client.get(ready, { depth: 'full' })).item.swarm_token, '-1');
  const readyHistoryPath = join(f.pmRoot, 'history', `${ready}.jsonl`);
  const readyHistory = readFileSync(readyHistoryPath, 'utf8');
  await refusesMalformed(f.shared.next(), ready, readyHistory, readyHistoryPath);
  await refusesMalformed(f.shared.start(ready), ready, readyHistory, readyHistoryPath);
  const cli = f.cli('swarm', 'start', ready, '--json');
  assert.notEqual(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout + cli.stderr, new RegExp(`Item ${ready} has a malformed swarm_token`));
  assert.doesNotMatch(cli.stdout + cli.stderr, /SyntaxError|Cannot convert/);
  assert.equal(readFileSync(readyHistoryPath, 'utf8'), readyHistory);
  assert.equal((await f.client.get(ready, { depth: 'full' })).item.assignee, undefined);
});

test('malformed swarm_token does not abort reclaim', async t => {
  const f = await sharedFixture(t);
  const badValues = ['abc', '-1', '0x10', '+3', '1.5', ' 2'];
  const refused = [];
  for (const [index, token] of badValues.entries()) {
    const id = await f.item([`bad-${index}`]);
    await f.client.update(id, { assignee: `bad-${index}`, field: [`swarm_token=${token}`, `swarm_claimed_at=${OLD_CLAIM}`] });
    const stored = String((await f.client.get(id, { depth: 'full' })).item.swarm_token);
    assert.equal(stored, token, 'the pinned SDK must retain the non-decimal generation');
    refused.push({ id, history: readFileSync(join(f.pmRoot, 'history', `${id}.jsonl`), 'utf8') });
  }
  const good = await f.item(['good']);
  await f.client.update(good, { assignee: 'good-worker', field: [`swarm_token=4`, `swarm_claimed_at=${OLD_CLAIM}`] });
  const result = await f.shared.reclaim(60);
  assert.deepEqual(result.recovered.map(row => row.id), [good]);
  assert.equal(result.recovered[0]?.token, '5');
  assert.deepEqual(result.refused.map(row => row.id).sort(), refused.map(row => row.id).sort());
  assert.ok(result.refused.every(row => row.reason === TOKEN_REASON));
  for (const row of refused) {
    assert.equal(readFileSync(join(f.pmRoot, 'history', `${row.id}.jsonl`), 'utf8'), row.history);
    assert.equal((await f.client.get(row.id, { depth: 'full' })).item.assignee, `bad-${refused.indexOf(row)}`);
  }
  const pooled = (await f.client.get(good, { depth: 'full' })).item;
  assert.equal(pooled.status, 'open');
  assert.equal(pooled.assignee, undefined);
  const laterBad = await f.item(['later-bad']);
  const laterGood = await f.item(['later-good']);
  await f.client.update(laterBad, { assignee: 'later-bad', field: [`swarm_token=abc`, `swarm_claimed_at=${OLD_CLAIM}`] });
  await f.client.update(laterGood, { assignee: 'later-good', field: [`swarm_token=1`, `swarm_claimed_at=${OLD_CLAIM}`] });
  const cli = f.run('swarm', 'reclaim', '--stale-after', '60') as { recovered: { id: string }[]; refused: { id: string; reason: string }[] };
  assert.deepEqual(cli.recovered.map(row => row.id), [laterGood]);
  assert.deepEqual(cli.refused.map(row => row.id).sort(), [...refused.map(row => row.id), laterBad].sort());
  assert.ok(cli.refused.every(row => row.reason === TOKEN_REASON));
  assert.equal((await f.client.get(laterBad, { depth: 'full' })).item.assignee, 'later-bad');
});

test('Git lane pool return is refused and --to still assigns', async t => {
  const f = await fixture(t);
  const lane = await f.item(['existing']);
  f.save();
  await f.swarm.start(lane);
  const started = (await f.client.get(lane, { depth: 'full' })).item;
  const branch = String(started.swarm_branch);
  assert.match(branch, /^swarm\//);
  const control = await f.item(['control']);
  const manual = await f.item(['manual-branch']);
  await f.client.update(lane, { assignee: 'idle-lane', field: [`swarm_claimed_at=${OLD_CLAIM}`] });
  await f.client.update(control, { assignee: 'idle-control', field: [`swarm_claimed_at=${OLD_CLAIM}`] });
  await f.client.update(manual, { assignee: 'idle-manual', field: [`swarm_branch=swarm/manual`, `swarm_claimed_at=${OLD_CLAIM}`] });
  const laneBefore = (await f.client.get(lane, { depth: 'full' })).item;
  assert.equal(laneBefore.swarm_branch, branch);
  assert.equal((await f.client.get(manual, { depth: 'full' })).item.swarm_branch, 'swarm/manual');
  assert.equal((await f.swarm.corpus()).items.find(item => item.id === lane)?.swarm_branch, branch, 'certified corpus rows retain swarm_branch');
  const laneHistory = readFileSync(join(f.pmRoot, 'history', `${lane}.jsonl`), 'utf8');
  const manualHistory = readFileSync(join(f.pmRoot, 'history', `${manual}.jsonl`), 'utf8');
  const cli = swarmCli(f, ['reclaim', '--stale-after', '60']);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr + (cli.error?.message ?? ''));
  const parsed = JSON.parse(cli.stdout) as { recovered: { id: string }[]; refused: { id: string; reason: string }[] };
  assert.deepEqual(parsed.recovered.map(row => row.id), [control]);
  assert.deepEqual(parsed.refused.map(row => row.id).sort(), [lane, manual].sort());
  assert.ok(parsed.refused.every(row => row.reason === LANE_REASON));
  const preserved = (await f.client.get(lane, { depth: 'full' })).item;
  assert.equal(preserved.assignee, 'idle-lane');
  assert.equal(preserved.swarm_branch, branch);
  assert.equal(preserved.swarm_base, laneBefore.swarm_base);
  assert.equal(preserved.swarm_token, laneBefore.swarm_token);
  assert.equal((await f.client.get(manual, { depth: 'full' })).item.assignee, 'idle-manual');
  assert.equal(readFileSync(join(f.pmRoot, 'history', `${lane}.jsonl`), 'utf8'), laneHistory);
  assert.equal(readFileSync(join(f.pmRoot, 'history', `${manual}.jsonl`), 'utf8'), manualHistory);
  await assert.rejects(f.swarm.start(lane), /Lane already exists/);
  assert.notEqual((await f.swarm.next(undefined, true)).selected, lane);
  const assigned = await f.client.get(lane, { depth: 'full' });
  assert.equal(assigned.item.assignee, 'idle-lane', 'the existence check must not release the lane');
  const moved = await new SharedTracker(f.swarm).reclaim(60, 'receiver');
  assert.deepEqual(moved.recovered.map(row => row.id).sort(), [lane, manual].sort());
  const receiverItem = (await f.client.get(lane, { depth: 'full' })).item;
  assert.equal(receiverItem.assignee, 'receiver');
  assert.equal(receiverItem.swarm_branch, branch);
  assert.equal(receiverItem.swarm_base, laneBefore.swarm_base);
  assert.equal((await f.client.get(manual, { depth: 'full' })).item.swarm_branch, 'swarm/manual');
});

test('README defines reclaim token and Git lane refusals', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /A `swarm_token` that is not a decimal generation is also preserved and reported in `refused`, and reclaim continues with the other items/);
  assert.match(readme, /Reclaim does not return a Git lane \(`swarm_branch` set\) to the pool/);
});
