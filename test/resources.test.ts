import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ResourceReservations, ResourceRefusal, RESOURCE_TAG, trackerResourceBackend } from '../index.ts';
import type { ResourceBackend } from '../index.ts';
import { Swarm } from '../src/swarm.ts';
import { sharedFixture } from './shared-helpers.ts';
import { fixture } from './helpers.ts';

/** Bind another principal to exactly the same real tracker and operation lease. */
function resources(f: Awaited<ReturnType<typeof sharedFixture>>, author = 'shared-test') {
  return new ResourceReservations(trackerResourceBackend(new Swarm(f.repo, f.pmRoot, f.client, author)), author);
}

/** Explicitly opt a real tracker item into exclusive resource coordination. */
async function resource(f: Awaited<ReturnType<typeof sharedFixture>>) {
  return (await f.client.create({ type: 'Task', title: 'Synthetic database slot', tags: RESOURCE_TAG })).item.id;
}

test('resources on one non-Git tracker exclude rivals, fence ABA, renew and publish one atomic receipt', async t => {
  const f = await sharedFixture(t); const id = await resource(f); const a = resources(f); const b = resources(f, 'rival');
  assert.deepEqual(await a.status(id), { id, resource: true, token: '0', owner: null, expires_at: null, held: false });
  const first = await a.reserve(id); assert.equal(first.token, '1'); assert.equal(first.owner, 'shared-test'); assert.equal(first.held, true);
  for (const contender of [a, b]) await assert.rejects(contender.reserve(id), { code: 'resource_busy' });
  const history = join(f.pmRoot, 'history', `${id}.jsonl`); const before = readFileSync(history, 'utf8');
  for (const contender of [a, b]) for (const token of ['', '0', '2']) {
    await assert.rejects(contender.renew(id, token), { code: 'resource_stale_fence' });
    await assert.rejects(contender.publish(id, token, 'Rejected'), { code: 'resource_stale_fence' });
    await assert.rejects(contender.release(id, token), { code: 'resource_stale_fence' });
  }
  await assert.rejects(b.publish(id, '1', 'Foreign'), ResourceRefusal);
  assert.equal(readFileSync(history, 'utf8'), before, 'refused operations never append history');
  const renewed = await a.renew(id, '1', 600); assert.equal(renewed.token, '1'); assert.ok(renewed.expires_at! > first.expires_at!);
  const length = readFileSync(history, 'utf8').trim().split('\n').length;
  const published = await a.publish(id, '1', 'Validated dataset checksum');
  assert.equal('note' in published, false); assert.equal(readFileSync(history, 'utf8').trim().split('\n').length, length + 1);
  assert.match(String((await f.client.get(id, { depth: 'full' })).item.comments?.at(-1)?.text), /generation 1: Validated dataset checksum/);
  const released = await a.release(id, '1'); assert.equal(released.token, '2'); assert.equal(released.owner, null); assert.equal(released.held, false);
  await assert.rejects(a.release(id, '2'), ResourceRefusal);
  const next = await a.reserve(id, 60); assert.equal(next.token, '3');
  await assert.rejects(a.publish(id, '1', 'ABA stale'), ResourceRefusal);
  await a.release(id, '3'); const rival = await b.reserve(id); assert.equal(rival.token, '5');
});

test('expired resources admit a successor and reject every old publication without history writes', async t => {
  const f = await sharedFixture(t); const id = await resource(f); const a = resources(f); await a.reserve(id);
  await f.client.update(id, { field: ['swarm_resource_expires_at=2000-01-01T00:00:00.000Z'] });
  assert.equal((await a.status(id)).held, false);
  const history = join(f.pmRoot, 'history', `${id}.jsonl`); const before = readFileSync(history, 'utf8');
  await assert.rejects(a.renew(id, '1'), { code: 'resource_stale_fence' });
  await assert.rejects(a.release(id, '1'), { code: 'resource_stale_fence' });
  await assert.rejects(a.publish(id, '1', 'Expired'), { code: 'resource_stale_fence' });
  assert.equal(readFileSync(history, 'utf8'), before);
  const b = resources(f, 'successor'); assert.equal((await b.reserve(id)).token, '2');
  await assert.rejects(a.publish(id, '1', 'Superseded'), { code: 'resource_stale_fence' });
});

