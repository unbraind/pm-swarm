import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { getHistoryPath, WorkspaceTransactionInterruptedError } from '@unbrained/pm-cli/sdk';
import type { WorkspaceTransactionTransitionContext } from '@unbrained/pm-cli/sdk';
import { sharedFixture } from './shared-helpers.ts';
import { SharedTracker } from '../src/shared-tracker.ts';
import { commitItemMutation, SettingsRefusal } from '../src/settings.ts';
import { StaleFenceError } from '../src/lease.ts';
import { durableSnapshot } from './privacy-snapshot.ts';
import { inspectItem } from '../src/inspection.ts';

/** Read actual native history operations without interpreting coordinator journal internals. */
function operations(pmRoot: string, id: string): string[] {
  return readFileSync(getHistoryPath(pmRoot, id), 'utf8').trim().split('\n').map(line => (JSON.parse(line) as { op: string }).op);
}

test('canonical item identity resumes the same close when the caller changes from a short id', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const short = id.split('-').at(-1)!;
  assert.equal((await f.client.get(short)).item.id, id);
  const receipt = await f.shared.start(id);
  await assert.rejects(f.shared.close(short, 'Public completion', undefined, { onTransition: context => {
    if (context.transition === 'step_recorded') throw new WorkspaceTransactionInterruptedError('Interrupted alias request');
  } }), WorkspaceTransactionInterruptedError);
  assert.deepEqual(f.run('swarm', 'close', id, '--token', receipt.token, '--note', 'Public completion'), { id, closed: true });
});

test('a service-capable host retains bound-client reads and native journaled close', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const receipt = await f.shared.start(id);
  const manifestPath = join(f.pmRoot, 'extensions/pm-swarm/manifest.json');
  const metadata = JSON.parse(readFileSync(manifestPath, 'utf8')) as { capabilities: string[] };
  metadata.capabilities.push('services'); writeFileSync(manifestPath, JSON.stringify(metadata));
  assert.equal(await inspectItem(f.pmRoot, f.repo, id), null);
  assert.deepEqual(await f.shared.close(id, 'Public completion', receipt.token), { id, closed: true });
});

test('a native SDK claim without a swarm token closes and resumes with its legacy generation', async t => {
  const f = await sharedFixture(t); const id = await f.item(); await f.client.claim(id);
  assert.equal((await f.client.get(id)).item.swarm_token, undefined);
  const baseline = operations(f.pmRoot, id).length;
  await assert.rejects(f.shared.close(id, 'Public legacy completion', undefined, { onTransition: context => {
    if (context.transition === 'step_recorded') throw new WorkspaceTransactionInterruptedError('Interrupted legacy close');
  } }), WorkspaceTransactionInterruptedError);
  assert.deepEqual(await new SharedTracker(f.shared.engine).close(id, 'Public legacy completion'), { id, closed: true });
  assert.equal((await f.client.get(id)).item.swarm_token, '1');
  assert.deepEqual(operations(f.pmRoot, id).slice(baseline), ['update', 'close']);
  const history = readFileSync(getHistoryPath(f.pmRoot, id), 'utf8');
  await f.shared.close(id, 'Public legacy completion');
  assert.equal(readFileSync(getHistoryPath(f.pmRoot, id), 'utf8'), history);
});

