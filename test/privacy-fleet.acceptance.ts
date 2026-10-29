import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { containsPrivatePath } from '../src/privacy.ts';
import { pathPresentations } from './privacy-path-samples.ts';

test('every tracked relative fleet path is allowed bare and within prose or Markdown', t => {
  const fleet = process.env.PUBLIC_FLEET_ROOT ?? resolve(import.meta.dirname, '../../..', 'fleet');
  if (!existsSync(fleet)) { t.skip('Optional read-only fleet checkout corpus is unavailable'); return; }
  const inventory = createHash('sha256');
  let repositories = 0; let paths = 0; let presentations = 0; let skipped = 0;
  const shapes = { parentheses: 0, brackets: 0, slots: 0, spaces: 0 };
  for (const entry of readdirSync(fleet, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const result = spawnSync('git', ['-C', join(fleet, entry.name), 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    if (result.status !== 0) { skipped++; continue; }
    repositories++; inventory.update(entry.name).update('\0').update(result.stdout);
    for (const path of result.stdout.split('\0').filter(Boolean)) {
      paths++;
      if (/[()]/.test(path)) shapes.parentheses++;
      if (/[[\]]/.test(path)) shapes.brackets++;
      if (/(?:^|\/)@/.test(path)) shapes.slots++;
      if (/\s/.test(path)) shapes.spaces++;
      const identity = createHash('sha256').update(path).digest('hex').slice(0, 16);
      for (const [index, value] of pathPresentations(path).entries()) {
        assert.equal(containsPrivatePath(value), false, `relative path fingerprint ${identity}, presentation ${index}`);
        presentations++;
      }
    }
  }
  assert.ok(repositories > 0 && paths > 0);
  console.log(JSON.stringify({ inventory_sha256: inventory.digest('hex'), repositories, tracked_relative_paths: paths, presentations, shapes, false_refusals: 0, skipped_non_git_directories: skipped, source_writes: 0 }));
});
