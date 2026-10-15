import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createExtensionTestHarness } from '@unbrained/pm-cli/sdk/testing';
import type { CommandHandlerContext, ExtensionApi } from '@unbrained/pm-cli/sdk/authoring';
import extension from '../index.ts';
import { runCommand } from '../src/commands.ts';
import { fixture } from './helpers.ts';

test('registered host commands exercise SDK settings, flags and every command dispatcher', async t => {
  const f = await fixture(t); const ext = await createExtensionTestHarness(extension, { name: 'pm-swarm', capabilities: ['commands', 'schema'] });
  /** Run the real host dispatcher with its native bound SDK context. */
  const run = (command: string, options: Record<string, unknown> = {}, args: string[] = []) => ext.runCommand({ command: `swarm ${command}`, pmRoot: f.pmRoot, global: { author: 'swarm-test' }, options, args });
  assert.ok(await run('settings'));
  await run('settings', { base: 'main', root: '../lanes', branchPrefix: 'parallel/', limit: '2', apply: true });
  const prefs = JSON.parse(readFileSync(join(f.pmRoot, 'settings.json'), 'utf8')) as { swarm: { branch_prefix: string; lane_limit: number } };
  assert.equal(prefs.swarm.branch_prefix, 'parallel/'); assert.equal(prefs.swarm.lane_limit, 2);
  await assert.rejects(run('settings', { root: f.root, apply: true }), /relative/);
  await assert.rejects(run('settings', { root: 'C:/private', apply: true }), /relative/);
  await assert.rejects(run('settings', { base: ['bad'] }), /nonempty/);
  await assert.rejects(run('settings', { limit: 'bad' }), /integer/);
  const id = await f.item(['code.txt']); f.write('code.txt', 'base\n'); f.save(['.agents/pm', 'code.txt']);
  assert.ok(await run('plan', { parent: 'absent', limit: '1' }));
  await assert.rejects(run('start'), /id is required/);
  await run('start', { agent: 'swarm-test' }, [id]);
  await run('status'); await run('sync', {}, [id]); await run('sync', { apply: true, dryRun: true }, [id]); await run('sync', { apply: true }, [id]);
  await run('land'); await run('reap', { dryRun: true }); await run('reap');
});

test('command entry refuses missing host SDK and unknown verbs with expected errors', async t => {
  const f = await fixture(t);
  const ctx: CommandHandlerContext = { command: 'swarm plan', args: [], options: {}, global: {}, pm_root: f.pmRoot };
  await assert.rejects(runCommand('plan', ctx), /host SDK/);
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
