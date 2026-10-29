import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectOrderingCycles } from '@unbrained/pm-cli/sdk/graph';
import { ResourceDeadlocks, ResourceReservations, RESOURCE_TAG, RESOURCE_REQUEST_FIELD, parseResourceRequest, trackerResourceBackend, Swarm } from '../index.ts';
import { ITEM_MUTATION_BOUNDARIES, withItemMutationObserver } from '../src/settings.ts';
import { inspectItem } from '../src/inspection.ts';
import { historyPeer } from './history-aba-helpers.ts';
import { sharedFixture } from './shared-helpers.ts';

/** Create two real resource holders on one non-git tracker. */
async function pair(t: Parameters<typeof sharedFixture>[0]) {
  const f = await sharedFixture(t);
  const engines = ['alpha', 'beta'].map(author => new Swarm(f.repo, f.pmRoot, f.client, author));
  const reservations = engines.map(engine => new ResourceReservations(trackerResourceBackend(engine), engine.author));
  const resources: string[] = [];
  for (let i = 0; i < 2; i++) {
    const id = (await f.client.create({ type: 'Task', id: `resource-${i}`, title: `Slot ${i}`, tags: RESOURCE_TAG, parent: 'none', assignee: 'none' })).item.id;
    resources.push(id); await reservations[i].reserve(id, 86400);
  }
  const witnesses = engines.map(engine => new ResourceDeadlocks(engine));
  return { ...f, resources, reservations, witnesses };
}

/** Declare exactly one pending edge with the revision read from native history. */
async function declare(witness: ResourceDeadlocks, anchor: string, target: string, apply = true) {
  return witness.request(anchor, { version: 1, token: '1', resources: [target] }, (await witness.inspect(anchor)).revision, apply);
}

test('two-worker cycle is exact, SDK-derived, bounded and read-only without git', async t => {
  const f = await pair(t); const [a, b] = f.resources;
  await Promise.all([declare(f.witnesses[0], a, b), declare(f.witnesses[1], b, a)]);
  const histories = f.resources.map(id => readFileSync(join(f.pmRoot, 'history', `${id}.jsonl`), 'utf8'));
  const report = await f.witnesses[0].detect();
  assert.deepEqual(report.edges, [
    { requester: 'alpha', holder: 'beta', anchor: a, anchor_token: '1', resource: b, token: '1' },
    { requester: 'beta', holder: 'alpha', anchor: b, anchor_token: '1', resource: a, token: '1' },
  ]);
  assert.deepEqual(report.cycles, [['alpha', 'beta']]);
  assert.deepEqual(report.cycles, collectOrderingCycles(new Map(report.edges.map(edge => [edge.requester, [edge.holder]]))));
  assert.deepEqual(report.alternatives, [{ resource: b, owner: 'beta', token: '1' }, { resource: a, owner: 'alpha', token: '1' }]);
  assert.equal(report.read_only, true); assert.equal(report.truncated, false); assert.equal(report.requests, 2);
  assert.equal((await f.witnesses[0].detect(1)).truncated, true);
  assert.equal(f.run('swarm', 'deadlocks', '--limit', '1').truncated, true);
  assert.deepEqual(f.resources.map(id => readFileSync(join(f.pmRoot, 'history', `${id}.jsonl`), 'utf8')), histories);
  assert.equal(f.run('swarm', 'deadlocks').cycles instanceof Array, true);
  const toon = f.cli('swarm', 'deadlocks'); assert.equal(toon.status, 0, toon.stderr); assert.ok(toon.stdout.length < 2000); assert.match(toon.stdout, /cycles/);
  await f.reservations[0].release(a, '1'); await f.reservations[0].reserve(a);
  const stale = await f.witnesses[0].detect(); assert.deepEqual(stale.cycles, []); assert.ok(stale.skipped.some(row => row.reason === 'stale_request_generation'));
  await f.client.update(b, { field: ['swarm_resource_expires_at=2000-01-01T00:00:00.000Z'] });
  assert.deepEqual((await f.witnesses[0].detect()).edges, []);
  await assert.rejects(declare(f.witnesses[1], b, a), { code: 'deadlock_stale' });
});

