import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { getHistoryPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { SettingsRefusal } from '../src/settings.ts';
import { StaleFenceError } from '../src/lease.ts';
import { CloseRecoveryUnsupported } from '../src/close.ts';
import { sharedFixture } from './shared-helpers.ts';
import { blockedDependent, closeClaim } from './close-native-helpers.ts';
import { durableSnapshot } from './privacy-snapshot.ts';
import { installCloseTailProbe, rejectNativeClose, traceCloseTail } from './close-tail-helpers.ts';

/** Real storage errno failures and a scalar throw must never become an untyped close result. */
const FAULTS = [
  ...['EIO', 'ENOSPC', 'EACCES'].map(code => ({ name: code, value: () => Object.assign(new Error(`${code}: Injected storage fault`), { code }) })),
  { name: 'non-Error', value: () => 'Injected scalar fault' },
  { name: 'undefined rejection', value: () => undefined },
];
/** Activate the native observer before acquiring the real claim used by a fault case. */
async function observedClaim(t: Parameters<typeof sharedFixture>[0]) {
  const f = await sharedFixture(t); installCloseTailProbe(f); return { f, ...await closeClaim(f) };
}
/** Exercise warning iteration during both native result validation and final lease receipt admission. */
async function warnedClaim(t: Parameters<typeof sharedFixture>[0]) {
  const { f, id, claim } = await observedClaim(t); const dependent = await blockedDependent(f, id);
  writeFileSync(getHistoryPath(f.pmRoot, dependent), '{foreign unreadable history}\n');
  return { f, id, token: claim.token };
}
/** Verify both the truthful native outcome and the immutable no-replay contract after a failure. */
async function assertOutcome(f: Awaited<ReturnType<typeof sharedFixture>>, id: string, committed: boolean): Promise<void> {
  assert.equal((await f.client.get(id)).item.status, committed ? 'closed' : 'open');
  const history = await readHistoryEntries(getHistoryPath(f.pmRoot, id), id); assert.equal(history.filter(entry => entry.op === 'close').length, committed ? 1 : 0);
}
/** Expected diagnostics always name the selected item and native journal without leaking the injected error. */
function remedy(id: string, committed: boolean) {
  return (error: unknown) => error instanceof SettingsRefusal && error.code === (committed ? 'swarm_close_recovery_unsupported' : 'swarm_close_not_committed')
    && error.remedy.includes(id) && error.remedy.includes(`history/${id}.jsonl`) && !error.remedy.includes('Injected') && (!committed || /native close committed/i.test(error.remedy) || !error.remedy.includes('#after='));
}

test('every observed post-commit operation returns a truthful typed close refusal on every storage fault', async t => {
  let events: string[] = [];
  await t.test('enumerate the real completion path', async child => {
    const { f, id, token } = await warnedClaim(child); const probe = traceCloseTail(child, f, id);
    try { await probe.close(token); } finally { probe.restore(); }
    assert.equal(probe.state.committed, true); events = probe.state.events; console.log(JSON.stringify({ baseline_events: events }));
    assert.ok(events.includes('tokens.delete')); assert.ok(events.filter(event => event === 'renameSync:agent.json.temporary').length === 2);
    assert.ok(events.some(event => event === 'unlinkSync:operation.json')); assert.ok(events.some(event => event === 'unlinkSync:operation-pin.json'));
    assert.ok(events.filter(event => event === 'warnings.entries').length >= 2); await assertOutcome(f, id, true);
  });
  assert.ok(events.length > 0);
  for (const [index, event] of events.entries()) for (const fault of FAULTS) await t.test(`${index}/${event}/${fault.name}`, async child => {
    const { f, id, token } = await warnedClaim(child); const probe = traceCloseTail(child, f, id, { index, value: fault.value });
    try { await assert.rejects(probe.close(token), remedy(id, true)); } finally { probe.restore(); }
    assert.equal(probe.state.injected, true); assert.deepEqual(probe.state.events.slice(0, index + 1), events.slice(0, index + 1)); await assertOutcome(f, id, true);
    const before = durableSnapshot(f.pmRoot);
    await assert.rejects(f.shared.close(id, 'Retry after storage fault', token), remedy(id, true));
    assert.equal(durableSnapshot(f.pmRoot), before); await assertOutcome(f, id, true);
  });
  console.log(JSON.stringify({ post_commit_operations: events.length, synchronous_fault_styles: FAULTS.length, injected_cases: events.length * FAULTS.length }));
});

test('final lease heartbeat failure reports the committed close and its native journal', async t => {
  const { f, id, claim } = await observedClaim(t); let heartbeats = 0;
  const probe = traceCloseTail(t, f, id, { index: event => event === 'renameSync:agent.json.temporary' && ++heartbeats === 2, value: FAULTS[0].value });
  try {
    await assert.rejects(probe.close(claim.token), error => error instanceof CloseRecoveryUnsupported && error.committed === true && remedy(id, true)(error));
  } finally { probe.restore(); assert.equal(probe.state.injected, true); await assertOutcome(f, id, true); }
});

test('lease renewal failures during an awaited native return retain the committed close', async t => {
  for (const fault of FAULTS) await t.test(fault.name, async child => {
    const { f, id, claim } = await observedClaim(child);
    const probe = traceCloseTail(child, f, id, { index: event => event === 'renameSync:operation.json.temporary', value: fault.value }, false, () => delay(5200));
    try { await assert.rejects(probe.close(claim.token), remedy(id, true)); }
    finally { probe.restore(); assert.equal(probe.state.injected, true); await assertOutcome(f, id, true); }
  });
});

test('error-only empty-runtime cleanup cannot hide a committed legacy native close', async t => {
  for (const fault of FAULTS) await t.test(fault.name, async child => {
    const f = await sharedFixture(child); installCloseTailProbe(f); const id = await f.item(); await f.client.claim(id);
    let publication = false; let cleanup = false;
    const probe = traceCloseTail(child, f, id, { index: event => {
      if (event === 'renameSync:agent.json.temporary') { publication = true; return true; }
      if (event === 'rmdirSync:swarm') { cleanup = true; return true; }
      return false;
    }, value: () => cleanup ? fault.value() : new Error('Injected initial heartbeat fault') });
    try { await assert.rejects(probe.close(), remedy(id, true)); }
    finally { probe.restore(); assert.equal(publication, true); assert.equal(cleanup, true); await assertOutcome(f, id, true); }
  });
});

for (const committed of [false, true]) test(`native promise rejection ${committed ? 'after' : 'before'} commit retains the exact outcome and typed remedy`, async t => {
  for (const fault of [...FAULTS, { name: 'promise object rejection', value: () => ({ rejected: 'Injected promise fault' }) }]) await t.test(fault.name, async child => {
    const f = await sharedFixture(child); const { id, claim } = await closeClaim(f); const history = readFileSync(getHistoryPath(f.pmRoot, id), 'utf8');
    await assert.rejects(rejectNativeClose(f, fault.value, committed).close(id, 'Public completion', claim.token), remedy(id, committed));
    await assertOutcome(f, id, committed); if (!committed) assert.equal(readFileSync(getHistoryPath(f.pmRoot, id), 'utf8'), history);
  });
});

test('pre-commit filesystem faults keep the native item open with a distinct typed remedy', async t => {
  for (const fault of FAULTS) await t.test(fault.name, async child => {
    const { f, id, claim } = await observedClaim(child); const history = readFileSync(getHistoryPath(f.pmRoot, id), 'utf8');
    const probe = traceCloseTail(child, f, id, { index: 0, value: fault.value }, true);
    try { await assert.rejects(probe.close(claim.token), remedy(id, false)); } finally { probe.restore(); }
    assert.equal(probe.state.injected, true); assert.equal(probe.state.committed, false); await assertOutcome(f, id, false);
    assert.equal(readFileSync(getHistoryPath(f.pmRoot, id), 'utf8'), history);
  });
  const f = await sharedFixture(t); const { id, claim } = await closeClaim(f);
  await assert.rejects(rejectNativeClose(f, () => new StaleFenceError(id), false).close(id, 'Public completion', claim.token), StaleFenceError);
  await assertOutcome(f, id, false);
});
