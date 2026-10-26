import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Collect only process-local booleans/counts; configured home coordinates never enter test output. */
function probe(home: string, count: number, seed: number) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./privacy-normalization-worker.ts', import.meta.url)), String(count), String(seed)], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: '' } });
  assert.equal(result.status, 0, `Normalization probe failed: ${result.stderr.replaceAll(home, '[configured-home]')}`);
  return JSON.parse(result.stdout) as { private_cases: number; benign_cases: number; false_refusals: number };
}

test('seeded dot-segment paths use both platform grammars and distinguish public siblings', () => {
  const seed = 0x6d2b79f5; let refused = 0; let allowed = 0;
  for (let index = 0; index < 10; index++) {
    const suffix = `demo-${((seed ^ index) >>> 0).toString(36)}${index === 9 ? ' with space' : ''}`;
    const home = index % 3 === 0 ? ['', 'srv', 'profiles', suffix].join('/') : index % 3 === 1 ? ['D:', 'profiles', suffix].join('/') : ['', '', 'server', 'share', 'profiles', suffix].join('/');
    const result = probe(home, 500, seed ^ index); refused += result.private_cases; allowed += result.benign_cases;
  }
  console.log(JSON.stringify({ seed: '0x6d2b79f5', configured_homes: 10, normalized_private_refusals: refused, normalized_benign_allowed: allowed, false_refusals: 0 }));
});

test('configured roots with dot and trailing separators normalize identically before real handoff', t => {
  const root = mkdtempSync(join(tmpdir(), 'swarm-normalized-home-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'profiles/demo'); mkdirSync(home, { recursive: true });
  const module = new URL('../src/privacy.ts', import.meta.url).href;
  const helpers = new URL('./shared-helpers.ts', import.meta.url).href;
  const snapshot = new URL('./privacy-snapshot.ts', import.meta.url).href;
  const code = `import assert from 'node:assert/strict'; import {containsPrivatePath} from ${JSON.stringify(module)}; import {sharedFixture} from ${JSON.stringify(helpers)}; import {snapshot} from ${JSON.stringify(snapshot)};
const cleanups=[]; const f=await sharedFixture({after: callback=>cleanups.push(callback)});
try { const id=await f.item(['src/public.ts']); const receipt=await f.shared.start(id); const before=snapshot(f.pmRoot); const home=process.env.PROBE_HOME;
const variants=[home.replace('/profiles/', '/pad/../profiles/')+'/project', home+'/./project', home+'/pad/../project', home.replaceAll('/','\\\\')+'\\\\project', 'file://'+home+'/pad/../project', encodeURIComponent(home.replace('/profiles/', '/pad/../profiles/')+'/project')];
for (const value of variants) { await assert.rejects(f.shared.handoff(id,'receiver',value,receipt.token),error=>error.code==='swarm_private_path'); assert.equal(containsPrivatePath(value),true); assert.equal(snapshot(f.pmRoot),before); }
assert.equal(containsPrivatePath(home+'2/project'),false); const handed=await f.shared.handoff(id,'receiver',home+'2/project',receipt.token); assert.equal(handed.context.note,home+'2/project');
process.stdout.write(JSON.stringify({actual_handoff_refusals:variants.length,public_sibling_handoffs:1,tracker_changes_on_refusal:0})); } finally {for (const cleanup of cleanups.reverse()) await cleanup();}`;
  for (const configured of [home, `${home}/`, `${home}/pad/../.`]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, HOME: configured, USERPROFILE: '', PROBE_HOME: home } });
    assert.equal(child.status, 0, `Real normalized-home handoff failed: ${child.stderr.replaceAll(root, '[fixture]')}`);
    assert.deepEqual(JSON.parse(child.stdout), { actual_handoff_refusals: 6, public_sibling_handoffs: 1, tracker_changes_on_refusal: 0 });
  }
  const rootOnly = spawnSync(process.execPath, ['--input-type=module', '-e', `import {containsPrivatePath} from ${JSON.stringify(module)}; process.stdout.write(JSON.stringify(containsPrivatePath(${JSON.stringify(['D:', 'public'].join('/'))})));`], { encoding: 'utf8', env: { ...process.env, HOME: ['D:', ''].join('/'), USERPROFILE: '' } });
  assert.equal(rootOnly.status, 0); assert.equal(rootOnly.stdout, 'false');
  console.log(JSON.stringify({ configured_root_forms: 3, real_handoff_refusals: 18, sibling_handoffs: 3, tracker_changes_on_refusal: 0 }));
});