test('SDK close journal resumes every forward boundary without duplicate item mutations', async t => {
  const f = await sharedFixture(t); const trace: WorkspaceTransactionTransitionContext[] = [];
  const control = await f.item(['src/public.ts']); const controlReceipt = await f.shared.start(control);
  await f.shared.close(control, 'Public completion', controlReceipt.token, { onTransition: context => { trace.push(context); } });
  assert.deepEqual(trace.map(context => context.transition), ['prepared', 'step_applied', 'step_recorded', 'step_applied', 'step_recorded', 'committing', 'committed']);
  for (const [boundary, transition] of trace.entries()) await t.test(`${boundary}: ${transition.transition}`, async () => {
    const id = await f.item(['src/public.ts']); const receipt = await f.shared.start(id); const baseline = operations(f.pmRoot, id).length; let index = 0;
    await assert.rejects(f.shared.close(id, 'Public completion', receipt.token, { onTransition: () => { if (index++ === boundary) throw new WorkspaceTransactionInterruptedError('Injected close interruption'); } }), WorkspaceTransactionInterruptedError);
    const interrupted = (await f.client.get(id, { depth: 'full' })).item;
    assert.equal(interrupted.swarm_token, boundary === 0 ? '1' : '2');
    // A fresh CLI process has no embedded token map or in-memory transaction state.
    const result = f.run('swarm', 'close', id, '--token', receipt.token, '--note', 'Public completion');
    if (boundary === 3) { assert.equal(result.id, id); assert.equal(result.closed, true); assert.equal(result.warnings_unavailable, true); assert.match(String(result.required), /dependent items/); }
    else assert.deepEqual(result, { id, closed: true });
    const after = (await f.client.get(id, { depth: 'full' })).item;
    assert.equal(after.status, 'closed'); assert.equal(after.assignee, undefined); assert.equal(after.swarm_token, '2');
    assert.equal(typeof after.swarm_close_transaction, 'string');
    assert.deepEqual(operations(f.pmRoot, id).slice(baseline), ['update', 'close']);
    const history = readFileSync(getHistoryPath(f.pmRoot, id), 'utf8');
    assert.deepEqual(await new SharedTracker(f.shared.engine).close(id, 'Public completion', receipt.token), result);
    assert.equal(readFileSync(getHistoryPath(f.pmRoot, id), 'utf8'), history);
  });
  console.log(JSON.stringify({ crash_boundaries: trace.length, cross_process_resumes: trace.length, duplicate_item_mutations: 0, lost_fields: 0 }));
});

test('ordinary SDK close failure compensates the metadata update and retry completes once', async t => {
  const f = await sharedFixture(t); const id = await f.item(['src/public.ts']); const receipt = await f.shared.start(id);
  const before = (await f.client.get(id, { depth: 'full' })).item; let interrupted = false;
  await assert.rejects(f.shared.close(id, 'Public completion', receipt.token, { onTransition: context => {
    if (!interrupted && context.transition === 'step_recorded') { interrupted = true; throw new Error('Injected ordinary failure'); }
  } }), error => error instanceof Error && !(error instanceof SettingsRefusal) && /Injected ordinary failure/.test(error.message));
  const compensated = (await f.client.get(id, { depth: 'full' })).item;
  for (const field of ['status', 'assignee', 'swarm_token', 'swarm_handoff', 'swarm_close_transaction', 'closed_at', 'body', 'files']) assert.deepEqual(compensated[field], before[field], field);
  assert.ok(operations(f.pmRoot, id).includes('restore'));
  await f.shared.close(id, 'Public completion', receipt.token);
  assert.equal((await f.client.get(id)).item.swarm_token, '2');
  const history = readFileSync(getHistoryPath(f.pmRoot, id), 'utf8');
  await f.shared.close(id, 'Public completion', receipt.token);
  assert.equal(readFileSync(getHistoryPath(f.pmRoot, id), 'utf8'), history);
});

test('SDK compensation interruptions resume without duplicate rollback or lost completion', async t => {
  const f = await sharedFixture(t);
  for (const boundary of ['compensating', 'step_compensating', 'step_compensated', 'compensated']) await t.test(boundary, async () => {
    const id = await f.item(); const receipt = await f.shared.start(id); const baseline = operations(f.pmRoot, id).length; let failed = false; let crashed = false;
    await assert.rejects(f.shared.close(id, 'Public completion', receipt.token, { onTransition: context => {
      if (!failed && context.transition === 'step_recorded') { failed = true; throw new Error('Injected ordinary failure'); }
      if (context.transition === boundary) { crashed = true; throw new WorkspaceTransactionInterruptedError('Injected compensation interruption'); }
    } }));
    assert.equal(crashed, true);
    await new SharedTracker(f.shared.engine).close(id, 'Public completion', receipt.token);
    assert.deepEqual(operations(f.pmRoot, id).slice(baseline), ['update', 'restore', 'update', 'close']);
    assert.equal((await f.client.get(id)).item.swarm_token, '2');
  });
});

