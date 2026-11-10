import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from '@babel/parser';

/** Minimal syntax shape for child-process calls, including generated packed-consumer programs. */
interface SyntaxNode {
  type: string; name?: string; value?: unknown; callee?: SyntaxNode; arguments?: SyntaxNode[];
  properties?: SyntaxNode[]; key?: SyntaxNode; property?: SyntaxNode; object?: SyntaxNode; computed?: boolean;
  expressions?: SyntaxNode[]; quasis?: { value: { cooked: string } }[];
}

/** Child-process APIs share the deadline contract across direct, namespace and computed calls. */
const CHILD_APIS = ['spawn', 'spawnSync', 'fork', 'execFile', 'execFileSync', 'exec', 'execSync'];

/** Fixed child API syntax is compiled once; input text never supplies regex syntax. */
const CHILD_CALL = /\b(?:spawn|spawnSync|fork|execFile|execFileSync|exec|execSync)\s*(?:['"]\])?\s*(?:\?\.)?\s*\(/;

/** Resolve direct and member call names, including optional and string-computed members. */
function callName(node: SyntaxNode | undefined): string | undefined {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression') {
    if (node.object?.type === 'RegExpLiteral') return undefined;
    return node.computed ? typeof node.property?.value === 'string' ? node.property.value : undefined : node.property?.name;
  }
  return undefined;
}

/** Reconstruct known literal interpolation without executing the generated program or its expressions. */
function interpolation(node: SyntaxNode, prefix: string): string {
  if (node.type === 'StringLiteral' || node.type === 'NumericLiteral' || node.type === 'BooleanLiteral') return String(node.value);
  if (node.type === 'CallExpression' && node.callee?.object?.name === 'JSON' && callName(node.callee) === 'stringify') {
    const value = node.arguments?.[0];
    return JSON.stringify(value?.type === 'StringLiteral' ? value.value : 'embedded-value');
  }
  // An unquoted import/export specifier requires a string token; ordinary arguments require an expression.
  return /\b(?:from|import)\s*$/.test(prefix) ? '"embedded-module"' : 'undefined';
}

/** Find unbounded calls in executable sources and embedded driver programs without trusting outer timeouts. */
function unboundedChildren(source: string, label: string): string[] {
  const failures: string[] = [];
  /** Visit actual syntax and recursively parse embedded executable programs. */
  const visit = (raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null) return;
    if (Array.isArray(raw)) { for (const entry of raw) visit(entry); return; }
    const node = raw as SyntaxNode;
    const name = callName(node.callee);
    if (['CallExpression', 'OptionalCallExpression'].includes(node.type) && CHILD_APIS.includes(name ?? '')) {
      const options = node.arguments?.find(argument => argument.type === 'ObjectExpression');
      const timeout = options?.properties?.find(property => property.key?.name === 'timeout' || property.key?.value === 'timeout');
      const value = timeout?.value;
      const positive = typeof value === 'object' && value !== null && (value as SyntaxNode).type === 'NumericLiteral' && Number((value as SyntaxNode).value) > 0;
      const parameter = timeout?.type === 'ObjectProperty' && typeof value === 'object' && value !== null && (value as SyntaxNode).type === 'Identifier' && (value as SyntaxNode).name === 'timeout';
      if (!positive && !parameter) failures.push(`${label}:${name}: missing positive per-child timeout`);
    }
    let embedded = node.type === 'StringLiteral' ? String(node.value) : undefined;
    if (node.type === 'TemplateLiteral') {
      embedded = node.quasis![0].value.cooked;
      for (const [index, expression] of node.expressions!.entries()) embedded += interpolation(expression, embedded) + node.quasis![index + 1].value.cooked;
    }
    if (embedded !== undefined && CHILD_CALL.test(embedded)) {
      failures.push(...unboundedChildren(embedded, `${label}:embedded`));
    }
    for (const [key, value] of Object.entries(raw)) if (!['loc', 'extra', 'comments', 'tokens'].includes(key)) visit(value);
  };
  visit(parse(source, { sourceType: 'module', plugins: ['typescript'], allowReturnOutsideFunction: true }));
  return failures;
}

test('every package child process, including packed driver children, has its own deadline', () => {
  const failures: string[] = [];
  for (const directory of ['src', 'scripts', 'test']) {
    for (const file of readdirSync(new URL(`../${directory}/`, import.meta.url)).filter(file => file.endsWith('.ts'))) {
      failures.push(...unboundedChildren(readFileSync(new URL(`../${directory}/${file}`, import.meta.url), 'utf8'), `${directory}/${file}`));
    }
  }
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
  for (const [name, command] of Object.entries(manifest.scripts)) {
    const program = / -e ("(?:[^"\\]|\\.)*")$/.exec(command)?.[1];
    if (program !== undefined) failures.push(...unboundedChildren(JSON.parse(program) as string, `package.json:${name}`));
  }
  assert.deepEqual(failures, []);
  const scale = readFileSync(new URL('./scale.acceptance.ts', import.meta.url), 'utf8');
  const budgets = [...scale.matchAll(/\btimeout:\s*(\d+)/g)].map(match => Number(match[1]));
  assert.equal(budgets.length, 2, 'review every declared scale timeout when the fixture changes');
  assert.ok(budgets[1] >= budgets[0], 'detached scale workers must retain the declared parent barrier lifetime');
});

