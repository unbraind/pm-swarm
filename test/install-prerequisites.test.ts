import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

for (const kind of ['missing', 'failed', 'empty', 'working'] as const) {
  test(`packed acceptance Bun prerequisite handles ${kind} executable`, t => {
    const bin = mkdtempSync(join(tmpdir(), 'swarm-bun-probe-'));
    t.after(() => rmSync(bin, { recursive: true, force: true }));
    if (kind !== 'missing') {
      const script = kind === 'failed' ? 'process.exit(7)' : kind === 'empty' ? '' : 'process.stdout.write(process.execPath)';
      writeFileSync(join(bin, 'bun'), `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
    }
    const script = `import { requireBun } from ${JSON.stringify(new URL('./install-helpers.ts', import.meta.url).href)}; process.stdout.write(requireBun());`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PATH: bin }, encoding: 'utf8' });
    if (kind === 'working') {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, process.execPath);
    } else {
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /packed acceptance requires Bun on PATH/);
      assert.doesNotMatch(result.stderr, /TypeError/);
    }
  });
}

for (const scenario of ['packed npm/npx', 'packed npm tarball', 'packed bun tarball']) {
  test(`${scenario} reports missing Bun before consumer setup`, t => {
    const bin = mkdtempSync(join(tmpdir(), 'swarm-acceptance-prerequisite-'));
    t.after(() => rmSync(bin, { recursive: true, force: true }));
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${scenario}`, join(import.meta.dirname, 'install.acceptance.ts')], { env, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /packed acceptance requires Bun on PATH/);
    assert.doesNotMatch(result.stdout + result.stderr, /TypeError/);
  });
}