test('a fresh retry never compensates over a peer edit left by a refused rollback', async t => {
  const f = await sharedFixture(t);
  for (const kind of ['comment', 'title', 'body', 'copied-marker'] as const) await t.test(kind, async () => {
    const id = await f.item(); const receipt = await f.shared.start(id); let failed = false; let edited = false;
    await assert.rejects(f.shared.close(id, 'Public completion', receipt.token, { onTransition: context => {
      if (!failed && context.transition === 'step_recorded') { failed = true; throw new Error('Ordinary close failure'); }
      if (!edited && context.transition === 'step_compensating') {
        edited = true;
        const marker = (JSON.parse(readFileSync(getHistoryPath(f.pmRoot, id), 'utf8').trim().split('\n').at(-1)!) as { message: string }).message;
        const args = kind === 'comment' || kind === 'copied-marker'
          ? ['comment', id, 'Public peer receipt', ...(kind === 'copied-marker' ? ['--message', marker] : [])]
          : ['update', id, `--${kind}`, 'Public peer receipt', '--message', 'Public peer change', ...(kind === 'body' ? ['--author', 'peer'] : [])];
        assert.equal(f.cli(...args, '--json').status, 0);
      }
    } }), error => error instanceof SettingsRefusal && error.code === 'swarm_superseded');
    assert.equal(edited, true);
    const before = durableSnapshot(f.pmRoot); const history = readFileSync(getHistoryPath(f.pmRoot, id), 'utf8');
    await assert.rejects(new SharedTracker(f.shared.engine).close(id, 'Public completion', receipt.token), error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed');
    assert.equal(durableSnapshot(f.pmRoot), before);
    assert.equal(readFileSync(getHistoryPath(f.pmRoot, id), 'utf8'), history);
    const item = (await f.client.get(id, { depth: 'full' })).item;
    if (kind === 'comment' || kind === 'copied-marker') assert.ok(item.comments!.some(row => row.text === 'Public peer receipt'));
    else assert.equal(item[kind], 'Public peer receipt');
  });
});

test('owned close compensation receipts resume after the close step was restored', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const receipt = await f.shared.start(id);
  const baseline = operations(f.pmRoot, id).length; let failed = false;
  await assert.rejects(f.shared.close(id, 'Public completion', receipt.token, { onTransition: context => {
    if (!failed && context.transition === 'committing') { failed = true; throw new Error('Fail after both mutations'); }
    if (context.transition === 'step_compensated') throw new WorkspaceTransactionInterruptedError('Interrupted close compensation');
  } }));
  assert.deepEqual(await new SharedTracker(f.shared.engine).close(id, 'Public completion', receipt.token), { id, closed: true });
  assert.deepEqual(operations(f.pmRoot, id).slice(baseline), ['update', 'close', 'restore', 'restore', 'update', 'close']);
});

test('unreadable recovery history refuses safely without rewriting original history', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const receipt = await f.shared.start(id);
  await assert.rejects(f.shared.close(id, 'Public completion', receipt.token, { onTransition: context => {
    if (context.transition === 'step_recorded') throw new WorkspaceTransactionInterruptedError('Interrupt close');
  } }));
  const path = getHistoryPath(f.pmRoot, id); const saved = path + '.saved';
  renameSync(path, saved); mkdirSync(path);
  try {
    await assert.rejects(f.shared.close(id, 'Public completion', receipt.token), error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed' && /history/.test(error.remedy));
  } finally { rmdirSync(path); renameSync(saved, path); }
  assert.deepEqual(await f.shared.close(id, 'Public completion', receipt.token), { id, closed: true });
});

test('native item admission invokes its final ownership check before persistence', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const item = (await f.client.get(id, { depth: 'full' })).item;
  const before = durableSnapshot(f.pmRoot); let checked = 0;
  await assert.rejects(commitItemMutation({ id, item, options: { description: 'Refused write' } }, admitted => f.client.update(admitted.id, admitted.options), { pmRoot: f.pmRoot,
    beforeWrite: async () => { checked++; throw new SettingsRefusal('swarm_document_changed', 'Ownership changed before persistence.', 'document'); },
  }), error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed');
  assert.equal(checked, 1); assert.equal(durableSnapshot(f.pmRoot), before);
});

