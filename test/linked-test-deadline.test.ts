import assert from 'node:assert/strict';
import { test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fixture } from './helpers.ts';
import { linkedTestDeadline } from '../src/child-deadlines.ts';

test('the linked-test coordinator preserves explicit long budgets and supplies a bounded default', () => {
  assert.equal(linkedTestDeadline([]), 300000);
  assert.equal(linkedTestDeadline([{}]), 3900000);
  assert.equal(linkedTestDeadline([{ timeout_seconds: 7200 }, {}, { timeout_seconds: 30 }]), 11130000);
});

test('every generated linked-test sequence fits inside its coordinator deadline', () => {
  let seed = 0x71de;
  for (let sequence = 0; sequence < 200; sequence++) {
    const tests: { timeout_seconds?: number }[] = [];
    for (let index = 0; index <= sequence % 20; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      tests.push(seed % 3 === 0 ? {} : { timeout_seconds: 1 + seed % 86400 });
    }
    const declared = tests.reduce((total, entry) => total + (entry.timeout_seconds ?? 3600) * 1000, 0);
    assert.equal(linkedTestDeadline(tests), declared + 300000, JSON.stringify(tests));
    assert.ok(Number.isSafeInteger(linkedTestDeadline(tests)));
  }
});

test('the real merged-test child receives every declared test budget plus coordinator grace', async t => {
  const f = await fixture(t); const id = await f.item();
  f.write('verify.test.js', "const {test}=require('node:test');const assert=require('node:assert/strict');test('public fixture',()=>assert.equal(2+2,4));\n");
  await f.client.run('test', { id, options: { add: ['command=node --test verify.test.js,timeout_seconds=7200', 'command=node --test --test-concurrency=1 verify.test.js'] } });
  f.save(['.agents/pm', 'verify.test.js']); await f.swarm.start(id); f.save();
  const original = childProcess.spawnSync; const deadlines: number[] = [];
  /** Install and restore the process observer at a synchronous boundary in this isolated test worker. */
  const installSpawn = (value: typeof original) => { childProcess.spawnSync = value; syncBuiltinESMExports(); };
  installSpawn(new Proxy(original, { apply(target, receiver, args: unknown[]) {
    const argv = args[1]; const options = args[2];
    if (Array.isArray(argv) && /test-runner\.(?:ts|js)$/.test(String(argv[0])) && typeof options === 'object' && options !== null) deadlines.push(Number(Reflect.get(options, 'timeout')));
    return Reflect.apply(target, receiver, args);
  } }));
  try { assert.equal((await f.swarm.land(true)).executed, true); }
  finally { installSpawn(original); }
  assert.deepEqual(deadlines, [11100000], 'a fixed coordinator cap truncates the declared two-hour test budget');
});


test('fractional linked-test budgets always produce valid whole millisecond deadlines without truncation', () => {
  let seed = 0x81de;
  for (let count = 1; count <= 200; count++) {
    const tests = Array.from({ length: count % 21 + 1 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return { timeout_seconds: seed / 1048576 + 0.0000001 };
    });
    const exact = tests.reduce((total, entry) => total + entry.timeout_seconds * 1000, 300000);
    const deadline = linkedTestDeadline(tests);
    assert.ok(Number.isSafeInteger(deadline), 'spawnSync requires an integer timeout');
    assert.ok(deadline >= exact && deadline < exact + 1, 'never truncate the declared aggregate budget');
  }
});
