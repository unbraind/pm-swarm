import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { acquireLock, acknowledgeLinkedTests, runLinkedTests, commitItemMutations, commitWorkspaceTransaction, mutateItem, readSettings } from '@unbrained/pm-cli/sdk';
import { trackerResourceBackend } from '../src/resource-tracker.ts';
import { changedFiles } from '../src/git.ts';
import { commitMutation, SettingsRefusal, updateSettings } from '../src/settings.ts';
import { canonicalize, containsPrivatePath } from '../src/privacy.ts';
import { fixture } from './helpers.ts';
import { fixtureGit as git } from './git-helpers.ts';
import { sharedFixture } from './shared-helpers.ts';
import { hostSdk, swarmHost, assertPrivacyRendering } from './settings-helpers.ts';
import { unchanged } from './privacy-snapshot.ts';
import { rejectedCorpus } from './privacy-corpus.ts';

/** Stable production write sites: new SDK or backend writers must join this inventory and its property. */
const WRITE_SITES = [
  'swarm.ts:mutateItem',
  'lease.ts:acquireLock', 'swarm.ts:acquireLock',
  'progress.ts:comments', 'resource-tracker.ts:update', 'resource-tracker.ts:update',
  'resources.ts:transact',
  'settings.ts:mutateWorkspaceSettings',
  'shared-tracker.ts:update', 'shared-tracker.ts:files', 'shared-tracker.ts:release', 'shared-tracker.ts:update',
  'close.ts:close',
  'swarm.ts:claim', 'swarm.ts:update', 'swarm.ts:update', 'swarm.ts:release', 'swarm.ts:files', 'swarm.ts:acknowledgeLinkedTests', 'swarm.ts:release',
  'test-runner.ts:runLinkedTests',
].sort();

/** Every native item mutation must carry an SDK history precondition, including no-op Git cleanup. */
const HISTORY_SITES = ['close.ts:close', 'swarm.ts:claim', 'swarm.ts:update', 'swarm.ts:update', 'swarm.ts:release', 'swarm.ts:release', 'swarm.ts:mutateItem', 'swarm.ts:files', 'resource-tracker.ts:update', 'resource-tracker.ts:update', 'shared-tracker.ts:release', 'shared-tracker.ts:update', 'shared-tracker.ts:update', 'shared-tracker.ts:files', 'progress.ts:comments'].sort();

