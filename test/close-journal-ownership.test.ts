import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { getHistoryPath, deriveMutationTransactionId } from '@unbrained/pm-cli/sdk';
import { SharedTracker } from '../src/shared-tracker.ts';
import { SettingsRefusal } from '../src/settings.ts';
import { sharedFixture } from './shared-helpers.ts';
import { durableSnapshot } from './privacy-snapshot.ts';

for (const field of ['title', 'body', 'description', 'acceptance_criteria']) test(`copied same-author message never authorizes compensating a peer ${field}`, async t => {
  const f = await sharedFixture(t); const id = await f.item(); const claim = await f.shared.start(id);
  let failed = false; let edited = false;
  await assert.rejects(f.shared.close(id, 'Public completion', claim.token, { onTransition: context => {
    if (!failed && context.transition === 'step_recorded') { failed = true; throw new Error('Injected rollback'); }
    if (!edited && context.transition === 'step_compensating') {
      edited = true;
      const row = JSON.parse(readFileSync(getHistoryPath(f.pmRoot, id), 'utf8').trim().split('\n').at(-1)!) as { message?: string };
      const flag = field === 'acceptance_criteria' ? '--acceptance-criteria' : `--${field}`;
      const result = f.cli('update', id, flag, 'Public peer result', '--message', row.message ?? 'Copied transaction message', '--json');
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
  } }), error => error instanceof SettingsRefusal && error.code === 'swarm_superseded');
  assert.equal(edited, true);
  const before = durableSnapshot(f.pmRoot);
  for (let retry = 0; retry < 3; retry++) {
    await assert.rejects(new SharedTracker(f.shared.engine).close(id, 'Public completion', claim.token), error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed');
    assert.equal(durableSnapshot(f.pmRoot), before);
  }
  const current = await f.client.get(id, { depth: 'full' });
  assert.equal(current.item[field], 'Public peer result');
});

test('a copied mutable transaction hint without its SDK journal cannot authorize recovery', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const claim = await f.shared.start(id);
  const identity = deriveMutationTransactionId(JSON.stringify({ protocol: 'swarm-close/v2', id, author: 'shared-test', token: claim.token, note: 'Public completion' }));
  await f.client.update(id, { unset: ['assignee'], field: [`swarm_close_transaction=${identity}`, 'swarm_token=2'], message: `bulk-item-transaction ${identity} copied apply` });
  const before = durableSnapshot(f.pmRoot);
  await assert.rejects(f.shared.close(id, 'Public completion', '1'), error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed');
  assert.equal(durableSnapshot(f.pmRoot), before);
});
