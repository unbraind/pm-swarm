import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanMutationSecrets } from '@unbrained/pm-cli/sdk';
import { containsPrivatePath } from '../src/privacy.ts';
import { validateCommandInputs } from '../src/admission.ts';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { benignCorpus, embeddedCorpus } from './privacy-corpus.ts';
import { mutationInputs, mutationVariants } from './privacy-mutations.ts';
import { sharedFixture } from './shared-helpers.ts';
import { hostSdk, swarmHost, assertPrivacyRendering } from './settings-helpers.ts';
import { snapshot } from './privacy-snapshot.ts';
import { homeFuzz } from './privacy-fuzz.ts';

test('embedded home paths are found across Markdown JSON shell and URL substrings', () => {
  const missed: string[] = [];
  for (const [name, value] of embeddedCorpus) {
    assert.equal(containsPrivatePath(value), true, name);
    if (!scanMutationSecrets(value).some(finding => finding.rule === 'absolute_home_path')) missed.push(name);
  }
  console.log(JSON.stringify({ embedded_cases: embeddedCorpus.length, refused: embeddedCorpus.length, raw_sdk_missed: missed }));
});

test('Unicode folding precedes percent decoding for composed home encodings', () => {
  const cases = homeFuzz(0x51a7c0de, 5000);
  for (const index of [1779, 2997, 3365, 3695]) assert.equal(containsPrivatePath(cases[index]), true, `home seed case ${index}`);
});

test('benign prose URLs and non-home roots pass every registered mutation admission and renderer', async t => {
  const f = await sharedFixture(t); const sdk = await hostSdk(f.pmRoot); const host = await swarmHost();
  const before = snapshot(f.pmRoot);
  for (const [name, value] of benignCorpus) {
    assert.equal(containsPrivatePath(value), false, name);
    for (const variant of mutationVariants()) {
      validateCommandInputs(variant.command, { command: `swarm ${variant.command}`, ...mutationInputs(variant), global: { author: value }, sdk, pm_root: f.pmRoot, source_workspace_root: f.repo });
    }
    await assertPrivacyRendering(host, value, false);
  }
  assert.equal(snapshot(f.pmRoot), before);
  console.log(JSON.stringify({ benign_cases: benignCorpus.length, mutation_admissions: benignCorpus.length * mutationVariants().length, renderer_admissions: benignCorpus.length * 2, false_refusals: 0 }));
});

test('native SDK handoff stores benign notes and returns truthful rendered receipts', async t => {
  const f = await sharedFixture(t); const id = await f.item(['src/public.ts']);
  let receipt = await f.shared.start(id); let owner = 'shared-test';
  const host = await swarmHost();
  for (const [name, note] of benignCorpus) {
    const to = owner === 'shared-test' ? 'receiver' : 'shared-test';
    const tracker = new SharedTracker(new Swarm(f.repo, f.pmRoot, f.client, owner));
    const handed = await tracker.handoff(id, to, note, String(receipt.token));
    assert.equal(handed.context.note, note, name);
    assert.equal((await f.client.get(id)).item.assignee, to, name);
    await assertPrivacyRendering(host, note, false);
    receipt = { ...receipt, token: handed.token }; owner = to;
  }
  console.log(JSON.stringify({ benign_handoffs: benignCorpus.length, false_refusals: 0 }));
});

test('configured and real process homes are private even outside conventional home roots', t => {
  const root = mkdtempSync(join(tmpdir(), 'swarm-home-oracle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, '[owned].home'); mkdirSync(real);
  const alias = join(root, 'alias'); symlinkSync(real, alias, 'dir');
  const module = new URL('../src/privacy.ts', import.meta.url).href;
  const code = `import { containsPrivatePath } from ${JSON.stringify(module)}; const home = process.env.HOME; process.stdout.write(JSON.stringify([containsPrivatePath(home + '/x'), containsPrivatePath(process.env.PROBE_PATH), containsPrivatePath('https://example.test/?p=' + encodeURIComponent(process.env.PROBE_PATH)), containsPrivatePath('Option A: kept the cache; took ~5 min')]));`;
  for (const [home, candidate, expected] of [[alias, `${realpathSync(real)}/x`, true], [join(root, 'future'), `${root}/future/x`, true], ['/', ['', 'usr', 'bin'].join('/'), false], ['', ['', 'usr', 'bin'].join('/'), false]] as const) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, HOME: home, PROBE_PATH: candidate } });
    assert.equal(child.status, 0, 'Process-home probe failed');
    assert.deepEqual(JSON.parse(child.stdout), [expected, expected, expected, false]);
  }
});