test('preview, withdrawal and revision-bound replays preserve foreign fields and relationships', async t => {
  const f = await pair(t); const [a, b] = f.resources; const w = f.witnesses[0];
  const initial = await w.inspect(a);
  const input = { version: 1, token: '1', resources: [b] };
  const before = (await f.client.get(a, { depth: 'full' })).item;
  const preview = await w.request(a, input, initial.revision); assert.equal(preview.changed, true); assert.equal(preview.applied, false);
  assert.equal((await f.client.get(a, { depth: 'full' })).item[RESOURCE_REQUEST_FIELD], undefined);
  const applied = await w.request(a, input, initial.revision, true); assert.equal(applied.changed, preview.changed);
  await assert.rejects(w.request(a, input, initial.revision, true), { code: 'deadlock_stale' });
  const current = await w.inspect(a); assert.equal((await w.request(a, input, current.revision, true)).changed, false);
  const after = (await f.client.get(a, { depth: 'full' })).item;
  for (const key of ['parent', 'dependencies', 'assignee', 'tags', 'body', 'title', 'swarm_token', 'swarm_resource_expires_at']) assert.deepEqual(after[key], before[key]);
  await w.request(a, { ...input, resources: [] }, current.revision, true);
  assert.equal((await w.detect()).requests, 0); assert.deepEqual((await w.detect()).edges, []);
  await assert.rejects(f.witnesses[1].request(a, input, (await w.inspect(a)).revision, true), { code: 'deadlock_stale' });
});

test('one strict declaration schema refuses extremes, sparse arrays and extras, preserving valid producers', () => {
  const bad: unknown[] = [null, [], 1, {}, { version: 2, token: '1', resources: [] }, { version: 1, token: '1', resources: [], extra: 1 }];
  for (const token of [NaN, Infinity, -Infinity, 1, '', '01', '-1', '1e50', '9'.repeat(81), '9'.repeat(97)]) bad.push({ version: 1, token, resources: [] });
  for (const resources of [new Array(2), [null], [NaN], [''], ['a', ' a '], ['a/b'], ['x'.repeat(161)], ['x'.repeat(257)], Array.from({ length: 17 }, (_, i) => `r${i}`)]) bad.push({ version: 1, token: '1', resources });
  for (const value of bad) assert.throws(() => parseResourceRequest(value), { code: 'deadlock_invalid' });
  for (const resources of [[], ['constructor'], ['a', 'b'], ['a'.repeat(160)]]) {
    const value = parseResourceRequest({ version: 1, token: ' 1\r\n', resources });
    assert.deepEqual(parseResourceRequest(JSON.parse(JSON.stringify(value))), value);
  }
});

test('declaration refuses every SDK mutation interleaving boundary and preserves a peer ABA', async t => {
  const f = await pair(t); const [a, b] = f.resources; const w = f.witnesses[0];
  const peer = historyPeer(f.client, f.pmRoot); t.after(peer.destroy);
  for (const boundary of ITEM_MUTATION_BOUNDARIES) {
    const revision = (await w.inspect(a)).revision; let injected = false;
    await assert.rejects(withItemMutationObserver(async point => {
      if (point !== boundary || injected) return;
      injected = true;
      await peer.cycle(a);
    }, () => w.request(a, { version: 1, token: '1', resources: [b] }, revision, true)), { code: 'swarm_superseded' });
    assert.equal(injected, true, boundary);
    assert.equal((await f.client.get(a, { depth: 'full' })).item[RESOURCE_REQUEST_FIELD], undefined);
  }
});

test('500 seeded operation sequences compare SDK read-back to an independent request model', { timeout: 1200000 }, async t => {
  const f = await pair(t); const [a, b] = f.resources; const w = f.witnesses[0];
  const scope = (await f.client.create({ type: 'Feature', title: 'Native relationship scope', parent: 'none' })).item.id;
  const otherScope = (await f.client.create({ type: 'Feature', title: 'Ambient focus scope', parent: 'none' })).item.id;
  await f.client.update(a, { parent: scope, dep: [`id=${b},kind=related`], description: 'Preserved native description', body: 'Native body\r\nwith whitespace  \n' });
  let seed = 0x51ca7e; let model: string | undefined;
  const old: { revision: string; value: { version: 1; token: string; resources: string[] } }[] = [];
  /** Reproducible generator independent of declaration normalization. */
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let sequence = 0; sequence < 500; sequence++) {
    if (sequence % 50 === 0) await f.client.focus((random() >>> 16 & 1) === 1 ? scope : otherScope);
    const active = (random() >>> 16 & 1) === 1;
    const canonical = { version: 1 as const, token: '1', resources: active ? [b] : [] };
    const variant = { ...canonical, token: ' 1\r\n', resources: canonical.resources.map(id => ` ${id}\r\n`) };
    const revision = (await w.inspect(a)).revision;
    const beforeView = (await inspectItem(f.pmRoot, f.repo, a))!;
    const before = beforeView.item;
    const preview = await w.request(a, variant, revision);
    assert.equal(preview.changed, model !== JSON.stringify(canonical));
    const result = await w.request(a, variant, revision, true);
    assert.equal(result.changed, preview.changed);
    if (model !== JSON.stringify(canonical)) old.push({ revision, value: canonical });
    model = JSON.stringify(canonical);
    // Replay older inputs in randomized order with their original native revision.
    const replay = old[random() % old.length];
    await assert.rejects(w.request(a, replay.value, replay.revision, true), { code: 'deadlock_stale' });
    const afterView = (await inspectItem(f.pmRoot, f.repo, a))!;
    const readBack = afterView.item;
    assert.equal(afterView.body, beforeView.body);
    assert.equal(readBack[RESOURCE_REQUEST_FIELD], model);
    for (const key of ['parent', 'dependencies', 'assignee', 'tags', 'description', 'swarm_token', 'swarm_resource_expires_at']) assert.deepEqual(readBack[key], before[key]);
    assert.deepEqual(parseResourceRequest(JSON.parse(String(readBack[RESOURCE_REQUEST_FIELD]))), canonical);
    if (sequence % 100 === 99) console.log(JSON.stringify({ sequences: sequence + 1, seed: '0x51ca7e', replay_refusals: sequence + 1 }));
  }
});

