import assert from 'node:assert/strict';
import { containsPrivatePath } from '../src/privacy.ts';
import { seededRandom } from './privacy-fuzz.ts';

const home = process.env.HOME!; const count = Number(process.argv[2]); const random = seededRandom(Number(process.argv[3]));
/** Insert valid path identities between components, preserving each directory name. */
function identities(path: string): string {
  return path.split('/').map(segment => `${segment}${['/pad/..', '/.', '//', ''][random() % 4]}`).join('/');
}
/** Compose presentation encodings after semantic identities, using both separator conventions. */
function encode(path: string): string {
  let value = identities(path);
  for (let i = 0, rounds = 1 + random() % 4; i < rounds; i++) {
    switch (random() % 9) {
      case 0: value = encodeURIComponent(value); break;
      case 1: value = value.replace(/\//g, (separator, offset: number) => offset % 2 ? '\\' : separator); break;
      case 2: value = value.replaceAll('/', '&#47;'); break;
      case 3: value = value.replaceAll('/', '\\u002f'); break;
      case 4: value = value.replaceAll('/', '\uff0f'); break;
      case 5: value = `<"${value}">`; break;
      case 6: value = value.toUpperCase(); break;
      case 7: value = `file:///${value}`; break;
      case 8: value = value.startsWith('//') ? `//?/UNC/${value.slice(2)}` : `//?/${value}`; break;
    }
  }
  return value;
}
for (let index = 0; index < count; index++) {
  assert.equal(containsPrivatePath(encode(`${home}/project-${random().toString(36)}`)), true, `private normalization case ${index}`);
  const sibling = [`${home}2/public`, `${home}-old/public`, `${home}.txt/public`, `${home}/../${home.split('/').at(-1)}2/public`][random() % 4];
  assert.equal(containsPrivatePath(encode(sibling)), false, `benign sibling normalization case ${index}`);
}
for (const suffix of [')', ']', '.', ',']) assert.equal(containsPrivatePath(home + suffix), true);
// Explicit above-anchor and trailing-root identities cover the platform clamps too.
const anchor = /^[a-z]:/i.test(home) ? `${home.slice(0, 2)}/../../${home.slice(3)}` : `/${'../'.repeat(4)}${home.replace(/^\/+/, '')}`;
assert.equal(containsPrivatePath(anchor), true);
assert.equal(containsPrivatePath(`file:///${anchor}`), true);
if (home.startsWith('//')) {
  const pieces = home.slice(2).split('/'); const device = `//?/UNC/${pieces[0]}/${pieces[1]}/../../${pieces.slice(2).join('/')}`;
  assert.equal(containsPrivatePath(device), true); assert.equal(containsPrivatePath(`${device}2/public`), false);
}
process.stdout.write(JSON.stringify({ private_cases: count, benign_cases: count, false_refusals: 0 }));