/** Minimal parser shape keeps inventory traversal independent of compiler internals. */
interface AstNode { type: string; name?: string; property?: AstNode; object?: AstNode; callee?: AstNode; id?: AstNode; key?: AstNode; arguments?: AstNode[]; params?: AstNode[]; start?: number; end?: number }
/** Discover every client call, conservative provider write and imported SDK writer from authored source. */
function writeInventory(): string[] {
  const sites: string[] = []; const recovery: string[] = [];
  for (const file of readdirSync(new URL('../src', import.meta.url)).filter(file => file.endsWith('.ts'))) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const text = (node: AstNode | undefined) => source.slice(node?.start, node?.end);
    /** Require the writer to consume data from its nearest admission callback. */
    const visit = (raw: unknown, parents: AstNode[]) => {
      if (typeof raw !== 'object' || raw === null) return;
      if (Array.isArray(raw)) { for (const entry of raw) visit(entry, parents); return; }
      const node = raw as AstNode;
      if (node.type === 'CallExpression') {
        const expression = node.callee!;
        const method = expression.type === 'MemberExpression' ? expression.property?.name ?? '' : expression.name ?? '';
        const receiver = expression.type === 'MemberExpression' ? text(expression.object) : '';
        const writer = (/(?:^|\.)client$/.test(receiver) && !['get', 'listAllComplete'].includes(method) && !(method === 'run' && text(node.arguments?.[0]) === "'test'" && /list:\s*true/.test(text(node.arguments?.[1]))))
          || (receiver === 'sdk' && method !== 'isItemNotFoundError') || (receiver.endsWith('.backend') && method === 'transact')
          || ['acquireLock', 'acknowledgeLinkedTests', 'runLinkedTests', 'commitItemMutations', 'commitWorkspaceTransaction', 'commitItemCompletion', 'mutateItem'].includes(method);
        if (writer) {
          sites.push(`${file}:${method}`);
          let index = parents.length - 1;
          while (index >= 0 && parents[index].type !== 'ArrowFunctionExpression') index--;
          assert.ok(index >= 0, `${file}:${method}: missing admission callback`);
          const callback = parents[index]; const wrapper = parents[index - 1];
          const itemWriter = ['commitItemMutations', 'commitItemCompletion', 'commitWorkspaceTransaction', 'mutateItem'].includes(method) || /(?:^|\.)client$/.test(receiver) && !['get', 'listAllComplete', 'run'].includes(method);
          assert.ok(wrapper.type === 'CallExpression' && wrapper.callee?.name === (itemWriter ? 'commitItemMutation' : 'commitMutation'), `${file}:${method}: unguarded SDK writer`);
          if (itemWriter) assert.match(text(wrapper.arguments?.[0]), /\bitem(?:\s*[:,}])/, `${file}:${method}: missing full snapshot`);
          if (itemWriter) {
            recovery.push(`${file}:${method}`);
            assert.match(text(wrapper.arguments?.[2]), /\bhistory\b/, `${file}:${method}: missing native history precondition`);
            if (method === 'mutateItem') {
              const code = text(node); assert.ok(code.indexOf('await assertItemHistoryHead') >= 0 && code.indexOf('await assertItemHistoryHead') < code.indexOf('await cleanup()'), 'Git cleanup must check native history inside its locked SDK callback');
            }
          }
          assert.equal(callback.params?.[0]?.name, 'admitted');
          assert.ok(node.arguments?.some(argument => /\badmitted\b/.test(text(argument))), `${file}:${method}: writer ignored the admitted payload`);
        }
      }
      for (const [key, value] of Object.entries(raw)) if (!['loc', 'extra', 'comments', 'tokens'].includes(key)) visit(value, [...parents, node]);
    };
    visit(parse(source, { sourceType: 'module', plugins: ['typescript'] }), []);
  }
  assert.deepEqual(recovery.sort(), HISTORY_SITES);
  return sites.sort();
}

test('every SDK and backend write site consumes the single sink admission payload', () => {
  assert.deepEqual(writeInventory(), WRITE_SITES);
  console.log(JSON.stringify({ enumerated_write_sites: WRITE_SITES.length, sink_bypasses: 0, locked_history_sites: HISTORY_SITES.length }));
});

