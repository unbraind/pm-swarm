import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import { createExtensionTestHarness } from '@unbrained/pm-cli/sdk/testing';
import type { CommandHandlerContext, ExtensionApi } from '@unbrained/pm-cli/sdk/authoring';
import extension from '../index.ts';
import { runCommand } from '../src/commands.ts';
import { fixture, swarmCli } from './helpers.ts';
import { assertFixtureRepo, fixtureGit as git } from './git-helpers.ts';
import { sharedFixture } from './shared-helpers.ts';

test('registered host commands exercise SDK settings, flags and every command dispatcher', async t => {
  const f = await fixture(t); const ext = await createExtensionTestHarness(extension, { name: 'pm-swarm', capabilities: ['commands', 'schema', 'renderers', 'hooks'] });
  /** Run the real host dispatcher with its native bound SDK context. */
  const run = (command: string, options: Record<string, unknown> = {}, args: string[] = []) => ext.runCommand({ command: `swarm ${command}`, pmRoot: f.pmRoot, global: { author: 'swarm-test' }, options, args });
  assert.ok(await run('settings'));
  await run('settings', { base: 'main', root: 'lanes', branchPrefix: 'parallel/', limit: '2', apply: true });
  const prefs = JSON.parse(readFileSync(join(f.pmRoot, 'settings.json'), 'utf8')) as { swarm: { branch_prefix: string; lane_limit: number } };
  assert.equal(prefs.swarm.branch_prefix, 'parallel/'); assert.equal(prefs.swarm.lane_limit, 2);
  await assert.rejects(run('settings', { root: f.root, apply: true }), /relative/);
  await assert.rejects(run('settings', { root: 'C:/private', apply: true }), /relative/);
  await assert.rejects(run('settings', { base: ['bad'] }), /nonempty/);
  await assert.rejects(run('settings', { limit: 'bad' }), /integer/);
  const id = await f.item(['code.txt']); f.write('code.txt', 'base\n'); f.save(['.agents/pm', 'code.txt']);
  assert.ok(await run('plan', { parent: 'absent', limit: '1' }));
  await assert.rejects(run('start'), /id is required/);
  assertFixtureRepo(f.repo);
  const packageRepo = git(process.cwd(), ['worktree', 'list', '--porcelain']);
  const foreign = join(f.root, 'foreign'); mkdirSync(foreign); git(foreign, ['init', '-b', 'main']);
  f.save([], foreign);
  const originalCwd = process.cwd();
  let started: { worktree: string };
  try {
    process.chdir(foreign);
    started = (await run('start', { agent: 'swarm-test' }, [id])).result as { worktree: string };
  } finally { process.chdir(originalCwd); }
  assert.equal(git(foreign, ['worktree', 'list', '--porcelain']).includes('parallel/'), false);
  assert.equal(started.worktree, join('lanes', `repo-${id}`));
  assert.equal(git(process.cwd(), ['worktree', 'list', '--porcelain']), packageRepo);
  assert.match(git(f.repo, ['config', '--get', `swarm.lane.${id}`]), /lanes/);
  await run('status'); await run('sync', {}, [id]); await run('sync', { apply: true, dryRun: true }, [id]); await run('sync', { apply: true }, [id]);
  await run('land'); await run('reap', { dryRun: true }); await run('reap');
});

test('command entry refuses missing host SDK and unknown verbs with expected errors', async t => {
  const f = await fixture(t);
  const ctx: CommandHandlerContext = { command: 'swarm plan', args: [], options: {}, global: {}, pm_root: f.pmRoot };
  await assert.rejects(runCommand('plan', ctx), /host SDK/);
});

test('command errors redact private paths from independent native SDK hook refusals', async t => {
  const f = await sharedFixture(t); const id = await f.item(['src/public.ts']);
  const privateValue = ['', 'home', 'private', 'peer-hook'].join('/');
  // Load an independent native policy in a fresh CLI process, without replacing SDK services.
  writeFileSync(join(f.pmRoot, 'extensions/pm-swarm/entry.js'), `import extension from ${JSON.stringify(new URL('../index.ts', import.meta.url).href)};
export default { activate(api) { extension.activate(api); api.hooks.beforeMutation(() => ({ allow: false, code: 'peer_policy', message: ${JSON.stringify(`Policy denied ${privateValue}`)}, remediation: 'Resolve the independent policy before retrying.' })); } };\n`);
  const result = f.cli('swarm', 'start', id, '--json'); const diagnostics = result.stdout + result.stderr;
  assert.equal(result.status, 2); assert.match(diagnostics, /swarm_private_path/); assert.match(diagnostics, /paths from value; replace them with project-relative/);
  assert.equal(diagnostics.includes(privateValue), false);
  assert.equal((await f.client.get(id)).item.assignee, undefined);
});

