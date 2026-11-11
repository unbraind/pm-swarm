import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { getHistoryPath, getItemPath } from '@unbrained/pm-cli/sdk';
import { SettingsRefusal } from '../src/settings.ts';
import { CLOSE_INTENT } from '../src/close-journal.ts';
import { sharedFixture } from './shared-helpers.ts';
import { blockedDependent, closeClaim } from './close-native-helpers.ts';
import { installCloseTailProbe, rejectNativeClose, traceCloseTail } from './close-tail-helpers.ts';

/** Native storage errors and scalar rejections must produce a recoverable typed outcome. */
const FAULTS = [
  ...['EIO', 'ENOSPC', 'EACCES'].map(code => ({ name: code, value: () => Object.assign(new Error(`${code}: Injected storage fault`), { code }) })),
  { name: 'scalar', value: () => 'Injected scalar fault' },
  { name: 'undefined', value: () => undefined },
];
/** Prepare native hooks and a real claim before arming filesystem diagnostics. */
async function observedClaim(t: Parameters<typeof sharedFixture>[0], warnings = false) {
  const f = await sharedFixture(t); installCloseTailProbe(f); const { id, claim } = await closeClaim(f);
  if (warnings) { const dependent = await blockedDependent(f, id); writeFileSync(getHistoryPath(f.pmRoot, dependent), '{foreign unreadable history}\n'); }
  return { f, id, token: claim.token, before: readFileSync(getItemPath(f.pmRoot, 'Task', id), 'utf8') };
}
/** Reconcile after fault removal and require a stable native success or exact native compensation. */
async function converges(f: Awaited<ReturnType<typeof sharedFixture>>, id: string, token: string, before: string) {
  const view = await f.client.get(id, { depth: 'full' });
  const committed = view.item[CLOSE_INTENT] !== undefined && JSON.parse(String(view.item[CLOSE_INTENT])).phase === 'committed';
  const history = getHistoryPath(f.pmRoot, id);
  if (committed) assert.equal((await f.shared.close(id, 'Public completion', token)).closed, true);
  else {
    await assert.rejects(f.shared.close(id, 'Public completion', token), { code: 'swarm_close_compensated' });
    assert.equal(readFileSync(getItemPath(f.pmRoot, 'Task', id), 'utf8'), before);
  }
  const stable = readFileSync(history, 'utf8');
  if (committed) await f.shared.close(id, 'Public completion', token);
  else await assert.rejects(f.shared.close(id, 'Public completion', token), { code: 'swarm_close_compensated' });
  assert.equal(readFileSync(history, 'utf8'), stable);
}
/** Host diagnostics must never echo raw thrown storage errors. */
function typed(error: unknown): boolean { return error instanceof SettingsRefusal && !error.remedy.includes('Injected'); }
/** Restore native functions before checking durable convergence after an injected tail failure. */
async function assertTailFault(probe: ReturnType<typeof traceCloseTail>, fixture: Awaited<ReturnType<typeof observedClaim>>) {
  try { await assert.rejects(probe.close(fixture.token), typed); } finally { probe.restore(); }
  assert.equal(probe.state.injected, true); await converges(fixture.f, fixture.id, fixture.token, fixture.before);
}

test('every post-native lease and receipt operation converges after each storage-fault style', async t => {
  let events: string[] = [];
  await t.test('enumerate real operations', async child => {
    const { f, id, token } = await observedClaim(child, true); const probe = traceCloseTail(child, f, id);
    try { await probe.close(token); } finally { probe.restore(); }
    events = probe.state.events; assert.equal(probe.state.committed, true);
    assert.ok(events.includes('tokens.delete')); assert.ok(events.includes('unlinkSync:operation.json')); assert.ok(events.includes('unlinkSync:operation-pin.json'));
    assert.ok(events.some(event => event.startsWith('warnings.')));
  });
  for (const [index, event] of events.entries()) for (const fault of FAULTS) await t.test(`${index}/${event}/${fault.name}`, async child => {
    const fixture = await observedClaim(child, true);
    await assertTailFault(traceCloseTail(child, fixture.f, fixture.id, { index, value: fault.value }), fixture);
  });
  console.log(JSON.stringify({ post_native_operations: events.length, fault_styles: FAULTS.length, injected_cases: events.length * FAULTS.length }));
});

test('renewal failure while awaiting a native return compensates every owned effect', { timeout: 120000 }, async t => {
  for (const fault of FAULTS) await t.test(fault.name, async child => {
    const fixture = await observedClaim(child);
    await assertTailFault(traceCloseTail(child, fixture.f, fixture.id, { index: event => event === 'renameSync:operation.json.temporary', value: fault.value }, false, () => delay(5200)), fixture);
  });
});

for (const after of [false, true]) test(`ordinary native promise rejection ${after ? 'after' : 'before'} close compensates the durable intent`, async t => {
  for (const fault of FAULTS) await t.test(fault.name, async child => {
    const { f, id, token, before } = await observedClaim(child);
    await assert.rejects(rejectNativeClose(f, fault.value, after).close(id, 'Public completion', token), { code: 'swarm_close_compensated' });
    await converges(f, id, token, before);
  });
});

test('pre-intent filesystem faults preserve native state and report an uncommitted close', async t => {
  for (const fault of FAULTS) await t.test(fault.name, async child => {
    const { f, id, token, before } = await observedClaim(child); const history = readFileSync(getHistoryPath(f.pmRoot, id), 'utf8');
    const probe = traceCloseTail(child, f, id, { index: 0, value: fault.value }, true);
    try { await assert.rejects(probe.close(token), error => typed(error) && (error as SettingsRefusal).code === 'swarm_close_not_committed'); } finally { probe.restore(); }
    assert.equal(probe.state.injected, true); assert.equal(probe.state.committed, false);
    assert.equal(readFileSync(getItemPath(f.pmRoot, 'Task', id), 'utf8'), before); assert.equal(readFileSync(getHistoryPath(f.pmRoot, id), 'utf8'), history);
  });
});
