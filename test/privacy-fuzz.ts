/** Deterministic xorshift32 generator: seeds are part of the public regression evidence. */
function random(seed: number): () => number {
  let state = seed;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
}
/** Apply one encoding or presentation transformation without evaluating generated text. */
const transforms = [
  (value: string) => encodeURIComponent(value),
  (value: string) => value.replace(/[\\/]/g, separator => `${separator}.${separator}`),
  (value: string) => value.replace(/[\\/]/g, separator => separator.repeat(3)),
  (value: string) => value.replaceAll('/', '\\'),
  (value: string) => ['', '', 'authority', value].join('/'),
  (value: string) => `file://${value}`,
  (value: string) => `<"**${value}**">`,
  (value: string) => value.replace(/[A-Za-z/]/g, character => String.fromCharCode(character.charCodeAt(0) + 0xfee0)),
  (value: string) => value.split('').join('\u200b\u202e'),
  (value: string) => value.toUpperCase(),
  (value: string) => `${value}),`,
  (value: string) => value.replaceAll('/', '&#x2f;').replaceAll('\\', '&bsol;'),
  (value: string) => value.replaceAll('/', '\\u002f'),
];
/** Generate private home paths with one through four composable transformations. */
export function homeFuzz(seed: number, count: number): string[] {
  const next = random(seed);
  return Array.from({ length: count }, (_, index) => {
    const base = [['', 'home', 'private', `case-${index}`].join('/'), ['D:', 'Users', 'private', `case-${index}`].join('\\'), ['', '', 'server', 'Users', 'private', `case-${index}`].join('/'), `~/case-${index}`, `$HOME/case-${index}`, `%USERPROFILE%/case-${index}`][next() % 6];
    let value = base;
    const rounds = 1 + next() % 4;
    for (let round = 0; round < rounds; round++) value = transforms[next() % transforms.length](value);
    return value;
  });
}
/** Generate relative paths and web URLs independently, including escape and dot-segment variants. */
export function allowedFuzz(seed: number, count: number): string[] {
  const next = random(seed);
  return Array.from({ length: count }, (_, index) => {
    const segment = `case-${next().toString(36)}-${index}`;
    const paths = [`src/${segment}/../work.ts`, `./${segment}//work.ts`, `../${segment}/work.ts`, `src\\${segment}\\work.ts`, encodeURIComponent(`docs/${segment}/work.md`)];
    if (index % 2 === 0) return paths[next() % paths.length];
    return `${next() % 2 ? 'https' : 'http'}://example.test/${segment}/../docs?q=${encodeURIComponent(segment)}&page=${next() % 100}`;
  });
}
