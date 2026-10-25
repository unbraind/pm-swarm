import { posix, win32 } from 'node:path';
import { scanMutationSecrets } from '@unbrained/pm-cli/sdk';

/** Explicit look-alikes complement Unicode compatibility normalization. */
const CONFUSABLES: Record<string, string> = { '\u043e': 'o', '\u041e': 'O', '\u0455': 's', '\u0405': 'S', '\u0435': 'e', '\u0415': 'E', '\u04bb': 'h', '\u0430': 'a', '\u0456': 'i', '\u2215': '/', '\u2044': '/', '\u29f8': '/', '\u2216': '\\' };
/** HTML punctuation that can conceal filesystem roots or token boundaries. */
const ENTITIES: Record<string, string> = { sol: '/', frasl: '/', bsol: '\\', backslash: '\\', setminus: '\\', setmn: '\\', smallsetminus: '\\', ssetmn: '\\', colon: ':', period: '.', dollar: '$', percnt: '%', lbrace: '{', rbrace: '}', quot: '"', apos: "'", lt: '<', gt: '>', amp: '&', nbsp: ' ' };

/** Decode valid URI octets even when adjacent bytes contain malformed UTF-8. */
function decodeOctets(encoded: string): string {
  try { return decodeURIComponent(encoded); }
  catch { return encoded.replace(/%([a-f0-9]{2})/gi, (_octet, hex: string) => { const code = Number.parseInt(hex, 16); return code < 128 ? String.fromCharCode(code) : ' '; }); }
}
/** Decode JSON and HTML escapes without evaluating caller text or accepting invalid code points. */
function decodePoint(encoded: string, digits: string, radix: number): string {
  const code = Number.parseInt(digits, radix);
  return code <= 0x10ffff ? String.fromCodePoint(code) : encoded;
}
/** One non-evaluating decoding/folding round, also used to detect the bounded fixed point. */
function canonicalRound(value: string): string {
  return value.replace(/(?:%[a-f0-9]{2})+/gi, decodeOctets)
    .replace(/\\u\{([a-f0-9]+)\}|\\u([a-f0-9]{4})|\\x([a-f0-9]{2})/gi, (encoded, brace: string | undefined, unicode: string | undefined, hex: string) => decodePoint(encoded, brace ?? unicode ?? hex, 16))
    .replace(/\\\//g, '/')
    .replace(/&#(?:x([a-f0-9]+)|(\d+));?/gi, (encoded, hex: string | undefined, decimal: string) => decodePoint(encoded, hex ?? decimal, hex === undefined ? 10 : 16))
    .replace(/&([a-z]+);/gi, (encoded, name: string) => ENTITIES[name.toLowerCase()] ?? encoded)
    .replace(/\$\{(\w+)\}/g, '$$$1')
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, '')
    .replace(/[\u043e\u041e\u0455\u0405\u0435\u0415\u04bb\u0430\u0456\u2215\u2044\u29f8\u2216]/gu, character => CONFUSABLES[character]);
}
/** Reach a bounded decoding fixed point; excessive nesting is refused rather than partially inspected. */
function canonicalize(value: string): string | null {
  for (let round = 0; round < 16; round++) {
    const next = canonicalRound(value);
    if (next === value) return value;
    value = next;
  }
  return canonicalRound(value) === value ? value : null;
}
/** Recognize local roots independent of home-directory spellings, on both supported path grammars. */
function absoluteToken(token: string): boolean {
  let path = token;
  for (;;) {
    if (/^https?:\/\//i.test(path)) return false;
    const next = path.replace(/^[\w-]{2,}:/u, '');
    if (next === path) break;
    path = next;
  }
  if (/^(?:~|\$(?:[\w]+|\{[\w]+\}|env:[\w]+)|%[\w]+%)/iu.test(path)) return true;
  const unix = posix.normalize(path.replaceAll('\\', '/'));
  const windows = win32.normalize(path);
  return posix.isAbsolute(unix) || win32.isAbsolute(windows) || /^[a-z]:/i.test(windows);
}
/** Keep the SDK as the first layer, then refuse every canonical absolute local path, including non-home roots. */
export function containsPrivatePath(value: string): boolean {
  if (scanMutationSecrets(value).some(finding => finding.rule === 'absolute_home_path')) return true;
  const canonical = canonicalize(value);
  if (canonical === null) return true;
  return canonical.split(/[^\p{L}\p{N}_./\\~%$:+-]+/u).some(absoluteToken);
}
