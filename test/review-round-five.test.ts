import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import filesystem from 'node:fs/promises';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHistoryEntry, emptyImportedDocument, getHistoryPath, getItemAt } from '@unbrained/pm-cli/sdk';
import { runCoverageGate } from '../scripts/coverage-gate.ts';
import { CLOSE_INTENT, captureCloseMember } from '../src/close-journal.ts';
import { closeBytes, recoveryFixture } from './close-recovery-helpers.ts';
import { fixture } from './helpers.ts';
import { fleetTrackedPaths } from './privacy-fleet-helpers.ts';

for (const member of ['primary', 'dependent']) test(`a legacy checkpoint racing ${member} admission cannot persist an unrecoverable intent`, async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1);
  const targetId = member === 'primary' ? id : ids[1];
  const path = getHistoryPath(f.pmRoot, targetId);
  const history = readFileSync(path, 'utf8').trim().split('\n');
  const source = await getItemAt(targetId, String(JSON.parse(history.at(-1)!).ts), { pmRoot: f.pmRoot });
  const checkpoint = createHistoryEntry({ nowIso: new Date().toISOString(), author: 'legacy-test', op: 'history_compact_baseline', before: emptyImportedDocument(), after: source.document });
  let injected = false; let retained: ReturnType<typeof closeBytes> | undefined;
  const original = filesystem.readFile;
  // Replace real disposable history after canonical identity, before the first head read; never substitute an SDK response.
  const hook = t.mock.method(filesystem, 'readFile', new Proxy(original, { apply(target, receiver, args: unknown[]) {
    if (!injected && String(args[0]) === path && new Error().stack?.includes('readItemHistoryHead')) {
      injected = true; writeFileSync(path, `${JSON.stringify(checkpoint)}\n`); retained = closeBytes(f, ids);
    }
    return Reflect.apply(target, receiver, args);
  } })); syncBuiltinESMExports();
  try { await assert.rejects(member === 'primary' ? f.shared.close(id, 'Public native completion', token) : captureCloseMember(f.shared.engine, targetId, false), { code: 'swarm_close_recovery_unsupported' }); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(injected, true); assert.deepEqual(closeBytes(f, ids), retained);
  assert.equal((await f.client.get(id, { depth: 'full' })).item[CLOSE_INTENT], undefined);
});

test('coverage timeout reports its real budget and removes stale success reports', t => {
  const root = mkdtempSync(join(tmpdir(), 'coverage-deadline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ coverageGate: { sources: ['entry.ts'], tests: ['absent.test.ts'], thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 } } }));
  writeFileSync(join(root, 'entry.ts'), 'export const value = 1;\n');
  mkdirSync(join(root, 'coverage')); writeFileSync(join(root, 'coverage/coverage-summary.json'), '{"total":"stale success"}');
  const lines: string[] = []; const spawn = childProcess.spawnSync; let observed = false;
  const hook = t.mock.method(childProcess, 'spawnSync', new Proxy(spawn, { apply(target, receiver, args: unknown[]) {
    const options = args[2]; assert.ok(options && typeof options === 'object'); assert.equal(Reflect.get(options, 'timeout'), 3600000); observed = true;
    // A real stalled child reports the OS timeout; scale only the wait to keep the regression fast.
    return Reflect.apply(target, receiver, [process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...options, timeout: 25 }]);
  } })); syncBuiltinESMExports();
  try { assert.equal(runCoverageGate(root, { runner: { executable: process.execPath, script: 'unused.ts' }, error: line => lines.push(line) }), 1); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(observed, true); assert.match(lines.join('\n'), /coverage run exceeded its 3600000 ms deadline/);
  assert.doesNotMatch(lines.join('\n'), /failed to start/);
  assert.throws(() => readFileSync(join(root, 'coverage/coverage-summary.json')), { code: 'ENOENT' });
});

test('fleet inventory permits genuine non-Git directories and retains complete tracked names', async t => {
  const f = await fixture(t);
  assert.equal(fleetTrackedPaths(f.root), undefined);
  assert.match(fleetTrackedPaths(f.repo)!, /\.agents\/pm\//);
});

test('every unsuccessful fleet probe fails closed except verified non-repository completion', t => {
  const original = childProcess.spawnSync;
  for (const kind of ['ETIMEDOUT', 'ENOENT', 'ENOBUFS', 'signal', 'contradictory', 'fatal', 'negative']) {
    const hook = t.mock.method(childProcess, 'spawnSync', new Proxy(original, { apply() {
      return { status: kind === 'contradictory' ? 0 : kind === 'fatal' ? 128 : kind === 'negative' ? 1 : null, signal: 'SIGTERM', error: ['signal', 'fatal', 'negative'].includes(kind) ? undefined : Object.assign(new Error('Transport unavailable'), { code: kind }), stdout: 'partial\0', stderr: kind === 'fatal' ? 'fatal: cannot read object database\n' : '', pid: 0, output: [] };
    } })); syncBuiltinESMExports();
    try { assert.throws(() => fleetTrackedPaths('unused'), /incomplete inventory cannot pass/, kind); }
    finally { hook.mock.restore(); syncBuiltinESMExports(); }
  }
});
