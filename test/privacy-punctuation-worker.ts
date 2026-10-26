import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { canonicalize, containsPrivatePath } from '../src/privacy.ts';
import { validateCommandInputs } from '../src/admission.ts';
import { SettingsRefusal } from '../src/settings.ts';
import { mutationVariants, mutationInputs } from './privacy-mutations.ts';
import { swarmHost, assertPrivacyRendering } from './settings-helpers.ts';
import { seededRandom } from './privacy-fuzz.ts';

const home = process.env.HOME!; const count = Number(process.argv[2]); const random = seededRandom(Number(process.argv[3]));
/** Punctuation belongs to real POSIX segments, including balanced literal route delimiters. */
function noise(): string {
  const punctuation = [';', ',', ':', '=', '#', '?', '&', '|', '!', '%', '+', '@', '_', '-', '[x]', '(x)', '{x}', '<x>', ']', ')', '}', '>', '"', "'", '`'];
  return `pad${punctuation[random() % punctuation.length]}name-${random().toString(36)}`;
}
/** Insert semantic identities without deciding where punctuation might end a path. */
function route(path: string): string {
  return '/' + path.slice(1).split('/').map(segment => `${noise()}/../${segment}${['/.', '//', ''][random() % 3]}`).join('/');
}
/** Compose existing encodings, then wrap the whole run in actual paired presentation delimiters. */
function present(path: string): string {
  let value = path;
  for (let round = 0, rounds = 1 + random() % 4; round < rounds; round++) {
    switch (random() % 7) {
      case 0: value = encodeURIComponent(value); break;
      case 1: value = value.replaceAll('/', '\\u002f'); break;
      case 2: value = value.replaceAll('/', '&#47;'); break;
      case 3: value = value.replaceAll('/', '\uff0f'); break;
      case 4: value = value.toUpperCase(); break;
      case 5: value = value.replace(/\//g, (slash, index: number) => index % 2 ? '\\' : slash); break;
      case 6: value = JSON.stringify(value); break;
    }
  }
  const pairs = [['', ''], ['"', '"'], ["'", "'"], ['`', '`'], ['(', ')'], ['[', ']'], ['<', '>'], ['[source](<', '>)']];
  const [left, right] = pairs[random() % pairs.length];
  return `${random() % 2 ? "Here's " : ''}${left}${value}${right}`;
}

const host = await swarmHost(); const variants = mutationVariants(); let privateCases = 0; let allowedCases = 0;
const canonicalHome = posix.normalize(canonicalize(home)!);
for (let index = 0; index < count; index++) for (const refused of [true, false]) {
  const raw = route(`${home}${refused ? '' : ['2', '-old', '.txt'][random() % 3]}/project-${random().toString(36)}`);
  const normalized = posix.normalize(canonicalize(raw)!);
  assert.equal(normalized === canonicalHome || normalized.startsWith(canonicalHome + '/'), refused, `Independent normalization oracle ${index}`);
  const value = present(raw);
  assert.equal(containsPrivatePath(value), refused, `Punctuation case ${index}, refused ${refused}`);
  for (const variant of variants) {
    const input = mutationInputs(variant);
    const check = () => validateCommandInputs(variant.command, { command: `swarm ${variant.command}`, ...input, global: { author: value }, pm_root: '.' });
    if (refused) assert.throws(check, SettingsRefusal); else assert.doesNotThrow(check);
  }
  await assertPrivacyRendering(host, value, refused);
  if (refused) privateCases++; else allowedCases++;
}
for (const punctuation of [';', ',', ':', '=', '#', '|', '?', '&', '"', "'"]) {
  const value = home.replace('/profiles/', `/pad${punctuation}name/../profiles/`) + '/project';
  assert.equal(containsPrivatePath(value), true);
}
assert.equal(containsPrivatePath('%HOME%/project'), true);
assert.equal(containsPrivatePath(`flag"${home}"`), true);
process.stdout.write(JSON.stringify({ private_cases: privateCases, allowed_cases: allowedCases, variants: variants.length, renderer_cases: 2 * (privateCases + allowedCases), false_refusals: 0, escapes: 0 }));
