import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { supportedHostSpec } from './install-helpers.ts';

test('the packed host install spec is derived from the declared peer dependency floor', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { peerDependencies: Record<string, string> };
  const range = manifest.peerDependencies['@unbrained/pm-cli'];
  const floor = range.startsWith('>=') ? range.slice(2) : range;
  assert.match(supportedHostSpec(), /^@unbrained\/pm-cli@\d+\.\d+\.\d+/, 'the spec must name an exact installable host version');
  assert.equal(supportedHostSpec(), `@unbrained/pm-cli@${floor}`, 'a hard-coded or stale host literal drifts from the declared floor');
});

test('changing the declared floor changes both real packed install paths without editing helper code', t => {
  const root = mkdtempSync(join(tmpdir(), 'swarm-host-floor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'test')); mkdirSync(join(root, 'src'));
  for (const file of ['test/install-helpers.ts', 'src/git-environment.ts']) {
    writeFileSync(join(root, file), readFileSync(new URL(`../${file}`, import.meta.url)));
  }
  for (const floor of ['2026.10.23', '2027.1.7', '2040.12.31']) {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', peerDependencies: { '@unbrained/pm-cli': `>=${floor}` } }));
    const script = "import { supportedHostSpec } from './test/install-helpers.ts'; process.stdout.write(supportedHostSpec());";
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', timeout: 300000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, `@unbrained/pm-cli@${floor}`);
  }
  for (const file of ['install-helpers.ts', 'install.acceptance.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /supportedHostSpec\(\)/, file);
    assert.doesNotMatch(source, /@unbrained\/pm-cli@\d/, file);
  }
});

for (const kind of ['missing', 'failed', 'empty', 'working'] as const) {
  test(`packed acceptance Bun prerequisite handles ${kind} executable`, t => {
    const bin = mkdtempSync(join(tmpdir(), 'swarm-bun-probe-'));
    t.after(() => rmSync(bin, { recursive: true, force: true }));
    if (kind !== 'missing') {
      const script = kind === 'failed' ? 'process.exit(7)' : kind === 'empty' ? '' : 'process.stdout.write(process.execPath)';
      writeFileSync(join(bin, 'bun'), `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
    }
    const script = `import { requireBun } from ${JSON.stringify(new URL('./install-helpers.ts', import.meta.url).href)}; process.stdout.write(requireBun());`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 300000, env: { ...process.env, PATH: bin }, encoding: 'utf8' });
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
    const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${scenario}`, join(import.meta.dirname, 'install.acceptance.ts')], { timeout: 300000, env, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /packed acceptance requires Bun on PATH/);
    assert.doesNotMatch(result.stdout + result.stderr, /TypeError/);
  });
}
