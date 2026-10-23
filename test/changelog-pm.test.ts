import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runChangelogPm } from '../scripts/changelog-pm.ts';
import { sharedFixture } from './shared-helpers.ts';

test('changelog bridge preserves complete core reads, schema discovery and host failures', async t => {
  const f = await sharedFixture(t); const id = await f.item(['src/linked.ts']);
  const script = join(import.meta.dirname, '../scripts/changelog-pm.ts');
  /** Exercise the actual executable and capture its forwarded SDK output. */
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  const list = run('--pm-path', f.pmRoot, '--output-budget', 'unbounded', '--output-limit', 'unbounded', 'list', '--all', '--json');
  assert.equal(list.status, 0, list.stderr);
  const result = JSON.parse(list.stdout) as { items: { id: string; files: { path: string }[] }[]; omission_receipt: { has_omissions: boolean } };
  assert.equal(result.omission_receipt.has_omissions, false);
  assert.equal(result.items[0].id, id); assert.equal(result.items[0].files[0].path, 'src/linked.ts');
  assert.equal(run('--pm-path', f.pmRoot, 'schema', 'list', '--json').status, 0);
  assert.equal(run('invalid-command').status, 2);
  const killed = join(f.repo, 'killed.js'); writeFileSync(killed, "process.kill(process.pid, 'SIGKILL');\n");
  assert.equal(runChangelogPm([], killed), 1, 'a signaled reader must fail closed');
});
