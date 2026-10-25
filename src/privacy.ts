import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { scanMutationSecrets } from '@unbrained/pm-cli/sdk';

/** Explicit look-alikes complement Unicode compatibility normalization. */
const CONFUSABLES: Record<string, string> = { '\u043e': 'o', '\u041e': 'O', '\u0455': 's', '\u0405': 'S', '\u0435': 'e', '\u0415': 'E', '\u04bb': 'h', '\u0430': 'a', '\u0456': 'i', '\u2215': '/', '\u2044': '/', '\u29f8': '/', '\u2216': '\\' };
/** HTML punctuation that can conceal filesystem roots or token boundaries. */
const ENTITIES: Record<string, string> = { sol: '/', frasl: '/', bsol: '\\', backslash: '\\', setminus: '\\', setmn: '\\', smallsetminus: '\\', ssetmn: '\\', colon: ':', period: '.', dollar: '$', percnt: '%', lbrace: '{', rbrace: '}', quot: '"', apos: "'", lt: '<', gt: '>', amp: '&', nbsp: ' ' };
/** Decode each octet run losslessly: invalid UTF-8 becomes a marker without discarding valid neighbors. */
function decodeOctets(encoded: string): string {
  const bytes = encoded.match(/[a-f0-9]{2}/gi)!.map(hex => Number.parseInt(hex, 16));
  return Buffer.from(bytes).toString('utf8');
}
/** Decode JSON and HTML escapes without evaluating caller text or accepting invalid code points. */
function decodePoint(encoded: string, digits: string, radix: number): string {
  const code = Number.parseInt(digits, radix);
  return code <= 0x10ffff ? String.fromCodePoint(code) : encoded;
}
/** Fold Unicode before decoding too, so confusable URI hex digits cannot destroy valid octet runs. */
function foldUnicode(value: string): string {
  return value.normalize('NFKC')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, '')
    .replace(/[\u043e\u041e\u0455\u0405\u0435\u0415\u04bb\u0430\u0456\u2215\u2044\u29f8\u2216]/gu, character => CONFUSABLES[character]);
}
/** One non-evaluating decoding/folding round, also used to detect the bounded fixed point. */
function canonicalRound(value: string): string {
  return foldUnicode(foldUnicode(value).replace(/(?:%[a-f0-9]{2})+/gi, decodeOctets)
    .replace(/\\u\{([a-f0-9]+)\}|\\u([a-f0-9]{4})|\\x([a-f0-9]{2})/gi, (encoded, brace: string | undefined, unicode: string | undefined, hex: string) => decodePoint(encoded, brace ?? unicode ?? hex, 16))
    .replace(/\\\//g, '/')
    .replace(/&#(?:x([a-f0-9]+)|(\d+));?/gi, (encoded, hex: string | undefined, decimal: string) => decodePoint(encoded, hex ?? decimal, hex === undefined ? 10 : 16))
    .replace(/&([a-z]+);/gi, (encoded, name: string) => ENTITIES[name.toLowerCase()] ?? encoded)
    .replace(/\$\{(\w+)\}/g, '$$$1'));
}
/** Reach a bounded decoding fixed point; excessive nesting is refused rather than partially inspected. */
export function canonicalize(value: string): string | null {
  for (let round = 0; round < 16; round++) {
    const next = canonicalRound(value);
    if (next === value) return normalizePathText(value);
    value = next;
  }
  return canonicalRound(value) === value ? normalizePathText(value) : null;
}
/** Normalize the complete text without tokenizing or exempting any URI component. */
function normalizePathText(value: string): string {
  return value.replaceAll('\\', '/').replace(/(?<=\/)\.(?=\/)/g, '').replace(/\/+/g, '/').toLowerCase();
}
/** Retain both configured and resolved process-home spellings without recording either one. */
function processHomes(): (string | null)[] {
  const configured = [homedir(), process.env.HOME, process.env.USERPROFILE].filter((home): home is string => home !== undefined && home !== '');
  const roots = configured.flatMap(home => {
    try { return [home, realpathSync(home)]; } catch { return [home]; }
  });
  return [...new Set(roots.map(canonicalize))].filter(home => home !== '/' && home !== '');
}
/** Process-local home identity is stable for this module's lifetime. */
const PROCESS_HOMES = processHomes();
/** User-home spellings are private at every substring position, including URI and relative text. */
const HOME_ROOTS = /\/(?:home|users)\/[^/\s"'<>()[\]{} ,;:!?]+|\/(?:root)(?![\p{L}\p{N}_.-])/iu;
/** Named home shortcuts require a separator or an identifier boundary; money and approximations are prose. */
const HOME_SHORTCUTS = new RegExp(`(?:~[\\p{L}\\p{N}_.-]*/|(?:\\$home|\\$env:userprofile|%userprofile%)(?=$|[/\\s"'\x60<>()[\\]{},;:!?]))`, 'iu');
/** Keep the SDK first, then inspect the entire canonical text for private user-home roots. */
export function containsPrivatePath(value: string): boolean {
  if (scanMutationSecrets(value).some(finding => finding.rule === 'absolute_home_path')) return true;
  const decoded = canonicalize(value);
  if (decoded === null) return true;
  const text = decoded;
  return text.trim() === '~' || HOME_ROOTS.test(text) || HOME_SHORTCUTS.test(text)
    || PROCESS_HOMES.some(home => home === null || text.includes(home));
}
