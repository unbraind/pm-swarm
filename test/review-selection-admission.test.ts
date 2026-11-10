import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import { CLOSE_INTENT, captureCloseMember } from '../src/close-journal.ts';
import { prepareClose } from '../src/close-recovery.ts';
import { assertCloseIntentSettled } from '../src/close.ts';
import { sharedFixture } from './shared-helpers.ts';
import { fixture } from './helpers.ts';
import { SharedTracker } from '../src/shared-tracker.ts';

/** Compare selection across the real JSON and TOON command transports. */
function assertSelectionCli(f: Pick<Awaited<ReturnType<typeof sharedFixture>>, 'cli'>, commands: string[], ready: string): void {
  for (const command of commands) for (const json of [false, true]) {
    const result = f.cli('swarm', command, ...(command === 'plan' ? [] : ['--dry-run']), ...(json ? ['--json'] : []));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const receipt = (json ? JSON.parse(result.stdout) : decodeToon(result.stdout)) as { selected?: string; suggested_start_set?: string[] };
    assert.equal(command === 'plan' ? receipt.suggested_start_set?.[0] : receipt.selected, ready);
  }
}

for (const mode of ['git', 'shared']) test(`${mode} selection excludes every intent rejected by explicit ownership admission`, async t => {
  const f = mode === 'git' ? await fixture(t) : await sharedFixture(t);
  const engine = 'swarm' in f ? f.swarm : f.shared.engine;
  const api = 'swarm' in f ? f.swarm : f.shared;
  const blocked: string[] = [];
  for (const phase of ['malformed', 'applying', 'compensating']) {
    const id = await f.item([`src/${phase}.ts`]);
    const { journal } = await prepareClose(engine, id, 'Public admission fixture', undefined, await captureCloseMember(engine, id));
    await f.client.update(id, { priority: 1, field: [`${CLOSE_INTENT}=${phase === 'malformed' ? 'invalid' : JSON.stringify({ ...journal, phase })}`] });
    assert.throws(() => assertCloseIntentSettled(engine, ( { id, [CLOSE_INTENT]: phase === 'malformed' ? 'invalid' : JSON.stringify({ ...journal, phase }) } )), { code: 'swarm_close_transfer_refused' });
    await assert.rejects(api.start(id), { code: 'swarm_close_transfer_refused' }); blocked.push(id);
  }
  const ready = await f.item(['src/ready.ts']);
  if ('save' in f) f.save();
  const candidates = await engine.readyCandidates(undefined, mode === 'git');
  assert.deepEqual(candidates.candidates.map(row => row.id), [ready]);
  assert.deepEqual((await api.plan()).suggested_start_set, [ready]);
  assert.equal((await api.next(undefined, true)).selected, ready);
  assert.equal((await api.schedule({ skills: [], dryRun: true })).selected, ready);
  if ('cli' in f) assertSelectionCli(f, ['plan', 'next', 'schedule'], ready);
  assert.equal((await api.next()).selected, ready);
  for (const id of blocked) assert.equal((await f.client.get(id)).item.assignee, undefined);
  const settled = await f.item(['src/settled.ts']);
  const shared = new SharedTracker(engine); const claim = await shared.start(settled);
  await shared.close(settled, 'Public settled close proof', claim.token);
  await f.client.reopen(settled, 'Public committed receipt remains reusable');
  const item = (await f.client.get(settled)).item;
  assert.doesNotThrow(() => assertCloseIntentSettled(engine, item));
  assert.ok((await engine.readyCandidates(undefined, mode === 'git')).candidates.some(row => row.id === settled));
  assert.equal((await shared.start(settled)).id, settled, 'committed receipts remain transferable');
});


test('assigned handoffs with unsettled intents cannot preempt ready work in next or schedule', async t => {
  const f = await sharedFixture(t);
  const pending: string[] = [];
  for (const phase of ['malformed', 'applying', 'compensating']) {
    const id = await f.item([`src/${phase}.ts`]);
    const { journal } = await prepareClose(f.shared.engine, id, 'Public receiver fixture', undefined, await captureCloseMember(f.shared.engine, id));
    await f.client.update(id, { assignee: 'shared-test', field: [`swarm_handoff=${JSON.stringify({ token: '1', note: 'Public receiver fixture' })}`, 'swarm_token=1', `${CLOSE_INTENT}=${phase === 'malformed' ? 'invalid' : JSON.stringify({ ...journal, phase })}`] }); pending.push(id);
  }
  const ready = await f.item(['src/ready.ts']);
  for (const dryRun of [true, false]) {
    assert.equal((await f.shared.next(undefined, dryRun)).selected, ready);
    if (!dryRun) await f.client.release(ready);
    assert.equal((await f.shared.schedule({ skills: [], dryRun })).selected, ready);
    if (!dryRun) await f.client.release(ready);
  }
  assertSelectionCli(f, ['next', 'schedule'], ready);
  for (const id of pending) assert.equal((await f.client.get(id)).item.assignee, 'shared-test');
});
