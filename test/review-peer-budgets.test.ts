import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from '@babel/parser';

/** Syntax fields needed to inventory direct, member and copied child-process calls. */
interface SyntaxNode {
  type?: string; name?: string; value?: unknown; callee?: SyntaxNode; arguments?: SyntaxNode[];
  object?: SyntaxNode; property?: SyntaxNode; id?: SyntaxNode; init?: SyntaxNode;
  properties?: SyntaxNode[]; key?: SyntaxNode; elements?: SyntaxNode[];
}

/** Visit syntax without executing inspected test programs. */
function walk(raw: unknown, visit: (node: SyntaxNode) => void): void {
  if (typeof raw !== 'object' || raw === null) return;
  if (Array.isArray(raw)) { for (const entry of raw) walk(entry, visit); return; }
  visit(raw as SyntaxNode);
  for (const value of Object.values(raw)) walk(value, visit);
}

/** Extract call and copied member spellings, including computed API access. */
function name(node: SyntaxNode | undefined): string | undefined {
  return node?.name ?? node?.property?.name ?? (typeof node?.property?.value === 'string' ? node.property.value : undefined);
}

/** Real peer processes need at least 30 seconds; explicit idle-child timeout fault injection is separate. */
function shortPeerBudgets(source: string): number[] {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'], allowReturnOutsideFunction: true });
  const aliases = new Set(['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync']);
  walk(ast, node => {
    if (node.type === 'VariableDeclarator' && aliases.has(name(node.init) ?? '') && node.id?.name) aliases.add(node.id.name);
  });
  const failures: number[] = [];
  walk(ast, node => {
    if (!['CallExpression', 'OptionalCallExpression'].includes(node.type ?? '') || !aliases.has(name(node.callee) ?? '')) return;
    const options = node.arguments?.find(argument => argument.type === 'ObjectExpression');
    const timeout = options?.properties?.find(property => name(property.key) === 'timeout' || property.key?.value === 'timeout')?.value as SyntaxNode | undefined;
    if (timeout?.type !== 'NumericLiteral' || typeof timeout.value !== 'number') return;
    // These deliberate idle children test ETIMEDOUT classification rather than SDK startup.
    const idleFault = node.arguments?.some(argument => argument.type === 'ArrayExpression' && argument.elements?.some(element => element.value === 'setInterval(() => {}, 1000)'));
    if (!idleFault && timeout.value < 30000) failures.push(timeout.value);
  });
  return failures;
}

test('every package peer deadline allows SDK startup, including copied subprocess APIs', () => {
  for (const directory of ['src', 'scripts', 'test']) {
    for (const file of readdirSync(new URL(`../${directory}/`, import.meta.url)).filter(file => file.endsWith('.ts'))) {
      assert.deepEqual(shortPeerBudgets(readFileSync(new URL(`../${directory}/${file}`, import.meta.url), 'utf8')), [], `${directory}/${file}`);
    }
  }
});

test('peer budget policy rejects short budgets for every API and alias without sleeping', () => {
  for (const api of ['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    for (const callee of [api, `cp.${api}`, `cp['${api}']`, `cp?.${api}`, `cp.${api}?.`, 'peer']) {
      for (const timeout of [1, 25, 10000, 20000, 29999, 30000, 120000, 300000]) {
        const source = `const peer = cp.${api}; ${callee}('program', [], { timeout: ${timeout} });`;
        assert.deepEqual(shortPeerBudgets(source), timeout < 30000 ? [timeout] : [], source);
      }
    }
  }
  assert.deepEqual(shortPeerBudgets("spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 25 });"), []);
});