test('resource validation preserves ordinary, terminal, foreign and damaged item state', async t => {
  const f = await sharedFixture(t); const a = resources(f); const ordinary = await f.item();
  await assert.rejects(a.reserve(ordinary), { code: 'resource_invalid' });
  const id = await resource(f);
  for (const seconds of [NaN, Infinity, 0, -1, 0.5, 86401]) {
    await assert.rejects(a.reserve(id, seconds), /integer seconds/);
    await assert.rejects(a.renew(id, '', seconds), /integer seconds/);
  }
  for (const note of ['', ' ', 'x'.repeat(4097)]) await assert.rejects(a.publish(id, '', note), /nonempty/);
  for (const fields of [['swarm_token=bad'], ['swarm_token=0', 'swarm_resource_expires_at=bad'], ['swarm_resource_expires_at=2000-01-01T00:00:00.000Z']]) {
    await f.client.update(id, { field: fields }); await assert.rejects(a.status(id), { code: 'resource_invalid' });
  }
  await f.client.update(id, { unset: ['swarm_resource_expires_at'], assignee: 'foreign' });
  await assert.rejects(a.reserve(id), { code: 'resource_invalid' });
  await f.client.update(id, { field: ['swarm_resource_expires_at=bad'] });
  await assert.rejects(a.reserve(id), { code: 'resource_invalid' });
  await f.client.update(id, { unset: ['assignee', 'swarm_resource_expires_at'], status: 'closed', message: 'Retired resource' });
  await assert.rejects(a.status(id), { code: 'resource_invalid' });
  await assert.rejects(a.status('does-not-exist'));
});

test('resource backend refusal propagates without creating local coordination or invoking a decision', async t => {
  const f = await sharedFixture(t); const id = await resource(f); const marker = new ResourceRefusal('resource_backend_refused', 'Connect the selected tracker backend.');
  // This is a deliberately refusing provider, not a mock of the PM SDK or storage.
  const backend: ResourceBackend = {
    async read() { throw marker; },
    async transact() { throw marker; },
  };
  const a = new ResourceReservations(backend, 'worker');
  for (const call of [() => a.status(id), () => a.reserve(id), () => a.renew(id, '1'), () => a.publish(id, '1', 'Result'), () => a.release(id, '1')]) {
    await assert.rejects(call(), error => error === marker);
  }
  assert.equal((await resources(f).status(id)).token, '0');
  const legacy = join(f.pmRoot, 'extensions/legacy-provider'); mkdirSync(legacy);
  writeFileSync(join(legacy, 'entry.js'), 'export default { activate() {} };');
  writeFileSync(join(legacy, 'manifest.json'), JSON.stringify({ name: 'legacy-provider', version: '1.0.0', entry: 'entry.js' }));
  await assert.rejects(resources(f).status(id), { code: 'resource_backend_refused' });
  writeFileSync(join(legacy, 'manifest.json'), JSON.stringify({ name: 'legacy-provider', version: '1.0.0', entry: 'entry.js', capabilities: ['schema'] }));
  // A real installed provider that declares services must never use the local adapter.
  const extension = join(f.pmRoot, 'extensions/storage-provider'); mkdirSync(extension);
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ name: 'storage-provider', version: '1.0.0', entry: 'entry.js', capabilities: ['services'] }));
  writeFileSync(join(extension, 'entry.js'), 'export default { activate(api) { api.registerService("lock_acquire", () => { throw new Error("provider offline") }); } };');
  const before = readFileSync(join(f.pmRoot, 'history', `${id}.jsonl`), 'utf8');
  for (const call of [() => resources(f).reserve(id), () => resources(f).status(id)]) await assert.rejects(call(), { code: 'resource_backend_refused' });
  assert.equal(readFileSync(join(f.pmRoot, 'history', `${id}.jsonl`), 'utf8'), before);
});

