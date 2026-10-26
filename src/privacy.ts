import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
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
    .replace(/\\"/g, '"')
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
  return value.replaceAll('\\', '/').toLowerCase();
}
/** Normalize an absolute candidate with both platform grammars; directory roots never climb above their anchor. */
function pathForms(path: string): string[] {
  const devicePath = path.replace(/^\/{2,}[?.]\/unc\//i, '//').replace(/^\/{2,}[?.]\//, '');
  const spellings = devicePath === path ? [path] : [path, devicePath];
  const candidates = spellings.flatMap(spelling => [spelling, ...[...spelling.matchAll(/[a-z]:\//gi)].filter(match => match.index > 0).map(match => spelling.slice(match.index))]);
  return [...new Set(candidates.flatMap(candidate => {
    const drive = /^[a-z]:\//i.test(candidate) ? candidate.slice(0, 2) : '';
    return [drive + posix.normalize(candidate.slice(drive.length)), win32.normalize(candidate)].map(value => {
      const portable = value.replaceAll('\\', '/').toLowerCase();
      return portable === '/' || /^[a-z]:\/$/.test(portable) ? portable : portable.replace(/\/$/, '');
    });
  }))];
}
/** Canonicalize full configured roots before applying the same two path grammars as candidates. */
function processHomes(): (string | null)[] {
  const configured = [homedir(), process.env.HOME, process.env.USERPROFILE].filter((home): home is string => home !== undefined && home !== '');
  const roots = configured.flatMap(home => {
    try { return [home, realpathSync(home)]; } catch { return [home]; }
  });
  return [...new Set(roots.flatMap(home => {
    const decoded = canonicalize(home);
    return decoded === null ? [null] : pathForms(decoded);
  }))].filter(home => home !== '/' && home !== '' && !/^[a-z]:\/$/.test(home ?? ''));
}
/** Require a directory boundary, so a home named demo does not conceal its public sibling demo2. */
function containsHome(path: string, home: string): boolean {
  for (let index = path.indexOf(home); index !== -1; index = path.indexOf(home, index + 1)) {
    const tail = path.slice(index + home.length);
    if (tail === '' || tail.startsWith('/') || /^[)\]}>.,;:!?_*]+$/.test(tail)) return true;
  }
  return false;
}
/** Paired presentation delimiters; punctuation within a POSIX segment is always path data. */
const DELIMITERS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };
/** End a maximal run only at whitespace/NUL or a delimiter already surrounding its beginning. */
function candidateEnd(text: string, start: number, quote: string | undefined, surrounding: readonly string[]): number {
  const inner: string[] = [];
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (/[\s\0]/u.test(character) || character === quote || (quote === undefined && inner.length === 0 && surrounding.includes(character))) return index;
    if (DELIMITERS[character] !== undefined) inner.push(DELIMITERS[character]);
    else if (character === inner.at(-1)) inner.pop();
  }
  return text.length;
}
/** Begin at every separator, retaining punctuation until both native grammars have normalized the whole run. */
function* pathCandidates(text: string): Generator<string> {
  const surrounding: string[] = []; let quote: string | undefined;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '/') {
      const start = index >= 2 && /[a-z]:/i.test(text.slice(index - 2, index)) ? index - 2 : index;
      const whitespace = text.slice(index).search(/[\s\0]/u);
      const complete = whitespace === -1 ? text.length : index + whitespace;
      const closers = [...surrounding, ...(quote === undefined ? [] : [quote])];
      let edge = complete;
      while (closers.length > 0) {
        const closing = closers.indexOf(text[edge - 1]);
        if (closing === -1) break;
        closers.splice(closing, 1); edge--;
      }
      // Retain the literal run even when a presentation parser could mistake a segment character for a closer.
      for (const end of new Set([complete, edge, candidateEnd(text, index, quote, surrounding)])) yield text.slice(start, end);
    }
    if (['"', "'", '`'].includes(character)) {
      if (quote === character) quote = undefined;
      else if (quote === undefined && (index === 0 || text[index + 1] === '/' || /^[a-z]:\//i.test(text.slice(index + 1)) || !/[\p{L}\p{N}_]/u.test(text[index - 1]))) quote = character;
    }
    else if (quote === undefined) {
      if (DELIMITERS[character] !== undefined) surrounding.push(DELIMITERS[character]);
      else if (character === surrounding.at(-1)) surrounding.pop();
    }
  }
}
/** Process-local home identity is stable for this module's lifetime. */
const PROCESS_HOMES = processHomes();
/** User-home spellings are private at every substring position, including URI and relative text. */
const HOME_ROOTS = /\/(?:home|users)\/[^/\s\0]+|\/(?:root)(?![\p{L}\p{N}_.-])/iu;
/** Named home shortcuts require a separator or an identifier boundary; money and approximations are prose. */
const HOME_SHORTCUTS = new RegExp(`(?:~[\\p{L}\\p{N}_.-]*/|(?:\\$home|\\$env:userprofile|%(?:home|userprofile)%)(?=$|[/\\s"'\x60<>()[\\]{},;:!?]))`, 'iu');
/** Keep the SDK first, then inspect the entire canonical text for private user-home roots. */
export function containsPrivatePath(value: string): boolean {
  if (scanMutationSecrets(value).some(finding => finding.rule === 'absolute_home_path')) return true;
  const decoded = canonicalize(value);
  if (decoded === null) return true;
  if (decoded.trim() === '~' || HOME_SHORTCUTS.test(decoded) || PROCESS_HOMES.includes(null)) return true;
  // The uninspectable-root check above narrows every retained root to a string.
  const homes = PROCESS_HOMES as readonly string[];
  /** Decide only on normalized views; laziness avoids materializing unused suffixes after a refusal. */
  const privateCandidate = (candidate: string) => pathForms(candidate).some(path => HOME_ROOTS.test(path) || homes.some(home => containsHome(path, home)));
  for (const candidate of pathCandidates(decoded)) if (privateCandidate(candidate)) return true;
  // A configured root may contain spaces; also inspect intact quoted/path-sized text in that case.
  return homes.some(home => home.includes(' ')) && privateCandidate(decoded);
}
