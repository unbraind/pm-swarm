import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from '@babel/parser';

/** Minimal syntax shape for child-process calls, including generated packed-consumer programs. */
interface SyntaxNode {
  type: string; name?: string; value?: unknown; callee?: SyntaxNode; arguments?: SyntaxNode[];
  properties?: SyntaxNode[]; key?: SyntaxNode; quasis?: { value: { cooked: string } }[];
}

/** Find unbounded calls in executable sources and embedded driver programs without trusting outer timeouts. */
function unboundedChildren(source: string, label: string): string[] {
  const failures: string[] = [];
  const names = ['spawn', 'spawnSync', 'fork', 'execFileSync', 'execSync'];
  /** Visit actual syntax and recursively parse embedded executable programs. */
  const visit = (raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null) return;
    if (Array.isArray(raw)) { for (const entry of raw) visit(entry); return; }
    const node = raw as SyntaxNode;
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && names.includes(node.callee.name ?? '')) {
      const options = node.arguments?.[node.callee.name === 'execSync' ? 1 : 2];
      const timeout = options?.properties?.find(property => property.key?.name === 'timeout');
      const value = timeout?.value;
      const positive = typeof value === 'object' && value !== null && (value as SyntaxNode).type === 'NumericLiteral' && Number((value as SyntaxNode).value) > 0;
      const parameter = timeout?.type === 'ObjectProperty' && typeof value === 'object' && value !== null && (value as SyntaxNode).type === 'Identifier' && (value as SyntaxNode).name === 'timeout';
      if (!positive && !parameter) failures.push(`${label}:${node.callee.name}: missing positive per-child timeout`);
    }
    const embedded = node.type === 'StringLiteral' ? String(node.value) : node.type === 'TemplateLiteral' ? node.quasis!.map(part => part.value.cooked).join('undefined') : undefined;
    if (embedded !== undefined && /\b(?:spawn|spawnSync|fork|execFileSync|execSync)\s*\(/.test(embedded)) {
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
});

test('child deadline inventory rejects any missing, zero or negative deadline even inside a generated program', () => {
  for (const name of ['spawn', 'fork', ['spawn', 'Sync'].join(''), ['execFile', 'Sync'].join(''), ['exec', 'Sync'].join('')]) {
    const args = name === 'execSync' ? "'program'" : "'program', []";
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
    assert.match(source, /swarm_close_compensated/, file);
    assert.match(source, /swarm_partial_commit/, file);
    assert.match(source, /committed.*receipt|receipt.*committed/s, file);
    assert.doesNotMatch(source, /fresh-close\/read-only-refusal|interrupted closes? (?:always )?refuse|closes? never restore/i, file);
  }
});
