import assert from 'node:assert/strict';
import fs, { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { leaseLocality, readRuntime, StaleFenceError, swarmRuntime, withSwarmLease } from '../src/lease.ts';
import { sharedFixture } from './shared-helpers.ts';

/** Vary only OS locality probes, forwarding all real tracker filesystem operations. */
function changeRealm(t: TestContext, realm: string) {
  const read = fs.readFileSync;
  const link = fs.readlinkSync;
  const probes: { mock: { restore(): void } }[] = [];
  if (realm === 'host') probes.push(t.mock.method(os, 'hostname', () => 'synthetic-other-host'));
  if (realm === 'namespace' || realm === 'unavailable namespace') {
    probes.push(t.mock.method(fs, 'readlinkSync', new Proxy(link, {
      apply(target, receiver, args: unknown[]) {
        if (String(args[0]) !== '/proc/self/ns/pid') return Reflect.apply(target, receiver, args);
        if (realm === 'unavailable namespace') throw new Error('Namespace probe unavailable');
        return 'pid:[synthetic-other-namespace]';
      },
    })));
  }
  if (realm === 'boot' || realm === 'unavailable boot') {
    probes.push(t.mock.method(fs, 'readFileSync', new Proxy(read, {
      apply(target, receiver, args: unknown[]) {
        if (String(args[0]) !== '/proc/sys/kernel/random/boot_id') return Reflect.apply(target, receiver, args);
        if (realm === 'unavailable boot') throw new Error('Host boot probe unavailable');
        return 'synthetic-other-boot';
      },
    })));
  }
  syncBuiltinESMExports();
  /** Restore probes before the live holder retires its own runtime records. */
  return () => { for (const probe of probes) probe.mock.restore(); syncBuiltinESMExports(); };
}

test('lease publication tags requests, pins and operation records without exposing host identity', async t => {
  const f = await sharedFixture(t); const tag = leaseLocality(); assert.match(tag!, /^[a-f0-9]{64}$/);
  const tickets: Record<string, unknown>[] = []; const link = fs.linkSync;
  const observer = t.mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => {
    if (String(args[1]).endsWith('operation-pin.json')) tickets.push(readRuntime<Record<string, unknown>>(String(args[0]))!);
    return link(...args);
  });
  syncBuiltinESMExports(); t.after(() => { observer.mock.restore(); syncBuiltinESMExports(); });
  await withSwarmLease(f.pmRoot, 'publishing-worker', async lease => {
    for (const file of ['operation.json', 'operation-pin.json']) {
      const record = readRuntime<Record<string, unknown>>(join(f.pmRoot, 'runtime/swarm', file))!;
      assert.equal(record.locality, tag); assert.equal(record.pid, process.pid);
      assert.equal(JSON.stringify(record).includes(os.hostname()), false);
    }
    await lease.write(() => f.client.create({ type: 'Task', title: 'Locality publication proof' }));
  });
  assert.equal(tickets.length, 1); assert.equal(tickets[0].locality, tag);
});

for (const realm of ['host', 'namespace', 'boot', 'legacy', 'malformed', 'unavailable namespace', 'unavailable boot']) {
  test(`lease preserves a held pin with ${realm} locality`, async t => {
    const f = await sharedFixture(t); const pin = join(swarmRuntime(f.pmRoot), 'operation-pin.json');
    let entered = false;
    await withSwarmLease(f.pmRoot, 'held-worker', async lease => {
      const owner = readRuntime<Record<string, unknown>>(pin)!; owner.pid = 2147483647;
      if (realm === 'legacy') delete owner.locality;
      if (realm === 'malformed') owner.locality = 42;
      const evidence = JSON.stringify(owner); writeFileSync(pin, evidence);
      const restore = changeRealm(t, realm);
      try {
        if (realm.startsWith('unavailable')) assert.equal(leaseLocality(), undefined);
        await assert.rejects(withSwarmLease(f.pmRoot, 'contender', async () => { entered = true; }, { waitMs: 0 }), /swarm_busy/);
        assert.equal(readFileSync(pin, 'utf8'), evidence, 'an invisible PID cannot authorize stealing another realm or legacy pin');
        assert.equal(entered, false);
      } finally { restore(); }
      await lease.write(() => f.client.create({ type: 'Task', title: 'Original holder continues' }));
    });
    assert.equal(existsSync(pin), false, 'the original holder can still retire its own token');
  });
}

for (const locality of ['foreign', undefined]) {
  test(`lease retains an older ${locality ?? 'legacy'} request ahead of admission`, async t => {
    const f = await sharedFixture(t); const runtime = swarmRuntime(f.pmRoot); const file = join(runtime, 'request-000-other.json');
    const evidence = JSON.stringify({ pid: 2147483647, locality, token: 'other-writer' }); writeFileSync(file, evidence);
    let entered = false;
    await assert.rejects(withSwarmLease(f.pmRoot, 'waiting-worker', async () => { entered = true; }, { waitMs: 0 }), /swarm_busy/);
    assert.equal(readFileSync(file, 'utf8'), evidence); assert.equal(entered, false);
    assert.deepEqual(readdirSync(runtime).filter(name => name.startsWith('request-')), ['request-000-other.json']);
  });
}

for (const scenario of ['empty queue', 'missing request', 'replaced request']) {
  test(`lease fails closed after an ${scenario}`, { timeout: 10000 }, async t => {
    const f = await sharedFixture(t); const root = swarmRuntime(f.pmRoot); let intercepted = false; let ticket = '';
    const list = fs.readdirSync;
    const observer = t.mock.method(fs, 'readdirSync', new Proxy(list, {
      apply(target, receiver, args: unknown[]) {
        if (String(args[0]) === root && !intercepted) {
          intercepted = true;
          ticket = join(root, (list(root) as string[]).find(name => name.startsWith('request-'))!);
          if (scenario === 'replaced request') {
            const record = readRuntime<Record<string, unknown>>(ticket)!; record.token = 'replacement'; writeFileSync(ticket, JSON.stringify(record));
          } else {
            unlinkSync(ticket);
            if (scenario === 'missing request') writeFileSync(join(root, 'request-000-held.json'), JSON.stringify({ pid: process.pid, token: 'older' }));
          }
        }
        return Reflect.apply(target, receiver, args);
      },
    }));
    syncBuiltinESMExports(); t.after(() => { observer.mock.restore(); syncBuiltinESMExports(); });
    let entered = false;
    await assert.rejects(withSwarmLease(f.pmRoot, 'lost-worker', async () => { entered = true; }, { waitMs: 1000 }), StaleFenceError);
    assert.equal(entered, false); assert.ok(intercepted);
    assert.equal(existsSync(join(root, 'operation-pin.json')), false);
    assert.equal(existsSync(ticket), scenario === 'replaced request', 'cleanup preserves a replacement generation');
  });
}

test('README defines PID namespace recovery and conservative legacy cleanup', () => {
  const text = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(text, /host boot and PID namespace/);
  assert.match(text, /missing, different or unverifiable locality/);
  assert.match(text, /all writers sharing the tracker are stopped/);
});