test('each enumerated sink refuses private values from CLI git settings files and peers before writing', async t => {
  const f = await sharedFixture(t); const id = await f.item(['src/public.ts']);
  const secret = ['notes', encodeURIComponent(['', 'home', 'private', 'work.ts'].join('/'))].join('/');
  const source = await fixture(t); const base = git(source.repo, ['rev-parse', 'HEAD']);
  source.write(secret, 'Synthetic source'); source.save([secret]);
  const configFile = join(f.repo, 'source-settings.json'); writeFileSync(configFile, JSON.stringify({ value: secret }));
  const inputFile = join(f.repo, 'source-note.txt'); writeFileSync(inputFile, secret);
  await f.client.comments(id, { add: secret });
  const peer = (await f.client.get(id, { depth: 'full' })).item.comments!.at(-1)!.text;
  const inputs = new Map([
    ['CLI', ['--note', secret][1]], ['git', changedFiles(source.repo, base, 'HEAD')[0]],
    ['settings', (JSON.parse(readFileSync(configFile, 'utf8')) as { value: string }).value],
    ['file', readFileSync(inputFile, 'utf8')], ['peer', peer],
  ]);
  const settings = await readSettings(f.pmRoot);
  let refused = 0;
  for (const site of writeInventory()) for (const [origin, value] of inputs) {
    // Every inventory row drives its actual SDK/backend kind with an inspected argument.
    // The static property above also binds each production call to that admitted argument.
    const method = site.split(':')[1];
    await unchanged(f.pmRoot, async () => {
      switch (method) {
        case 'mutateItem': return commitMutation({ id, author: value }, admitted => mutateItem({ ...admitted, pmRoot: f.pmRoot, settings, op: 'update', mutate: document => { document.metadata.description = admitted.author; return { changedFields: ['description'] }; } }));
        case 'acquireLock': return commitMutation({ resource: 'privacy-probe', author: value }, async admitted => { const release = await acquireLock(f.pmRoot, admitted.resource, 30, admitted.author); await release(); });
        case 'commitItemMutations': return commitMutation({ author: value, transactionId: 'privacy-probe', mutations: [{ op: 'close' as const, id, reason: value }] }, admitted => commitItemMutations({ ...admitted, pmRoot: f.pmRoot }));
        case 'commitWorkspaceTransaction': return commitMutation({ author: value, transactionId: 'privacy-probe' }, admitted => commitWorkspaceTransaction({ ...admitted, pmRoot: f.pmRoot, steps: [{ id: 'probe', async inspect() { return { state: 'pending' }; }, async apply() { return null; }, async compensate() {} }] }));
        case 'close': return commitMutation({ id, note: value }, admitted => f.client.close(admitted.id, admitted.note));
        case 'restore': return commitMutation({ id, target: value }, admitted => f.client.restore(admitted.id, admitted.target));
        case 'update': return commitMutation({ id, options: { comment: [value] } }, admitted => f.client.update(admitted.id, admitted.options));
        case 'files': return commitMutation({ id, options: { add: [value] } }, admitted => f.client.files(admitted.id, admitted.options));
        case 'claim': return commitMutation({ id, options: { author: value } }, admitted => f.client.claim(admitted.id, admitted.options));
        case 'release': return commitMutation({ id, options: { author: value } }, admitted => f.client.release(admitted.id, admitted.options));
        case 'comments': return commitMutation({ id, options: { add: value } }, admitted => f.client.comments(admitted.id, admitted.options));
        case 'transact': return commitMutation({ id, author: value }, admitted => trackerResourceBackend(f.shared.engine).transact(admitted.id, admitted.author, record => record));
        case 'mutateWorkspaceSettings': return commitMutation({ operationId: value }, async admitted => (await hostSdk(f.pmRoot)).mutateWorkspaceSettings({ ...admitted, mutate: current => current }));
        case 'acknowledgeLinkedTests': return commitMutation({ tests: [{ command: value, scope: 'project' as const }] }, admitted => acknowledgeLinkedTests(f.pmRoot, admitted.tests, new Date().toISOString()));
        case 'runLinkedTests': return commitMutation({ tests: [{ command: value, scope: 'project' as const }] }, admitted => runLinkedTests(admitted.tests, undefined, { pmRoot: f.pmRoot }));
        default: assert.fail(`Missing sink property for ${site}`);
      }
    }, `${site}/${origin}`, error => error instanceof SettingsRefusal && error.code === 'swarm_private_path');
    refused++;
  }
  console.log(JSON.stringify({ write_sites: WRITE_SITES.length, sources: inputs.size, refused_sink_cases: refused, durable_changes: 0, partial_receipts: 0 }));
});

test('Git-derived sync links are refused by the sink before item and history publication', async t => {
  const f = await fixture(t); const id = await f.item(['src/public.ts']);
  const lane = await f.swarm.start(id, { root: join(f.root, 'lanes') });
  const value = ['notes', encodeURIComponent(['', 'home', 'private', 'work.ts'].join('/'))].join('/');
  f.write(value, 'Synthetic work', lane.worktree); f.save([value], lane.worktree);
  await assert.rejects(f.swarm.sync(id), SettingsRefusal);
  await unchanged(f.pmRoot, () => f.swarm.sync(id, true), 'git-derived-sync', error => error instanceof SettingsRefusal && error.code === 'swarm_private_path');
  const host = await swarmHost(); await assertPrivacyRendering(host, value, true);
});

