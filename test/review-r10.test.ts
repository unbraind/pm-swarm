import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { heartbeatPath } from '../src/lease.ts';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { fixture } from './helpers.ts';
import { sharedFixture } from './shared-helpers.ts';

for (const destination of [undefined, 'recovery-worker']) {
  test(`reclaim preserves fresh SDK changes before ${destination ?? 'pool'} transfer`, async t => {
    const f = await sharedFixture(t); const old = new Date(Date.now() - 120000).toISOString();
    const mutations = [
      'owner', 'token', 'claim timestamp', 'closed', 'nonterminal status', 'revision', 'branch', 'base', 'target',
    ];
    const ids: string[] = [];
    for (const name of mutations) {
      const id = await f.item([name]); ids.push(id);
      await f.client.claim(id, { author: 'stale-worker' });
      await f.client.update(id, { field: [`swarm_claimed_at=${old}`, 'swarm_token=1'] });
    }
    const control = await f.item(['unchanged']); await f.client.claim(control, { author: 'stale-worker' });
    await f.client.update(control, { field: [`swarm_claimed_at=${old}`, 'swarm_token=1'] });
    const get = f.client.get.bind(f.client); const snapshots = new Map<string, { item: unknown; history: string }>();
    f.client.get = async (...args) => {
      const index = ids.indexOf(args[0]);
      if (index !== -1 && args[1]?.depth === 'full' && !snapshots.has(args[0])) {
        const id = args[0];
        switch (mutations[index]) {
          case 'owner': f.run('update', id, '--assignee', 'replacement-worker'); break;
          case 'token': await f.client.update(id, { field: ['swarm_token=2'] }); break;
          case 'claim timestamp': await f.client.update(id, { field: [`swarm_claimed_at=${new Date().toISOString()}`] }); break;
          case 'closed': await f.client.update(id, { status: 'closed', message: 'Completed outside swarm' }); break;
          case 'nonterminal status': await f.client.update(id, { status: 'in_progress' }); break;
          case 'revision': await f.client.update(id, { comment: ['Fresh external progress'] }); break;
          case 'branch': await f.client.update(id, { field: ['swarm_branch=swarm/external'] }); break;
          case 'base': await f.client.update(id, { field: ['swarm_base=external-base'] }); break;
          case 'target': await f.client.update(id, { field: ['swarm_base_ref=external-target'] }); break;
        }
        snapshots.set(id, { item: (await get(id, { depth: 'full' })).item, history: readFileSync(join(f.pmRoot, 'history', `${id}.jsonl`), 'utf8') });
      }
      return get(...args);
    };
    const result = await f.shared.reclaim(60, destination);
    assert.deepEqual(result.recovered.map(row => row.id), [control]); assert.deepEqual(result.refused, []);
    assert.equal(snapshots.size, ids.length);
    for (const id of ids) {
      assert.deepEqual((await get(id, { depth: 'full' })).item, snapshots.get(id)!.item);
      assert.equal(readFileSync(join(f.pmRoot, 'history', `${id}.jsonl`), 'utf8'), snapshots.get(id)!.history);
    }
  });
}

for (const change of ['fresh heartbeat', 'stale heartbeat', 'invalid heartbeat', 'removed heartbeat'] as const) {
  test(`reclaim rechecks a ${change} after the item read`, async t => {
    const f = await sharedFixture(t); const id = await f.item(); const owner = 'resuming-worker';
    const old = new Date(Date.now() - 120000).toISOString(); const later = new Date(Date.now() - 90000).toISOString();
    await f.client.claim(id, { author: owner }); await f.client.update(id, { field: [`swarm_claimed_at=${old}`] });
    const path = heartbeatPath(f.pmRoot, owner); writeFileSync(path, JSON.stringify({ heartbeat: old }));
    const history = join(f.pmRoot, 'history', `${id}.jsonl`); const before = readFileSync(history, 'utf8');
    const get = f.client.get.bind(f.client); let observed = false;
    f.client.get = async (...args) => {
      const result = await get(...args);
      if (args[0] === id && args[1]?.depth === 'full') {
        observed = true;
        if (change === 'fresh heartbeat') await new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, owner)).heartbeat();
        else if (change === 'removed heartbeat') unlinkSync(path);
        else writeFileSync(path, JSON.stringify({ heartbeat: change === 'stale heartbeat' ? later : 'invalid' }));
      }
      return result;
    };
    const result = await f.shared.reclaim(60); assert.ok(observed);
    if (change === 'fresh heartbeat') {
      assert.deepEqual(result.recovered, []); assert.equal(readFileSync(history, 'utf8'), before);
      assert.equal((await get(id)).claim_state?.assignee, owner);
    } else {
      assert.equal(result.recovered[0].id, id); assert.equal((await get(id)).claim_state?.claimed, false);
      assert.ok(readFileSync(history, 'utf8').startsWith(before));
      assert.ok(result.recovered[0].context.note.includes(`last heartbeat ${change === 'removed heartbeat' ? old : change === 'stale heartbeat' ? later : 'invalid'}`));
    }
  });
}

for (const mode of ['shared', 'Git'] as const) {
  for (const change of ['reopened', 'reassigned'] as const) {
    test(`${mode} reap preserves a terminal snapshot that was ${change} outside swarm`, async t => {
      const f = mode === 'shared' ? await sharedFixture(t) : await fixture(t);
      const id = await f.item();
      if ('swarm' in f) f.save();
      const lane = 'swarm' in f ? await f.swarm.start(id) : undefined;
      const author = mode === 'shared' ? 'shared-test' : 'swarm-test';
      await f.client.update(id, { status: 'closed', message: 'Initial completion' }); await f.client.claim(id, { author, force: true });
      const history = join(f.pmRoot, 'history', `${id}.jsonl`); let before = ''; let injected = false;
      const engine = 'shared' in f ? f.shared : f.swarm;
      const source = 'shared' in f ? f.shared.engine : f.swarm; const corpus = source.corpus.bind(source);
      source.corpus = async () => {
        const snapshot = await corpus();
        if (!injected) {
          injected = true;
          await f.client.update(id, change === 'reopened' ? { status: 'open' } : { assignee: 'replacement-worker' });
          before = readFileSync(history, 'utf8');
        }
        return snapshot;
      };
      const result = await engine.reap();
      assert.deepEqual(result.released, []); assert.deepEqual(result.removed, []);
      assert.equal(readFileSync(history, 'utf8'), before);
      if (lane !== undefined) assert.equal(existsSync(lane.worktree), true, 'Git cleanup cannot act on a stale terminal snapshot');
    });
  }
}
