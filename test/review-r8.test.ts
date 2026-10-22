import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { StaleFenceError } from '../src/lease.ts';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { sharedFixture } from './shared-helpers.ts';

/** Produce a real receiver packet and retain the exact history path for refusal checks. */
async function handoffFixture(t: TestContext) {
  const f = await sharedFixture(t); const id = await f.item(['src/handoff.ts']);
  await f.shared.start(id);
  const sent = await f.shared.handoff(id, 'receiver', 'Continue verified work');
  const receiver = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, 'receiver'));
  return { ...f, id, sent, receiver, historyPath: join(f.pmRoot, 'history', `${id}.jsonl`) };
}

test('SDK next refuses malformed handoff contexts without writes and preserves valid receiver continuation', async t => {
  const f = await handoffFixture(t);
  const cases = [
    { raw: '{', token: '2' },
    { raw: 'null', token: '2' },
    { raw: '"packet"', token: undefined },
    { raw: '12', token: undefined },
    { raw: 'true', token: undefined },
    { raw: '[]', token: undefined },
    { raw: '{}', token: undefined },
    { raw: '{"token":2}', token: '2' },
    { raw: '{"token":"abc"}', token: 'abc' },
    { raw: '{"token":"3"}', token: '2' },
  ];
  for (const scenario of cases) {
    await f.client.update(f.id, {
      force: true, field: [`swarm_handoff=${scenario.raw}`, ...(scenario.token === undefined ? [] : [`swarm_token=${scenario.token}`])],
      unset: scenario.token === undefined ? ['swarm_token'] : [],
    });
    const before = readFileSync(f.historyPath, 'utf8');
    const item = (await f.client.get(f.id, { depth: 'full' })).item;
    for (const dryRun of [true, false]) await assert.rejects(f.receiver.next(undefined, dryRun), StaleFenceError, `${scenario.raw}; dryRun=${dryRun}`);
    assert.equal(readFileSync(f.historyPath, 'utf8'), before);
    assert.deepEqual((await f.client.get(f.id, { depth: 'full' })).item, item);
  }
  await f.client.update(f.id, { force: true, field: [`swarm_handoff=${JSON.stringify(f.sent.context)}`, `swarm_token=${f.sent.token}`] });
  const before = readFileSync(f.historyPath, 'utf8');
  assert.deepEqual((await f.receiver.next(undefined, true)).context, f.sent.context);
  await assert.rejects(f.receiver.sync(f.id, true, ['unverified.ts']), StaleFenceError, 'preview must not remember a token');
  assert.equal(readFileSync(f.historyPath, 'utf8'), before);
  const received = await f.receiver.next();
  assert.equal(received.token, f.sent.token); assert.deepEqual(received.context, f.sent.context);
  assert.deepEqual((await f.receiver.sync(f.id, true, ['test/continued.ts'])).add, ['test/continued.ts']);
});

test('CLI next classifies malformed JSON and null handoffs as stale fences in preview and claim mode', async t => {
  const f = await handoffFixture(t);
  for (const raw of ['{', 'null']) {
    await f.client.update(f.id, { force: true, field: [`swarm_handoff=${raw}`] });
    const before = readFileSync(f.historyPath, 'utf8');
    for (const dryRun of [true, false]) {
      const result = f.cli('swarm', 'next', '--agent', 'receiver', ...(dryRun ? ['--dry-run'] : []), '--json');
      const output = result.stdout + result.stderr;
      assert.equal(result.status, 2, output + (result.error?.message ?? ''));
      assert.match(output, /"code"\s*:\s*"swarm_stale_fence"/);
      assert.ok(output.includes(f.id));
      assert.doesNotMatch(output, /SyntaxError|TypeError|Cannot read properties|Unexpected token/);
    }
    assert.equal(readFileSync(f.historyPath, 'utf8'), before);
  }
  await f.client.update(f.id, { force: true, field: [`swarm_handoff=${JSON.stringify(f.sent.context)}`] });
  const before = readFileSync(f.historyPath, 'utf8');
  for (const dryRun of [true, false]) {
    const result = f.run('swarm', 'next', '--agent', 'receiver', ...(dryRun ? ['--dry-run'] : []));
    assert.equal(result.selected, f.id); assert.equal(result.token, f.sent.token);
    assert.deepEqual(result.context, f.sent.context);
  }
  assert.equal(readFileSync(f.historyPath, 'utf8'), before);
});