test('the freshly locked full settings patch refuses private foreign values before audit publication', async t => {
  const f = await sharedFixture(t); const sdk = await hostSdk(f.pmRoot);
  await sdk.mutateWorkspaceSettings({ operationId: 'foreign-settings-source', mutate: current => ({ ...current, swarm: { foreign_location: encodeURIComponent(['', 'home', 'private', 'settings'].join('/')) } }) });
  await unchanged(f.pmRoot, () => updateSettings(sdk, f.pmRoot, { lane_limit: 3 }, { apply: true, operationId: 'private-foreign-patch' }), 'settings/foreign-patch', error => error instanceof SettingsRefusal && error.code === 'swarm_private_path');
});

/** Deterministic noise containing invalid UTF-8, incomplete escapes and punctuation around encoded content. */
function garbage(seed: number): () => string {
  let state = seed;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return ['%ff', '%c0%af', '%e2%82', '%ed%a0%80', '%f5%80', '%80', '%zz', '%', '%1', '<>', '"'][((state >>> 0) % 11)]; };
}

test('lossless percent canonicalization preserves every encoded home beside random malformed neighbors', () => {
  const noise = garbage(0x8badf00d); let checks = 0; let corpusChecks = 0;
  const explicit = `%ff${encodeURIComponent(['', 'home', 'private', 'work'].join('\uff0f'))}`;
  assert.equal(containsPrivatePath(explicit), true, 'malformed byte before encoded fullwidth separators');
  for (let index = 0; index < 128; index++) {
    const home = ['', 'home', `private-${index}`, `case-${index}`].join('/');
    const canonical = canonicalize(home)!;
    for (const [name, encoded] of rejectedCorpus) {
      const corpusForm = encoded.replaceAll('private', `private-${index}`).replaceAll('project', `case-${index}`) + (['home-variable-bare', 'tilde-bare'].includes(name) ? `/case-${index}` : '');
      assert.equal(containsPrivatePath(`${noise()}${corpusForm}${noise()}`), true, `noisy corpus case ${corpusChecks}`); corpusChecks++;
      // Independent random home paths cover raw UTF-8 and nested percent, JSON and HTML forms too.
      for (const form of [encodeURIComponent(home), encodeURIComponent(home.replaceAll('/', '\uff0f')), encodeURIComponent(encodeURIComponent(home)), home.replaceAll('/', '\\u002f'), home.replaceAll('/', '&#47;')]) {
        const wrapped = `${noise()}${form}${noise()}`;
        assert.ok(canonicalize(wrapped)?.includes(canonical), `decoder seed case ${checks}`); checks++;
      }
    }
  }
  console.log(JSON.stringify({ decoder_seed: '0x8badf00d', random_homes: 128, encodings: rejectedCorpus.length, property_checks: checks, noisy_corpus_refusals: corpusChecks, lost_paths: 0 }));
});

for (const mode of ['shared', 'Git'] as const) {
  test(`${mode} reaper skips unsafe foreign context before release or lane deletion`, async t => {
    const f = mode === 'shared' ? await sharedFixture(t) : await fixture(t);
    const id = await f.item(['src/public.ts']); const engine = 'shared' in f ? f.shared : f.swarm;
    await engine.start(id);
    await f.client.update(id, { title: encodeURIComponent(['', 'home', 'private', 'foreign'].join('/')), status: 'closed', message: 'Fixture terminal state for privacy recovery validation' });
    await f.client.claim(id, { force: true });
    const before = (await f.client.get(id, { depth: 'full' })).item;
    const result = await engine.reap();
    assert.deepEqual(result.released, []); assert.deepEqual(result.removed, []);
    assert.equal(result.refused.length, 1); assert.match(result.refused[0].reason, /Unsafe foreign context/);
    assert.deepEqual((await f.client.get(id, { depth: 'full' })).item, before);
    if ('swarm' in f) assert.equal(git(f.repo, ['branch', '--list', `swarm/${id}`]).length > 0, true);
  });
}