test('native host context resolves the default author and rejects unknown command verbs', async t => {
  const f = await fixture(t);
  const ext = await createExtensionTestHarness({
    /** Register test adapters through the actual host SDK, without replacing its services. */
    activate(api: ExtensionApi) {
      api.registerCommand({ name: 'fallback', run: ctx => runCommand('plan', ctx) });
      api.registerCommand({ name: 'unknown', run: ctx => runCommand('unknown', ctx) });
    },
  }, { name: 'context-adapter', capabilities: ['commands'] });
  assert.ok(await ext.runCommand({ command: 'fallback', pmRoot: f.pmRoot }));
  await assert.rejects(ext.runCommand({ command: 'unknown', pmRoot: f.pmRoot }), /Unknown swarm/);
});

test('plan hides certified read receipts by default and retains them for full and JSON output', async t => {
  const f = await fixture(t); for (let index = 0; index < 13; index++) await f.item([`src/file-${index}.ts`]);
  const ext = await createExtensionTestHarness(extension, { name: 'pm-swarm', capabilities: ['commands', 'schema', 'renderers', 'hooks'] });
  const compact = (await ext.runCommand({ command: 'swarm plan', pmRoot: f.pmRoot, global: { json: false } })).result as Record<string, unknown>;
  assert.equal('complete_list' in compact, false); assert.equal('read_output' in compact, false);
  for (const args of [{ options: { full: true }, global: { json: false } }, { global: { json: true } }]) {
    const full = (await ext.runCommand({ command: 'swarm plan', pmRoot: f.pmRoot, ...args })).result as { complete_list: { item_count: number }; read_output: unknown };
    assert.equal(full.complete_list.item_count, 13); assert.ok(full.read_output);
  }
  await ext.runCommand({ command: 'swarm status', pmRoot: f.pmRoot, options: { full: true } });
});

test('fixture mutation guards refuse a nested directory resolving to its parent repository', async t => {
  const f = await fixture(t); const nested = join(f.repo, 'nested'); mkdirSync(nested);
  const before = git(f.repo, ['config', '--local', '--list']);
  assert.throws(() => git(nested, ['config', '--local', 'swarm.leak', 'forbidden']), /Fixture Git root escaped/);
  assert.throws(() => f.save(['.agents/pm'], nested), /Fixture Git root escaped/);
  assert.equal(git(f.repo, ['config', '--local', '--list']), before);
});


for (const useAgent of [false, true]) test(`CLI reap and sync ${useAgent ? 'accept --agent and release only that stale claim' : 'preserve foreign stale claims for the default principal'}`, async t => {
  const f = await fixture(t); const ids = [await f.item(), await f.item()]; f.save();
  /** Exercise real CLI option parsing and SDK ownership against the fixture tracker. */
  const run = (...args: string[]) => {
    const result = swarmCli(f, args);
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout) as { released: string[]; dry_run: boolean };
  };
  for (const [index, id] of ids.entries()) run('start', id, '--agent', index === 0 ? 'lane-agent' : 'foreign-agent');
  assert.equal(run('sync', ids[0], '--agent', 'lane-agent', '--apply').dry_run, false);
  for (const [index, id] of ids.entries()) {
    await f.client.update(id, { status: 'closed', message: 'Fixture completed' });
    await f.client.claim(id, { author: index === 0 ? 'lane-agent' : 'foreign-agent', force: true });
  }
  const reaped = run('reap', ...(useAgent ? ['--agent', 'lane-agent'] : []));
  assert.deepEqual(reaped.released, useAgent ? [ids[0]] : []);
  const [own, foreign] = await Promise.all(ids.map(id => f.client.get(id)));
  assert.equal(own.claim_state?.claimed, !useAgent); assert.equal(foreign.claim_state?.assignee, 'foreign-agent');
});

test('SDK host harness retains Git generic and native refusal statuses', async t => {
  const f = await fixture(t);
  const host = await createExtensionTestHarness(extension, { name: 'pm-swarm', capabilities: ['commands', 'schema', 'renderers', 'hooks'] });
  /** Exercise the SDK handler directly as well as the separately loaded CLI module graph. */
  const start = (id: string) => host.runCommand({ command: 'swarm start', args: [id], pmRoot: f.pmRoot, global: { author: 'swarm-test' } });
  await assert.rejects(start('swarm-test-absent'), (error: unknown) => isPmCliExpectedError(error) && error.exitCode === 3);
  const id = await f.item(['src']); await f.client.claim(id, { author: 'foreign-worker' });
  await assert.rejects(start(id), (error: unknown) => isPmCliExpectedError(error) && error.exitCode === 1);
});