test('close transaction admission refuses stale foreign and private state before its journal', async t => {
  const f = await sharedFixture(t); const id = await f.item(['src/public.ts']); const receipt = await f.shared.start(id);
  for (const [note, token] of [['Public completion', 'bad'], ['Public completion', '9'], [encodeURIComponent(['', 'home', 'private', 'note'].join('/')), receipt.token]]) {
    const before = durableSnapshot(f.pmRoot);
    await assert.rejects(f.shared.close(id, note, token)); assert.equal(durableSnapshot(f.pmRoot), before);
  }
  await f.shared.close(id, 'Public completion', receipt.token);
  const before = durableSnapshot(f.pmRoot);
  await assert.rejects(f.shared.close(id, 'Different intent', receipt.token), StaleFenceError);
  assert.equal(durableSnapshot(f.pmRoot), before);
  const resource = (await f.client.create({ type: 'Task', title: 'Foreign resource', tags: 'swarm-resource' })).item.id;
  await assert.rejects(f.shared.close(resource, 'Public completion'), /Resource items/);
  const resourceState = durableSnapshot(f.pmRoot);
  await assert.rejects(f.shared.heartbeat(resource), /Resource items/);
  await assert.rejects(f.shared.handoff(resource, 'receiver', 'Public handoff'), /Resource items/);
  assert.equal(durableSnapshot(f.pmRoot), resourceState);
});

test('close preserves an independently reopened peer success on committed replay', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const receipt = await f.shared.start(id);
  await f.shared.close(id, 'Public completion', receipt.token);
  await f.client.update(id, { status: 'open' });
  const history = readFileSync(getHistoryPath(f.pmRoot, id), 'utf8');
  await assert.rejects(f.shared.close(id, 'Public completion', receipt.token), error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed');
  assert.equal(readFileSync(getHistoryPath(f.pmRoot, id), 'utf8'), history);
});

test('every SDK transaction boundary preserves a private peer edit without a partial-commit refusal', async t => {
  const f = await sharedFixture(t);
  for (let boundary = 0; boundary < 7; boundary++) await t.test(`private peer boundary ${boundary}`, async () => {
    const id = await f.item(); const receipt = await f.shared.start(id); let index = 0; let peerHistory = '';
    const title = encodeURIComponent(['', 'home', 'private', 'peer'].join('/'));
    const result = f.shared.close(id, 'Public completion', receipt.token, { onTransition: () => {
      if (index++ !== boundary) return;
      const peer = f.cli('--no-extensions', 'update', id, '--title', title, '--json'); assert.equal(peer.status, 0);
      peerHistory = readFileSync(getHistoryPath(f.pmRoot, id), 'utf8');
    } });
    if (boundary < 3) await assert.rejects(result, error => error instanceof SettingsRefusal && error.code === 'swarm_superseded');
    else assert.deepEqual(await result, { id, closed: true });
    assert.equal(readFileSync(getHistoryPath(f.pmRoot, id), 'utf8'), peerHistory);
    assert.equal((await f.client.get(id)).item.title, title);
  });
});

test('committed-close receipts refuse changed peer marker generation and ownership', async t => {
  const f = await sharedFixture(t);
  for (const field of ['swarm_close_transaction', 'swarm_token', 'assignee', 'swarm_handoff']) {
    const id = await f.item(); const receipt = await f.shared.start(id); let peerHistory = '';
    await assert.rejects(f.shared.close(id, 'Public completion', receipt.token, { onTransition: context => {
      if (context.transition !== 'committed') return;
      const flag = field === 'assignee' ? ['--assignee', 'peer'] : ['--field', `${field}=${field === 'swarm_token' ? '3' : 'peer'}`];
      const peer = f.cli('update', id, ...flag, '--json'); assert.equal(peer.status, 0, peer.stderr.replaceAll(f.repo, '[fixture]'));
      peerHistory = readFileSync(getHistoryPath(f.pmRoot, id), 'utf8');
    } }), error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed');
    assert.equal(readFileSync(getHistoryPath(f.pmRoot, id), 'utf8'), peerHistory);
    await assert.rejects(f.shared.close(id, 'Public completion', receipt.token), StaleFenceError);
    assert.equal(readFileSync(getHistoryPath(f.pmRoot, id), 'utf8'), peerHistory);
  }
});
