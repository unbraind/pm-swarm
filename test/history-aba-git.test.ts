import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ITEM_MUTATION_BOUNDARIES, withItemMutationObserver } from '../src/settings.ts';
import { START_TRANSITIONS, withStartTransitionObserver } from '../src/swarm.ts';
import { loseReturn } from './native-return-faults.ts';
import { fixture } from './helpers.ts';
import { historyPeer, assertPeerPreserved, gitResources } from './history-aba-helpers.ts';

for (const command of ['start', 'next', 'schedule'] as const) test(`Git ${command} preserves identical peer claims at every cleanup path and admission boundary`, async t => {
  const f = await fixture(t); const peer = historyPeer(f.client, f.pmRoot); t.after(peer.destroy);
  for (const path of ['release', 'metadata', 'resources'] as const) for (const boundary of ITEM_MUTATION_BOUNDARIES) await t.test(`${path}:${boundary}`, async () => {
    const id = await f.item([`src/${command}-${path}-${boundary}.ts`]); f.save(); let failed = false; let injected = false; let bytes: string[] = []; let resources: string[] = []; let attempt: PromiseSettledResult<unknown>;
    const fault = path === 'resources' ? undefined : loseReturn(f.client, path === 'release' ? 'claim' : 'update');
    const operation = () => command === 'start' ? f.swarm.start(id) : command === 'next' ? f.swarm.next() : f.swarm.schedule({ skills: [] });
    try {
      [attempt] = await Promise.allSettled([withItemMutationObserver(async step => {
        if (injected || !(failed || fault?.injected()) || step !== boundary) return;
        injected = true; bytes = await peer.cycle(id); resources = gitResources(f.repo);
      }, () => withStartTransitionObserver(step => { if (path === 'resources' && step === 'branch_created') { failed = true; throw new Error('Interrupt native Git acquisition'); } }, operation))]);
    } finally { fault?.restore(); }
    assert.equal(injected, true); assertPeerPreserved(f.pmRoot, id, bytes, attempt, { repo: f.repo, resources });
  });
});


for (const command of ['start', 'next', 'schedule'] as const) test(`Git ${command} preserves identical peer ABA after every acquisition transition`, async t => {
  const f = await fixture(t); const peer = historyPeer(f.client, f.pmRoot); t.after(peer.destroy);
  for (const boundary of START_TRANSITIONS) await t.test(boundary, async () => {
    const id = await f.item([`src/transition-${command}-${boundary}.ts`]); f.save(); let injected = false; let bytes: string[] = []; let resources: string[] = [];
    const operation = () => command === 'start' ? f.swarm.start(id) : command === 'next' ? f.swarm.next() : f.swarm.schedule({ skills: [] });
    const [attempt] = await Promise.allSettled([withStartTransitionObserver(async step => {
      if (step !== boundary) return; injected = true; bytes = await peer.cycle(id); resources = gitResources(f.repo); throw new Error('Lost acquisition boundary');
    }, operation)]);
    assert.equal(injected, true); assertPeerPreserved(f.pmRoot, id, bytes, attempt, { repo: f.repo, resources });
  });
});
