import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('whole punctuation runs normalize before privacy decisions across random homes and every mutating variant', () => {
  const seed = 0xc0ffee71; let privateCases = 0; let allowedCases = 0; let renderers = 0;
  for (let index = 0; index < 20; index++) {
    const suffix = `demo-${((seed ^ (index * 2654435761)) >>> 0).toString(36)}${['', ';root', ',root', '=root', '#root'][index % 5]}`;
    const home = ['', 'srv', 'profiles', suffix].join('/');
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./privacy-punctuation-worker.ts', import.meta.url)), '250', String(seed ^ index)], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: '' }, timeout: 120000 });
    assert.equal(child.status, 0, `Punctuation worker ${index}: ${child.stderr.replaceAll(home, '[configured-home]')}`);
    const result = JSON.parse(child.stdout) as { private_cases: number; allowed_cases: number; renderer_cases: number; variants: number };
    assert.equal(result.variants, 19); privateCases += result.private_cases; allowedCases += result.allowed_cases; renderers += result.renderer_cases;
  }
  assert.equal(privateCases, 5000); assert.equal(allowedCases, 5000);
  console.log(JSON.stringify({ seed: '0xc0ffee71', random_homes: 20, private_cases: privateCases, allowed_cases: allowedCases, command_refusals: privateCases * 19, command_admissions: allowedCases * 19, renderer_cases: renderers, false_refusals: 0, escapes: 0 }));
});

test('native handoff refuses punctuation aliases before any tracker byte or receipt changes', () => {
  const home = ['', 'srv', 'profiles', 'demo'].join('/');
  const helpers = new URL('./shared-helpers.ts', import.meta.url).href;
  const snapshots = new URL('./privacy-snapshot.ts', import.meta.url).href;
  const code = `import assert from 'node:assert/strict'; import {sharedFixture} from ${JSON.stringify(helpers)}; import {snapshot} from ${JSON.stringify(snapshots)};
const cleanups=[]; const f=await sharedFixture({after:callback=>cleanups.push(callback)});
try { f.env.HOME=process.env.PROBE_HOME; const id=await f.item(['src/public.ts']); const receipt=await f.shared.start(id); f.run('swarm','settings');
let count=0; for(const punctuation of [';',',',':','=','#','|']) { const path=process.env.PROBE_HOME.replace('/profiles/','/pad'+punctuation+'name/../profiles/')+'/project';
for(const value of [path,encodeURIComponent(path),'[source](<'+path+'>)']) { const before=snapshot(f.pmRoot); const result=f.cli('swarm','handoff',id,'--to','receiver','--token',receipt.token,'--note',value,'--json');
assert.equal(result.status,2); const output=result.stdout+result.stderr; assert.match(output,/swarm_private_path/); assert.equal(output.includes(value),false); assert.equal(snapshot(f.pmRoot),before); count++; } }
const benign=process.env.PROBE_HOME+'2/project'; const success=f.run('swarm','handoff',id,'--to','receiver','--token',receipt.token,'--note',benign); assert.equal(success.context.note,benign);
process.stdout.write(JSON.stringify({refused_handoffs:count,tracker_changes:0,partial_receipts:0,benign_handoffs:1})); }finally{for(const cleanup of cleanups.reverse())await cleanup();}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: '', PROBE_HOME: home }, timeout: 120000 });
  assert.equal(result.status, 0, result.stderr.replaceAll(home, '[configured-home]'));
  assert.deepEqual(JSON.parse(result.stdout), { refused_handoffs: 18, tracker_changes: 0, partial_receipts: 0, benign_handoffs: 1 });
});