test('resource CLI renders compact TOON/JSON and typed remedies without git in PATH', async t => {
  const f = await sharedFixture(t);
  const created = f.run('create', '--type', 'Task', '--id', 'cli-resource', '--title', 'Synthetic database slot', '--tags', RESOURCE_TAG);
  assert.equal(typeof created.id, 'string'); const id = String(created.id);
  assert.equal(f.run('swarm', 'resource', id).held, false);
  const reserved = f.run('swarm', 'resource', id, '--action', 'reserve', '--ttl', '60'); assert.equal(reserved.token, '1');
  assert.equal(f.run('swarm', 'resource', id, '--action', 'renew', '--token', '1').held, true);
  assert.equal(f.run('swarm', 'resource', id, '--action', 'renew', '--token', '1', '--ttl', '120').held, true);
  assert.equal(f.run('swarm', 'resource', id, '--action', 'publish', '--token', '1', '--note', 'Fixture accepted').token, '1');
  const toon = f.cli('swarm', 'resource', id); assert.equal(toon.status, 0, toon.stderr); assert.match(toon.stdout, /token: "1"/); assert.ok(toon.stdout.length < 512);
  for (const args of [[], [id, '--action', 'unknown'], [id, '--action', 'publish'], [id, '--action', 'renew'], [id, '--action', 'reserve', '--ttl', 'bad'], [id, '--action', 'reserve', '--agent', 'rival']]) {
    const result = f.cli('swarm', 'resource', ...args, '--json'); assert.equal(result.status, 2, result.stdout + result.stderr);
    if (args.length > 0) assert.match(result.stdout + result.stderr, /resource_(invalid|stale_fence|busy)/);
  }
  assert.equal(f.run('swarm', 'resource', id, '--action', 'release', '--token', '1').held, false);
});

test('concurrent real process agents receive exactly one resource reservation', async t => {
  const f = await sharedFixture(t); const id = await resource(f);
  /** Launch a real command on the same non-Git tracker, without a git executable. */
  const attempt = async (agent: string) => {
    const child = spawn(process.execPath, [f.host, 'swarm', 'resource', id, '--action', 'reserve', '--agent', agent, '--json'], { cwd: f.repo, env: f.env });
    let output = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
    const [code] = await once(child, 'close'); return { code, output };
  };
  const results = await Promise.all(['one', 'two', 'three'].map(attempt));
  assert.equal(results.filter(row => row.code === 0).length, 1, JSON.stringify(results));
  assert.equal(results.filter(row => row.code === 2 && row.output.includes('resource_busy')).length, 2);
  assert.equal((await resources(f).status(id)).token, '1');
});

test('resource records never become work claims or stale-agent reclaim candidates', async t => {
  const f = await sharedFixture(t); const id = await resource(f); const a = resources(f);
  assert.equal((await f.shared.next()).selected, null);
  await assert.rejects(f.shared.start(id), /Resource items/);
  await a.reserve(id);
  await assert.rejects(f.shared.sync(id, true, ['result'], '1'), /Resource items/);
  await assert.rejects(f.shared.close(id, 'Bypass', '1'), /Resource items/);
  assert.deepEqual((await f.shared.status()).lanes, []);
  await f.client.update(id, { field: ['swarm_claimed_at=2000-01-01T00:00:00.000Z'] });
  assert.deepEqual((await f.shared.reclaim(1)).recovered, []);
  assert.equal((await a.status(id)).owner, 'shared-test');
  const git = await fixture(t); const gitId = await resource({ ...f, client: git.client });
  await assert.rejects(git.swarm.start(gitId), /Resource items/);
  assert.deepEqual((await git.swarm.plan()).lanes, []);
  await git.client.update(gitId, { assignee: 'resource-worker' });
  assert.equal((await git.swarm.next(undefined, true)).selected, null);
});