test('bad and foreign records fail alone; untrusted CLI flags refuse with remedies', async t => {
  const f = await pair(t); const [a, b] = f.resources;
  for (const field of ['not-json', '{"version":1,"token":"1","resources":[null]}']) {
    await f.client.update(a, { field: [`${RESOURCE_REQUEST_FIELD}=${field}`] });
    assert.ok((await f.witnesses[0].detect()).skipped.some(row => row.reason === 'invalid_or_foreign_request'));
  }
  for (const limit of [NaN, Infinity, -1, 0, 0.5, 51]) await assert.rejects(f.witnesses[0].detect(limit), { code: 'deadlock_invalid' });
  for (const input of [{ version: 1, token: '1', resources: [a] }, { version: 1, token: '1', resources: [b] }]) {
    await assert.rejects(f.witnesses[0].request(a, input, 'bad', true), { code: 'deadlock_invalid' });
  }
  await assert.rejects(declare(f.witnesses[0], a, a), { code: 'deadlock_invalid' });
  for (const args of [['--action', 'unknown'], ['--action', 'inspect'], ['--action', 'request'], ['--limit', 'Infinity'], ['--limit', '0'], ['--limit', '51'], [a, '--action', 'request', '--resources', b, '--revision', '1:' + '0'.repeat(64)], [a, '--action', 'request', '--token', '1', '--resources', b], [a, '--action', 'request', '--token', '1', '--revision', '1:' + '0'.repeat(64)], ['--apply'], ['--action', 'request', '--clear', '--resources', b]]) {
    const result = f.cli('swarm', 'deadlocks', ...args, '--json'); assert.equal(result.status, 2, result.stdout + result.stderr); assert.match(result.stdout + result.stderr, /deadlock_invalid/);
  }
  const inspected = f.run('swarm', 'deadlocks', a);
  const args = ['swarm', 'deadlocks', a, '--action', 'request', '--token', '1', '--revision', String(inspected.revision), '--resources', b, '--agent', 'alpha'];
  assert.equal(f.run(...args).applied, false); assert.equal(f.run(...args, '--apply').applied, true);
  const fresh = f.run('swarm', 'deadlocks', a);
  assert.equal(f.run('swarm', 'deadlocks', a, '--action', 'request', '--token', '1', '--revision', String(fresh.revision), '--clear', '--apply', '--agent', 'alpha').applied, true);
  await f.client.update(a, { status: 'closed', message: 'Retired' });
  assert.ok((await f.witnesses[0].detect()).skipped.some(row => row.reason === 'inactive_or_expired'));
});

test('custom status registry roles determine active and terminal waits under arbitrary names', async t => {
  const f = await pair(t); const [a, b] = f.resources;
  for (let i = 0; i < f.witnesses.length; i++) await declare(f.witnesses[i], f.resources[i], f.resources[1 - i]);
  let seed = 0xdecade;
  for (let i = 0; i < 6; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const name = `workflow_${seed.toString(36)}`;
    const terminal = (seed >>> 18 & 1) === 1;
    await f.client.schemaAddStatus(name, { role: terminal ? ['terminal'] : ['active'] });
    await f.client.update(a, { status: name, message: 'Synthetic registry transition' });
    assert.equal((await f.witnesses[0].detect()).cycles.length, terminal ? 0 : 1);
  }
});

test('seeded extreme declaration producers all validate and serialize without numeric coercion', () => {
  let seed = 0xfeedbacc;
  for (let i = 0; i < 1000; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const count = seed % 17; const digits = 1 + (seed >>> 8) % 80;
    const resources = Array.from({ length: count }, (_, j) => `resource-${j.toString().padStart(2, '0')}`);
    const canonical = { version: 1 as const, token: '9'.repeat(digits), resources };
    const emitted = parseResourceRequest({ ...canonical, token: ` ${canonical.token}\r\n`, resources: resources.map(id => ` ${id}\r\n`) });
    assert.deepEqual(emitted, canonical);
    assert.deepEqual(parseResourceRequest(JSON.parse(JSON.stringify(emitted))), canonical);
  }
});
