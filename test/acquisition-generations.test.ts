import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { getHistoryPath, getItemPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import type { PmClient } from '@unbrained/pm-cli/sdk';
import { fixture } from './helpers.ts';
import { sharedFixture } from './shared-helpers.ts';
import { loseReturn } from './native-return-faults.ts';
import { ITEM_MUTATION_BOUNDARIES, SettingsRefusal, withItemMutationObserver } from '../src/settings.ts';
import { START_TRANSITIONS, withStartTransitionObserver } from '../src/swarm.ts';
import { ResourceReservations, trackerResourceBackend } from '../index.ts';
import { prepareTerminalHistoryLane } from './history-aba-helpers.ts';
import { fixtureGit as git, snapshotGitResources as gitResources } from './git-helpers.ts';
import { gitEnvironment } from '../src/git-environment.ts';

/** Native content/history are compared byte-for-byte, excluding only ignored SDK read caches. */
function itemBytes(pmRoot: string, id: string): string[] {
  return [getItemPath(pmRoot, 'Task', id), getHistoryPath(pmRoot, id)].map(path => readFileSync(path, 'utf8'));
}

/** Keep peer SDK requests outside the failed caller's admission and hook scopes. */
function generationPeer(client: PmClient) {
  const request = new AsyncResource('independent-generation-peer'); const update = client.update.bind(client);
  return { advance: (id: string, token: string) => request.runInAsyncScope(() => update(id, { field: [`swarm_token=${token}`] })), destroy: () => request.emitDestroy() };
}

/** Preserve exact integer generations above the safe-number ceiling as well as ordinary counters. */
let state = 0xf37c9a21;
function advancedToken(base = 7n): string {
  state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
  return (base + BigInt(state >>> 0) + 9007199254740993n).toString();
}

/** Supersession has a stable SDK refusal and an explicit preservation remedy. */
function superseded(error: unknown): boolean { return error instanceof SettingsRefusal && error.code === 'swarm_superseded' && error.remedy.includes('Preserve'); }

/** A real lost return must preserve the exact independent peer successor. */
async function preservesLostClaim(f: Awaited<ReturnType<typeof sharedFixture>>, id: string, transition: () => Promise<unknown>): Promise<void> {
  let successor: string[] = [];
  const interrupted = loseReturn(f.client, 'update', 1, async () => { await transition(); successor = itemBytes(f.pmRoot, id); });
  try {
    const [attempt] = await Promise.allSettled([f.shared.start(id)]);
    assert.deepEqual(itemBytes(f.pmRoot, id), successor); assert.ok(attempt.status === 'rejected'); assert.ok(superseded(attempt.reason));
  }
  finally { interrupted.restore(); }
  assert.equal(interrupted.injected(), true); assert.deepEqual(itemBytes(f.pmRoot, id), successor);
}

for (const kind of ['shared', 'resource', 'Git claim', 'Git publication'] as const) test(`${kind} lost return preserves a same-author peer generation`, async t => {
  const lane = kind.startsWith('Git') ? await fixture(t) : undefined; const shared = lane === undefined ? await sharedFixture(t) : undefined;
  const f = lane ?? shared!; const id = kind === 'resource' ? (await f.client.create({ type: 'Task', title: 'Public resource', tags: 'swarm-resource' })).item.id : await f.item(); lane?.save();
  const peer = generationPeer(f.client); t.after(peer.destroy); let bytes: string[] = []; let refs = '';
  const fault = loseReturn(f.client, kind === 'Git claim' ? 'claim' : 'update', 1, async () => {
    await peer.advance(id, '9'); bytes = itemBytes(f.pmRoot, id);
    if (lane !== undefined) refs = git(lane.repo, ['for-each-ref', '--format=%(refname) %(objectname)']);
  }); t.after(fault.restore);
  const resources = shared === undefined ? undefined : new ResourceReservations(trackerResourceBackend(shared.shared.engine), 'shared-test');
  const [attempt] = await Promise.allSettled([lane !== undefined ? lane.swarm.start(id) : kind === 'resource' ? resources!.reserve(id) : shared!.shared.start(id)]);
  assert.equal(fault.injected(), true); assert.deepEqual(itemBytes(f.pmRoot, id), bytes);
  assert.equal((await f.client.get(id)).item.swarm_token, '9'); assert.equal((await f.client.get(id)).item.assignee, lane === undefined ? 'shared-test' : 'swarm-test');
  if (lane !== undefined) assert.equal(git(lane.repo, ['for-each-ref', '--format=%(refname) %(objectname)']), refs);
  assert.ok(attempt.status === 'rejected'); assert.ok(superseded(attempt.reason));
});

test('an independent process advances generation before a lost shared SDK return', async t => {
  const f = await sharedFixture(t); const id = await f.item();
  await preservesLostClaim(f, id, async () => {
    const result = spawnSync(process.execPath, [f.host, 'update', id, '--field', 'swarm_token=9', '--author', 'shared-test', '--json'], { cwd: f.repo, env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
  assert.equal((await f.client.get(id)).item.assignee, 'shared-test');
});

for (const command of ['start', 'next', 'schedule'] as const) test(`${command} preserves random peer generations at every Git acquisition boundary`, async t => {
  const f = await fixture(t); const peer = generationPeer(f.client); t.after(peer.destroy);
  for (const boundary of START_TRANSITIONS) await t.test(boundary, async () => {
    const id = await f.item([`src/${command}-${boundary}.ts`]); await f.client.update(id, { field: ['swarm_token=7'] }); f.save();
    const token = advancedToken(); let bytes: string[] = []; let resources: string[] = []; let injected = false;
    const operation: () => Promise<unknown> = { start: () => f.swarm.start(id), next: () => f.swarm.next(), schedule: () => f.swarm.schedule({ skills: [] }) }[command];
    await assert.rejects(withStartTransitionObserver(async step => {
      if (step !== boundary) return;
      injected = true; await peer.advance(id, token); bytes = itemBytes(f.pmRoot, id); resources = gitResources(f.repo); throw new Error('Lost acquisition step result');
    }, operation), superseded);
    assert.equal(injected, true); assert.deepEqual(itemBytes(f.pmRoot, id), bytes); assert.deepEqual(gitResources(f.repo), resources);
  });
});

test('one non-git tracker preserves random generations after lost returns and at every cleanup admission boundary', async t => {
  const f = await sharedFixture(t); const peer = generationPeer(f.client); t.after(peer.destroy); let cases = 0;
  for (const kind of ['start', 'next', 'schedule', 'resource'] as const) for (const boundary of ['return', ...ITEM_MUTATION_BOUNDARIES] as const) await t.test(`${kind}:${boundary}`, async () => {
    const id = kind === 'resource' ? (await f.client.create({ type: 'Task', title: 'Random resource', tags: 'swarm-resource' })).item.id : await f.item([`src/shared-${cases}.ts`]);
    const token = advancedToken(1n); let bytes: string[] = []; let injected = false;
    const advance = async () => { injected = true; await peer.advance(id, token); bytes = itemBytes(f.pmRoot, id); };
    const fault = loseReturn(f.client, 'update', 1, boundary === 'return' ? advance : undefined);
    try {
      const resources = new ResourceReservations(trackerResourceBackend(f.shared.engine), 'shared-test');
      const operation = () => kind === 'start' ? f.shared.start(id) : kind === 'next' ? f.shared.next() : kind === 'schedule' ? f.shared.schedule({ skills: [] }) : resources.reserve(id);
      await assert.rejects(withItemMutationObserver(async step => { if (boundary !== 'return' && fault.injected() && !injected && step === boundary) await advance(); }, operation), superseded);
    } finally { fault.restore(); }
    assert.equal(injected, true); assert.deepEqual(itemBytes(f.pmRoot, id), bytes); cases++;
  });
  console.log(JSON.stringify({ generation_seed: '0xf37c9a21', non_git_cases: cases, peer_claims_cleared: 0 }));
});

for (const phase of ['branch_created', 'published'] as const) test(`Git ${phase} cleanup rechecks random generations at every native commit admission boundary`, async t => {
  const f = await fixture(t); const peer = generationPeer(f.client); t.after(peer.destroy);
  for (const boundary of ITEM_MUTATION_BOUNDARIES) await t.test(boundary, async () => {
    const id = await f.item([`src/${phase}-${boundary}.ts`]); await f.client.update(id, { field: ['swarm_token=7'] }); f.save();
    const token = advancedToken(); let failed = false; let injected = false; let bytes: string[] = []; let resources: string[] = [];
    const fault = phase === 'published' ? loseReturn(f.client, 'update', 1, async () => { failed = true; }) : undefined;
    try {
      await assert.rejects(withItemMutationObserver(async step => {
        if (!failed || injected || step !== boundary) return;
        injected = true; await peer.advance(id, token); bytes = itemBytes(f.pmRoot, id); resources = gitResources(f.repo);
      }, () => withStartTransitionObserver(step => { if (phase === 'branch_created' && step === phase) { failed = true; throw new Error('Lost branch result'); } }, () => f.swarm.start(id))), superseded);
    } finally { fault?.restore(); }
    assert.equal(injected, true); assert.deepEqual(itemBytes(f.pmRoot, id), bytes); assert.deepEqual(gitResources(f.repo), resources);
  });
});

test('a token ABA remains peer-owned even when its final spelling matches the acquired token', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const peer = generationPeer(f.client); t.after(peer.destroy);
  await preservesLostClaim(f, id, async () => { await peer.advance(id, advancedToken(1n)); await peer.advance(id, '1'); });
});

for (const resource of [false, true]) test(`a nested native writer cannot replace the ${resource ? 'resource' : 'shared'} acquisition generation proof`, async t => {
  const f = await sharedFixture(t); const id = resource ? (await f.client.create({ type: 'Task', title: 'Nested writer resource', tags: 'swarm-resource' })).item.id : await f.item();
  const update = f.client.update.bind(f.client); let bytes: string[] = [];
  const fault = loseReturn(f.client, 'update', 1, async () => { await update(id, { field: ['swarm_token=9'] }); bytes = itemBytes(f.pmRoot, id); }); t.after(fault.restore);
  const backend = new ResourceReservations(trackerResourceBackend(f.shared.engine), 'shared-test');
  const [attempt] = await Promise.allSettled([resource ? backend.reserve(id) : f.shared.start(id)]);
  assert.deepEqual(itemBytes(f.pmRoot, id), bytes); assert.ok(attempt.status === 'rejected'); assert.ok(superseded(attempt.reason));
});

test('a pre-existing Git claim reports superseded when its generation changes during the claim read', async t => {
  const f = await fixture(t); const id = await f.item(); await f.client.claim(id); await f.client.update(id, { field: ['swarm_token=7'] }); f.save(); let bytes: string[] = [];
  const [attempt] = await Promise.allSettled([withStartTransitionObserver(async step => { if (step === 'claimed') { await f.client.update(id, { field: ['swarm_token=9'] }); bytes = itemBytes(f.pmRoot, id); } }, () => f.swarm.start(id))]);
  assert.deepEqual(itemBytes(f.pmRoot, id), bytes); assert.ok(attempt.status === 'rejected'); assert.ok(superseded(attempt.reason));
});

test('a peer document edit inside Git cleanup admission preserves the branch and its content', async t => {
  const f = await fixture(t); const id = await f.item(); f.save(); const request = new AsyncResource('cleanup-content-peer'); t.after(() => request.emitDestroy()); let failed = false; let edited = false;
  await assert.rejects(withItemMutationObserver(async boundary => {
    if (!failed || edited || boundary !== 'before_commit') return;
    edited = true; await request.runInAsyncScope(() => f.client.update(id, { title: 'Public cleanup peer' }));
  }, () => withStartTransitionObserver(step => { if (step === 'branch_created') { failed = true; throw new Error('Lost branch result'); } }, () => f.swarm.start(id))), error => error instanceof SettingsRefusal && error.code === 'swarm_superseded' && error.field === 'history');
  const item = (await f.client.get(id)).item; assert.equal(item.title, 'Public cleanup peer'); assert.equal(item.assignee, undefined);
  assert.equal(git(f.repo, ['branch', '--list', `swarm/${id}`]).length > 0, true);
});

test('SDK-locked Git cleanup records no extra item mutation or history entry', async t => {
  const f = await fixture(t);
  for (const boundary of ['branch_created', 'configured'] as const) await t.test(boundary, async () => {
    const id = await f.item(); f.save(); const before = (await readHistoryEntries(getHistoryPath(f.pmRoot, id), id)).length;
    await assert.rejects(withStartTransitionObserver(step => { if (step === boundary) throw new Error('Lost Git acquisition result'); }, () => f.swarm.start(id)), /Lost Git acquisition result/);
    const history = await readHistoryEntries(getHistoryPath(f.pmRoot, id), id);
    assert.deepEqual(history.slice(before).map(entry => entry.op), ['claim', 'release']);
  });
});

test('SDK close compensation preserves peer generations before either reverse mutation', async t => {
  const f = await sharedFixture(t);
  for (const boundary of ['step_recorded', 'committing'] as const) await t.test(boundary, async () => {
    const id = await f.item(); const claim = await f.shared.start(id); let failed = false; let attempted = false; let replaced = false; let bytes: string[] = [];
    const [attempt] = await Promise.allSettled([f.shared.close(id, 'Public close generation', claim.token, { onTransition: async context => {
      if (!failed && context.transition === boundary) { failed = true; throw new Error('Force SDK compensation'); }
      if (!attempted && context.transition === 'step_compensating') {
        attempted = true;
        const peer = spawnSync(process.execPath, [f.host, 'update', id, '--assignee', 'shared-test', '--field', `swarm_token=${advancedToken(2n)}`, '--author', 'shared-test', '--json'], { cwd: f.repo, env: { ...f.env, PM_LOCK_WAIT_MS: '0' }, encoding: 'utf8', timeout: 10000 });
        assert.equal(peer.error, undefined);
        if (peer.status === 0) { replaced = true; bytes = itemBytes(f.pmRoot, id); }
        else assert.match(peer.stdout + peer.stderr, /locked|lock_held|contention/i);
      }
    } })]);
    assert.equal(attempted, true); assert.ok(attempt.status === 'rejected');
    if (replaced) { assert.deepEqual(itemBytes(f.pmRoot, id), bytes); assert.ok(superseded(attempt.reason)); }
    else { const restored = (await f.client.get(id)).item; assert.equal(restored.assignee, 'shared-test'); assert.equal(restored.swarm_token, claim.token); }
    console.log(JSON.stringify({ compensation_boundary: boundary, peer_outcome: replaced ? 'advanced_and_preserved' : 'blocked_by_sdk_lock' }));
  });
});

for (const phase of ['acquisition', 'reap'] as const) test(`the native item lock excludes an independent peer throughout Git cleanup (${phase})`, async t => {
  const f = await fixture(t); const id = await f.item(); f.save(); const host = join(import.meta.dirname, '../node_modules/.bin/pm');
  const env = gitEnvironment({ ...process.env, PM_PATH: f.pmRoot, PM_SOURCE_WORKSPACE_ROOT: f.repo, PM_SOURCE_PM_PATH: f.pmRoot, PM_GLOBAL_PATH: join(f.root, 'global-pm'), PM_LOCK_WAIT_MS: '0' });
  const args = [host, 'update', id, '--assignee', 'swarm-test', '--field', 'swarm_token=9', '--author', 'swarm-test', '--json'];
  if (phase === 'reap') { await f.swarm.start(id); await f.client.update(id, { status: 'closed', message: 'Terminal cleanup fixture completed' }); }
  const nativeSpawn = childProcess.spawnSync; let attempted = false; let peerStatus: number | null = null; let diagnostics = ''; let peerResources: string[] = [];
  const observation = t.mock.method(childProcess, 'spawnSync', new Proxy(nativeSpawn, { apply(target, receiver, input: unknown[]) {
    if (!attempted && input[0] === 'git' && (input[1] as string[]).includes('--unset') && (input[1] as string[]).some(value => value.startsWith('swarm.lane.'))) {
      attempted = true;
      const peer = nativeSpawn(process.execPath, args, { cwd: f.repo, env, encoding: 'utf8', timeout: 10000 });
      assert.equal(peer.error, undefined); peerStatus = peer.status; diagnostics = peer.stdout + peer.stderr;
      if (peer.status === 0) peerResources = gitResources(f.repo);
    }
    return Reflect.apply(target, receiver, input);
  } })); syncBuiltinESMExports();
  let attempt: PromiseSettledResult<unknown>;
  try { [attempt] = await Promise.allSettled([phase === 'reap' ? f.swarm.reap() : withStartTransitionObserver(step => { if (step === 'configured') throw new Error('Lost Git acquisition result'); }, () => f.swarm.start(id))]); }
  finally { observation.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(attempted, true);
  if (peerStatus === 0) assert.deepEqual(gitResources(f.repo), peerResources, 'cleanup deleted a superseding peer generation');
  assert.notEqual(peerStatus, 0); assert.match(diagnostics, /locked|lock_held|contention/i);
  if (phase === 'acquisition') { assert.ok(attempt.status === 'rejected'); assert.match(String(attempt.reason), /Lost Git acquisition result/); } else assert.equal(attempt.status, 'fulfilled');
  const retry = nativeSpawn(process.execPath, args, { cwd: f.repo, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(retry.status, 0, retry.stdout + retry.stderr); assert.equal((await f.client.get(id)).item.swarm_token, '9');
  console.log(JSON.stringify({ git_cleanup_peer_blocked: true, peer_retry_succeeded: true }));
});

for (const phase of ['acquisition', 'reap'] as const) test(`Git configuration cleanup compares its value atomically against an independent writer (${phase})`, async t => {
  const f = await fixture(t); const id = await f.item(); f.save(); const key = `swarm.lane.${id}`; let replaced = false;
  if (phase === 'reap') { await f.swarm.start(id); await f.client.update(id, { status: 'closed', message: 'Terminal cleanup fixture completed' }); }
  const run = childProcess.spawnSync;
  const hook = t.mock.method(childProcess, 'spawnSync', new Proxy(run, { apply(target, receiver, inputs: unknown[]) {
    const command = inputs[1] as string[];
    if (!replaced && inputs[0] === 'git' && command.includes('--unset') && command.includes(key)) {
      replaced = true; const result = run('git', ['config', '--local', key, 'peer-owned-lane'], { cwd: f.repo, env: gitEnvironment(), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    return Reflect.apply(target, receiver, inputs);
  } })); syncBuiltinESMExports();
  try { await assert.rejects(phase === 'reap' ? f.swarm.reap() : withStartTransitionObserver(step => { if (step === 'configured') throw new Error('Lost configuration result'); }, () => f.swarm.start(id))); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(replaced, true); assert.equal(git(f.repo, ['config', '--local', '--get', key]), 'peer-owned-lane');
  assert.equal((await f.client.get(id)).item.assignee, undefined);
});

for (const mode of ['Git', 'shared'] as const) test(`${mode} terminal cleanup rechecks the generation at every native admission boundary`, async t => {
  const f = mode === 'Git' ? await fixture(t) : await sharedFixture(t);
  const engine = 'swarm' in f ? f.swarm : f.shared; const peer = generationPeer(f.client); t.after(peer.destroy);
  for (const boundary of ITEM_MUTATION_BOUNDARIES) await t.test(boundary, async () => {
    const id = await f.item([`src/reap-${boundary}.ts`]);
    await prepareTerminalHistoryLane(f, id);
    let injected = false; let bytes: string[] = []; let resources: string[] = [];
    await assert.rejects(withItemMutationObserver(async step => {
      if (injected || step !== boundary) return; injected = true; await peer.advance(id, advancedToken());
      bytes = itemBytes(f.pmRoot, id); if ('swarm' in f) resources = gitResources(f.repo);
    }, () => engine.reap()), superseded);
    assert.equal(injected, true); assert.deepEqual(itemBytes(f.pmRoot, id), bytes);
    if ('swarm' in f) assert.deepEqual(gitResources(f.repo), resources);
    await f.client.release(id, { author: mode === 'Git' ? 'swarm-test' : 'shared-test' });
    if ('swarm' in f) await f.swarm.reap();
  });
});