test('child deadline inventory rejects any missing, zero or negative deadline even inside a generated program', () => {
  for (const name of CHILD_APIS) {
    const args = ['exec', 'execSync'].includes(name) ? "'program'" : "'program', []";
    for (const options of ['', ', {}', ', { timeout: 0 }', ', { timeout: -1 }']) {
      const source = `${name}(${args}${options});`;
      assert.equal(unboundedChildren(source, 'adversarial').length, 1, source);
      assert.equal(unboundedChildren(`const program = ${JSON.stringify(source)};`, 'embedded').length, 1, source);
    }
    assert.deepEqual(unboundedChildren(`${name}(${args}, { timeout: 120000 });`, 'control'), []);
  }
});

test('active recovery guides distinguish fresh execution, compensation and durable committed replay', () => {
  const architecture = readFileSync(new URL('../ARCHITECTURE.md', import.meta.url), 'utf8');
  const applying = architecture.split('\n').find(line => line.startsWith('| `applying` intent |'))!;
  assert.match(applying, /[Ff]resh.*native close/);
  assert.match(applying, /retry.*compensat/);
  for (const file of ['journal-and-acquisition-verification.md', 'receipt-and-generation-verification.md', 'native-close.md']) {
    const source = readFileSync(new URL(`../docs/${file}`, import.meta.url), 'utf8');
    if (file === 'native-close.md') {
      const admission = source.split('\n\n')[1];
      assert.match(admission, /exact original request to reconcile a\s+valid pending intent/);
      assert.match(admission, /malformed intent requires explicit inspection/);
      assert.match(admission, /retrying the original request\s+cannot reconcile it/);
    }
    assert.match(source, /swarm_close_compensated/, file);
    assert.match(source, /swarm_partial_commit/, file);
    assert.match(source, /committed.*receipt|receipt.*committed/s, file);
    assert.doesNotMatch(source, /fresh-close\/read-only-refusal|interrupted closes? (?:always )?refuse|closes? never restore/i, file);
  }
});

test('embedded interpolation placeholders parse expressions and still detect missing deadlines', () => {
  const interpolation = '${argument}';
  for (const timeout of [', { timeout: 1 }', '']) {
    const source = 'const program = `' + ['sp', 'awn'].join('') + '(' + interpolation + ', []' + timeout + ');`;';
    assert.equal(unboundedChildren(source, 'interpolated').length, timeout === '' ? 1 : 0);
  }
});


test('deadline inventory covers every API, member spelling and optional-arguments overload', () => {
  assert.deepEqual(unboundedChildren('/pattern/.exec(value);', 'regular-expression'), []);
  const apis = ['spawn', 'fork', ['spawn', 'Sync'].join(''), ['exec', 'File'].join(''), ['execFile', 'Sync'].join(''), ['ex', 'ec'].join(''), ['exec', 'Sync'].join('')];
  for (const name of apis) for (const callee of [name, `cp.${name}`, `cp['${name}']`, `cp?.${name}`, `cp.${name}?.`]) {
    for (const args of ["'program'", "'program', []"].slice(0, ['exec', 'execSync'].includes(name) ? 1 : 2)) {
      for (const options of ['', ', {}', ', { timeout: 0 }', ', { timeout: -1 }']) {
        const source = `${callee}(${args}${options});`;
        for (const program of [source, `const program = ${JSON.stringify(source)};`]) assert.equal(unboundedChildren(program, 'all-calls').length, 1, program);
      }
      assert.deepEqual(unboundedChildren(`${callee}(${args}, { 'timeout': 1 });`, 'bounded'), []);
    }
  }
});

test('embedded import and export interpolation preserves syntax and deadline detection', () => {
  for (const declaration of ['import { spawnSync } from ', 'export { spawnSync } from ', 'import ']) {
    for (const specifier of ["JSON.stringify('node:child_process')", 'JSON.stringify(moduleName)', 'moduleSpecifier']) {
      for (const timeout of ['', ', { timeout: 1 }']) {
        const source = 'const program = `' + declaration + '${' + specifier + '}; cp.' + ['spawn', 'Sync'].join('') + '("program", []' + timeout + ');`;';
        assert.equal(unboundedChildren(source, 'module-interpolation').length, timeout === '' ? 1 : 0, source);
      }
    }
  }
});


test('deadline visitor uses fixed regex literals rather than rebuilding patterns from variables', () => {
  const source = readFileSync(new URL('./review-close-contracts.test.ts', import.meta.url), 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const failures: string[] = [];
  /** Reject regex construction anywhere in the deadline inventory, including its recursive visitor. */
  const visit = (raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null) return;
    if (Array.isArray(raw)) { raw.forEach(visit); return; }
    const node = raw as SyntaxNode;
    if (['NewExpression', 'CallExpression'].includes(node.type) && node.callee?.name === 'RegExp') failures.push('runtime regex construction');
    Object.values(raw).forEach(visit);
  };
  visit(ast);
  assert.deepEqual(failures, []);
  for (const api of CHILD_APIS) for (const member of [api, `cp.${api}`, `cp['${api}']`, `cp?.${api}`, `cp.${api}?.`]) {
    assert.equal(CHILD_CALL.test(`${member}('program');`), true, member);
    assert.equal(CHILD_CALL.test(`${member}('program');`), true, 'repeated matching must be stateless');
  }
});
