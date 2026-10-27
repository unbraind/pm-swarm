import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs, { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fixture } from './helpers.ts';
import { fixtureGit as git } from './git-helpers.ts';
import { branchExists } from '../src/git.ts';
import { START_TRANSITIONS, withStartTransitionObserver } from '../src/swarm.ts';

test('Git start releases its newly acquired claim when the following real SDK read fails', async t => {
  const f = await fixture(t); const id = await f.item(); f.save();
  let claimed = false; let failed = false;
  const claim = f.client.claim.bind(f.client); const get = f.client.get.bind(f.client);
  f.client.claim = new Proxy(claim, { async apply(target, receiver, args: unknown[]) { const result: unknown = await Reflect.apply(target, receiver, args); claimed = true; return result; } });
  f.client.get = async (...args) => { if (claimed && !failed) { failed = true; throw new Error('Injected post-claim read failure'); } return get(...args); };
  await assert.rejects(f.swarm.start(id), /Injected post-claim read failure/);
  assert.equal(failed, true); assert.equal((await get(id)).claim_state?.claimed, false);
  assert.equal(branchExists(f.repo, `swarm/${id}`), false);
});

for (const command of ['start', 'next', 'schedule'] as const) test(`${command} cleans every acquired resource after each real Git start boundary`, async t => {
  const f = await fixture(t);
  for (const boundary of START_TRANSITIONS) await t.test(boundary, async () => {
    const id = await f.item(['src/public.ts']); f.save();
    let observed = false;
    const operation = () => command === 'start' ? f.swarm.start(id) : command === 'next' ? f.swarm.next() : f.swarm.schedule({ skills: [] });
    await assert.rejects(withStartTransitionObserver(transition => { if (transition === boundary) { observed = true; throw new Error('Injected start boundary failure'); } }, operation), /Injected start boundary failure/);
    assert.equal(observed, true);
    const current = await f.client.get(id, { depth: 'full' });
    assert.equal(current.item.assignee, undefined);
    for (const key of ['swarm_branch', 'swarm_base', 'swarm_base_ref']) assert.equal(current.item[key], undefined, key);
    assert.equal(branchExists(f.repo, `swarm/${id}`), false);
    assert.equal(existsSync(join(f.root, '.pm-swarm', `repo-${id}`)), false);
    assert.equal(git(f.repo, ['config', '--local', '--list']).includes(`swarm.lane.${id}=`), false);
    // Remove from automatic selection without erasing any immutable history.
    await f.client.update(id, { status: 'canceled' });
  });
});

test('failed start preserves a pre-existing native claim at every later boundary', async t => {
  const f = await fixture(t);
  for (const boundary of START_TRANSITIONS) {
    const id = await f.item(); await f.client.claim(id); f.save();
    await assert.rejects(withStartTransitionObserver(transition => { if (transition === boundary) throw new Error('Injected existing-claim failure'); }, () => f.swarm.start(id)), /Injected existing-claim failure/);
    assert.equal((await f.client.get(id)).item.assignee, 'swarm-test');
    assert.equal(branchExists(f.repo, `swarm/${id}`), false);
  }
});

test('start cleanup never releases a peer replacement, including same-author ABA claims', async t => {
  const f = await fixture(t);
  for (const author of ['peer', 'swarm-test']) {
    const id = await f.item(); f.save();
    await assert.rejects(withStartTransitionObserver(async transition => {
      if (transition !== 'claimed') return;
      await f.client.release(id); await f.client.claim(id, { author });
      throw new Error('Injected peer ownership transition');
    }, () => f.swarm.start(id)), /cleanup could not be verified/);
    assert.equal((await f.client.get(id)).item.assignee, author);
  }
});

test('a peer content edit survives claim cleanup without leaving the failed start assigned', async t => {
  const f = await fixture(t); const id = await f.item(); f.save();
  await assert.rejects(withStartTransitionObserver(async transition => {
    if (transition !== 'claimed') return;
    await f.client.update(id, { title: 'Public peer edit' }); throw new Error('Injected read boundary');
  }, () => f.swarm.start(id)), /Injected read boundary/);
  const current = (await f.client.get(id)).item;
  assert.equal(current.title, 'Public peer edit'); assert.equal(current.assignee, undefined);
});

for (const command of ['start', 'next', 'schedule'] as const) test(`${command} retains cleanup through every post-write heartbeat including final receipt`, async t => {
  const f = await fixture(t);
  for (const stage of ['claim', 'publication', 'receipt']) await t.test(stage, async () => {
    const id = await f.item(); f.save(); let gate = stage === 'claim'; let injected = false;
    const original = fs.renameSync;
    const observation = t.mock.method(fs, 'renameSync', new Proxy(original, { apply(target, receiver, args: unknown[]) {
      if (gate && !injected && String(args[1]).includes('agent-')) { injected = true; throw new Error('Injected post-write heartbeat failure'); }
      return Reflect.apply(target, receiver, args);
    } })); syncBuiltinESMExports();
    try {
      await assert.rejects(withStartTransitionObserver(transition => {
        if (stage === 'publication' && transition === 'configured' || stage === 'receipt' && transition === 'receipt') gate = true;
      }, () => command === 'start' ? f.swarm.start(id) : command === 'next' ? f.swarm.next() : f.swarm.schedule({ skills: [] })), /Injected post-write heartbeat failure/);
    } finally { observation.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(injected, true);
    const item = (await f.client.get(id)).item;
    assert.equal(item.assignee, undefined); assert.equal(item.swarm_branch, undefined);
    assert.equal(branchExists(f.repo, `swarm/${id}`), false);
    assert.equal(existsSync(join(f.root, '.pm-swarm', `repo-${id}`)), false);
    await f.client.update(id, { status: 'canceled' });
  });
});
