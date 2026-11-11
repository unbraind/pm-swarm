import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCoverageGate } from '../scripts/coverage-gate.ts';

/** Many subprocess dumps must not coexist in the reporter heap before filtering and merging. */
test('coverage aggregates a large raw subprocess corpus inside a 64 MiB reporter heap', t => {
  const root = mkdtempSync(join(tmpdir(), 'swarm-coverage-aggregation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', coverageGate: { sources: ['entry.ts'], tests: ['fixture.test.mjs'], thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 } } }));
  writeFileSync(join(root, 'entry.ts'), 'export const value = 1;\n');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules/vendor.js'), 'export const vendor = 1;\n');
  writeFileSync(join(root, 'fixture.test.mjs'), `
    import assert from 'node:assert/strict';
    import { test } from 'node:test';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { value } from './entry.ts';
    test('the authored source remains fully measured', () => {
      assert.equal(value, 1);
      const functions = Array.from({ length: 5000 }, (_, index) => ({ functionName: 'vendor' + index, ranges: [{ startOffset: 0, endOffset: 1, count: 1 }], isBlockCoverage: true }));
      const dump = JSON.stringify({ result: [{ scriptId: 'synthetic', url: new URL('./node_modules/vendor.js', import.meta.url).href, functions }] });
      for (let index = 0; index < 125; index++) writeFileSync(join(process.env.NODE_V8_COVERAGE, 'coverage-synthetic-' + index + '.json'), dump);
    });
  `);
  const c8 = createRequire(import.meta.url).resolve('c8/bin/c8.js');
  const launcher = join(root, 'reporter.mjs');
  writeFileSync(launcher, `
    import { spawnSync } from 'node:child_process';
    const result = spawnSync(process.execPath, ['--max-old-space-size=64', ${JSON.stringify(c8)}, ...process.argv.slice(2)], { timeout: 300000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
    process.exit(result.status ?? 1);
  `);
  const errors: string[] = [];
  const status = runCoverageGate(root, { runner: { executable: process.execPath, script: launcher }, error: line => errors.push(line) });
  assert.equal(status, 0, errors.join('\n'));
  const summary = JSON.parse(readFileSync(join(root, 'coverage/coverage-summary.json'), 'utf8')) as { total: Record<string, { pct: number }> };
  for (const dimension of ['statements', 'branches', 'functions', 'lines']) assert.equal(summary.total[dimension].pct, 100);
});
