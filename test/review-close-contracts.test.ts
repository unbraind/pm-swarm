import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from '@babel/parser';

/** Minimal syntax shape for child-process calls, including generated packed-consumer programs. */
interface SyntaxNode {
  type: string; name?: string; value?: unknown; callee?: SyntaxNode; arguments?: SyntaxNode[];
  properties?: SyntaxNode[]; key?: SyntaxNode; property?: SyntaxNode; object?: SyntaxNode; computed?: boolean;
  expressions?: SyntaxNode[]; quasis?: { value: { cooked: string } }[];
  argument?: SyntaxNode; left?: SyntaxNode; elements?: (SyntaxNode | null)[]; param?: SyntaxNode; parameter?: SyntaxNode;
  id?: SyntaxNode; params?: SyntaxNode[]; local?: SyntaxNode; specifiers?: SyntaxNode[]; source?: SyntaxNode;
}

/** Child-process APIs share the deadline contract across direct, namespace and computed calls. */
const CHILD_APIS = ['spawn', 'spawnSync', 'fork', 'execFile', 'execFileSync', 'exec', 'execSync'];

/** Fixed child API syntax is compiled once; input text never supplies regex syntax. */
const CHILD_CALL = /\b(?:spawn|spawnSync|fork|execFile|execFileSync|exec|execSync)\s*(?:['"]\])?\s*(?:\?\.)?\s*\(/;

/** The shared scale helper's module specifier, the only binding accepted for testTime. */
const SHARED_TIME_HELPER = /(^|\/)support\/time(\.ts)?$/;

/** Refuse shadowed deadline bindings anywhere in the program. */
function deadlineBinding(program: SyntaxNode, name: 'testTime' | 'globalThis'): boolean {
  let helper = false;
  let foreign = false;
  const binds = (node: SyntaxNode | null | undefined): boolean => {
    if (!node) return false;
    if (node.type === 'Identifier') return node.name === name;
    if (node.type === 'TSParameterProperty') return binds(node.parameter);
    if (node.type === 'ObjectPattern') return (node.properties ?? []).some(property =>
      property.type === 'RestElement' ? binds(property.argument) : binds(property.value as SyntaxNode));
    if (node.type === 'ArrayPattern') return (node.elements ?? []).some(binds);
    if (node.type === 'AssignmentPattern') return binds(node.left);
    if (node.type === 'RestElement') return binds(node.argument);
    return false;
  };
  const visit = (raw: unknown): void => {
    if (Array.isArray(raw)) { for (const entry of raw) visit(entry); return; }
    if (typeof raw !== 'object' || raw === null) return;
    const node = raw as SyntaxNode;
    if (node.type === 'ImportDeclaration') {
      for (const specifier of node.specifiers ?? []) if (binds(specifier.local)) {
        if (name === 'testTime' && typeof node.source?.value === 'string' && SHARED_TIME_HELPER.test(node.source.value)) helper = true;
        else foreign = true;
      }
    } else if (['VariableDeclarator', 'FunctionDeclaration', 'FunctionExpression', 'ClassDeclaration', 'ClassExpression', 'TSImportEqualsDeclaration', 'TSEnumDeclaration', 'TSModuleDeclaration'].includes(node.type) && binds(node.id)) {
      foreign = true;
    } else if (binds(node.param) || (node.params ?? []).some(binds)) {
      foreign = true;
    }
    for (const [key, value] of Object.entries(raw)) if (!['loc', 'extra', 'comments', 'tokens'].includes(key)) visit(value);
  };
  visit(program);
  return (name === 'globalThis' || helper) && !foreign;
}

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

/** Credit only the native, literal deadline on an asynchronous streaming process. */
function spawnDeadlineSignal(options: SyntaxNode | undefined, program: SyntaxNode): boolean {
  const last = options?.properties?.slice().reverse().find(property => property.type === 'SpreadElement' || property.computed ||
    property.key?.name === 'signal' || property.key?.value === 'signal');
  const signal = last?.type === 'ObjectProperty' && !last.computed ? last.value as SyntaxNode : undefined;
  const callee = signal?.callee;
  const owner = callee?.object;
  const value = signal?.arguments?.[0];
  return signal?.type === 'CallExpression' && callee?.type === 'MemberExpression' && !callee.computed && callee.property?.name === 'timeout' &&
    owner?.type === 'MemberExpression' && !owner.computed && owner.object?.name === 'globalThis' && owner.property?.name === 'AbortSignal' &&
    signal.arguments?.length === 1 && value?.type === 'NumericLiteral' && Number(value.value) > 0 && deadlineBinding(program, 'globalThis');
}

/** Find unbounded calls in executable sources and embedded driver programs without trusting outer timeouts. */
function unboundedChildren(source: string, label: string): string[] {
  const failures: string[] = [];
  const program = parse(source, { sourceType: 'module', plugins: ['typescript'], allowReturnOutsideFunction: true }) as SyntaxNode;
  /** Visit actual syntax and recursively parse embedded executable programs. */
  const visit = (raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null) return;
    if (Array.isArray(raw)) { for (const entry of raw) visit(entry); return; }
    const node = raw as SyntaxNode;
    const name = callName(node.callee);
    if (['CallExpression', 'OptionalCallExpression'].includes(node.type) && CHILD_APIS.includes(name ?? '')) {
      const options = node.arguments?.find(argument => argument.type === 'ObjectExpression');
      const timeout = options?.properties?.find(property => property.key?.name === 'timeout' || property.key?.value === 'timeout');
      const expression = timeout?.value as SyntaxNode | undefined;
      // The shared helper validates its scale during module evaluation and
      // rounds an explicitly positive base deadline before the child launches.
      // Only the helper's own binding counts: a shadowed local or a same-name
      // member on another object is an unvalidated wrapper.
      const value = expression?.type === 'CallExpression' && expression.callee?.type === 'Identifier' && expression.callee.name === 'testTime'
        && expression.arguments?.length === 1 && deadlineBinding(program, 'testTime') ? expression.arguments[0] : expression;
      const positive = typeof value === 'object' && value !== null && (value as SyntaxNode).type === 'NumericLiteral' && Number((value as SyntaxNode).value) > 0;
      const parameter = timeout?.type === 'ObjectProperty' && typeof value === 'object' && value !== null && (value as SyntaxNode).type === 'Identifier' && (value as SyntaxNode).name === 'timeout';
      if (!positive && !parameter && !(name === 'spawn' && spawnDeadlineSignal(options, program))) failures.push(`${label}:${name}: missing positive per-child timeout`);
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
  visit(program);
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

test('child deadline inventory accepts only an explicitly bounded native spawn signal', () => {
  const call = ['sp', 'awn'].join('');
  assert.deepEqual(unboundedChildren(`${call}('git', [], { signal: globalThis.AbortSignal.timeout(1000) });`, 'stream'), []);
  for (const signal of ['AbortSignal.timeout(1000)', 'globalThis.AbortSignal.timeout(0)', 'globalThis.AbortSignal.timeout(duration)', 'controller.signal']) {
    assert.equal(unboundedChildren(`${call}('git', [], { signal: ${signal} });`, 'unbounded stream').length, 1);
  }
});

test('child deadline inventory rejects a native spawn signal overwritten by a later option', () => {
  const call = ['sp', 'awn'].join('');
  for (const override of ['...{ signal: controller.signal }', 'signal: controller.signal', "['signal']: controller.signal"]) {
    const source = `${call}('git', [], { signal: globalThis.AbortSignal.timeout(1000), ${override} });`;
    assert.equal(unboundedChildren(source, 'overwritten signal').length, 1, override);
  }
});

test('child deadline inventory rejects a native spawn signal from a shadowed globalThis', () => {
  const call = ['sp', 'awn'].join('');
  const source = `function run(globalThis) { ${call}('git', [], { signal: globalThis.AbortSignal.timeout(1000) }); }`;
  assert.equal(unboundedChildren(source, 'shadowed global').length, 1);
});

test('child deadline inventory permits scaled positive budgets and refuses invalid scaled arguments', () => {
  const call = ['spawn', 'Sync'].join('');
  const HELPER_IMPORT = "import { testTime } from './support/time.ts';\n";
  for (const budget of ['120000', 'timeout']) {
    const source = `${HELPER_IMPORT}${call}('program', [], { timeout: testTime(${budget}) });`;
    assert.deepEqual(unboundedChildren(source, 'scaled'), []);
  }
  for (const budget of ['', '0', '-1', 'NaN', 'Infinity', 'unknown', '1, 2']) {
    const source = `${HELPER_IMPORT}${call}('program', [], { timeout: testTime(${budget}) });`;
    assert.equal(unboundedChildren(source, 'invalid-scaled').length, 1, budget);
  }
  assert.equal(unboundedChildren(`${call}('program', [], { timeout: unvalidated(120000) });`, 'foreign-helper').length, 1);
});

test('child deadline inventory credits only the shared helper binding for the testTime wrapper', () => {
  const call = ['spawn', 'Sync'].join('');
  const HELPER_IMPORT = "import { testTime } from './support/time.ts';\n";
  // A same-name shadowed local binding replaces the helper and is rejected.
  assert.equal(unboundedChildren(`const testTime = () => 0;\n${call}('program', [], { timeout: testTime(120000) });`, 'shadowed-local').length, 1);
  // A same-name import from any other module is a foreign helper and is rejected.
  assert.equal(unboundedChildren(`import { testTime } from './unrelated/time.ts';\n${call}('program', [], { timeout: testTime(120000) });`, 'foreign-helper').length, 1);
  // An unrelated member call is rejected even when the shared helper is imported.
  assert.equal(unboundedChildren(`${HELPER_IMPORT}${call}('program', [], { timeout: other.testTime(120000) });`, 'member-helper').length, 1);
  // A same-name call with no binding at all is rejected.
  assert.equal(unboundedChildren(`${call}('program', [], { timeout: testTime(120000) });`, 'unbound').length, 1);
  // The shared helper import itself remains the accepted wrapper.
  assert.deepEqual(unboundedChildren(`${HELPER_IMPORT}${call}('program', [], { timeout: testTime(120000) });`, 'shared-helper'), []);
});

test('child deadline inventory refuses every shadowing binding pattern', () => {
  const call = ['spawn', 'Sync'].join('') + "('program', [], { timeout: testTime(120000) });";
  const helper = "import { testTime } from './support/time.ts';\n";
  const wrappers = [
    ['parameter', 'function run(testTime) { BODY }'],
    ['object parameter', 'function run({ testTime }) { BODY }'],
    ['renamed nested object', 'function run({ nested: { value: testTime } }) { BODY }'],
    ['array parameter', 'function run([testTime]) { BODY }'],
    ['nested array with hole', 'function run([, { nested: [testTime] }]) { BODY }'],
    ['default parameter', 'function run(testTime = () => 0) { BODY }'],
    ['nested default', 'function run({ value: [testTime = () => 0] } = {}) { BODY }'],
    ['rest parameter', 'function run(...testTime) { BODY }'],
    ['object rest', 'function run({ ...testTime }) { BODY }'],
    ['array rest', 'function run([...testTime]) { BODY }'],
    ['catch identifier', 'try {} catch (testTime) { BODY }'],
    ['catch pattern', 'try {} catch ({ nested: [testTime] }) { BODY }'],
    ['function declaration', 'function run() { function testTime() {} BODY }'],
    ['class declaration', 'function run() { class testTime {} BODY }'],
    ['variable declaration', 'function run() { const testTime = () => 0; BODY }'],
    ['object declaration', 'function run() { const { nested: [testTime] } = value; BODY }'],
    ['array declaration', 'function run() { let [testTime] = value; BODY }'],
    ['named function expression', 'const run = function testTime() { BODY };'],
    ['named class expression', 'const run = class testTime { method() { BODY } };'],
    ['arrow parameter', 'const run = ({ testTime }) => { BODY };'],
  ];
  for (const [label, wrapper] of wrappers) {
    assert.equal(unboundedChildren(helper + wrapper.replace('BODY', call), label).length, 1, label);
    // A property key named testTime does not bind it when renamed to another local.
    const safe = wrapper.replaceAll('testTime', 'other').replace('BODY', call);
    assert.deepEqual(unboundedChildren(helper + safe, label), [], label);
  }
  assert.deepEqual(unboundedChildren(helper + 'function run({ testTime: other }) { ' + call + ' }', 'property-key'), []);
});

test('active recovery guides distinguish fresh execution, compensation and durable committed replay', () => {
  const architecture = readFileSync(new URL('../ARCHITECTURE.md', import.meta.url), 'utf8');
  const applying = architecture.split('\n').find(line => line.startsWith('| `applying` intent |'))!;
  assert.match(applying, /[Ff]resh.*native close/);
  assert.match(applying, /retry.*compensat/);
  assert.match(architecture, /Malformed intent.*retrying the original request cannot reconcile it/);
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /valid pending intent/);
  assert.match(readme, /malformed intent requires explicit inspection/);
  assert.match(readme, /retrying the original request cannot reconcile it/);
  for (const file of ['journal-and-acquisition-verification.md', 'receipt-and-generation-verification.md', 'native-close.md']) {
    const source = readFileSync(new URL(`../docs/${file}`, import.meta.url), 'utf8');
    assert.match(source, /valid pending\s+intent/);
    assert.match(source, /malformed intent\s+requires explicit inspection/);
    assert.match(source, /retrying the original request\s+cannot reconcile it/);
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
