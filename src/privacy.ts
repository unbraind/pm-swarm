import { scanMutationSecrets } from '@unbrained/pm-cli/sdk';

/** Canonical synthetic home used only to query the SDK oracle after alias expansion. */
const HOME_REFERENCE = ['', 'home', 'redacted', 'project'].join('/');
/** Explicit confusables covered by the package privacy corpus; no locale-dependent folding. */
const CONFUSABLES: Record<string, string> = { '\u043e': 'o', '\u041e': 'O', '\u0455': 's', '\u0405': 'S', '\u0435': 'e', '\u0415': 'E', '\u04bb': 'h', '\u0430': 'a', '\u0456': 'i' };

/** Decode nested URI escapes until stable; every successful round shortens the input. */
function unescapePath(value: string): string {
  for (;;) {
    // Decode valid octets independently so malformed unrelated escapes cannot hide a path.
    const next = value.replace(/(?:%[a-f0-9]{2})+/gi, encoded => {
      try { return decodeURIComponent(encoded); }
      catch { return encoded.replace(/%([a-f0-9]{2})/gi, (_octet, hex: string) => { const code = Number.parseInt(hex, 16); return code < 128 ? String.fromCharCode(code) : ' '; }); }
    });
    if (next === value) return value;
    value = next;
  }
}
/** Fold documented path encodings, retaining relative paths and ordinary web URLs. */
function pathCandidates(value: string): string[] {
  const normalized = unescapePath(value).normalize('NFKC')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, '')
    .replace(/[\u043e\u041e\u0455\u0405\u0435\u0415\u04bb\u0430\u0456]/gu, character => CONFUSABLES[character])
    .replace(/[\u2215\u2044\u29f8\\]/gu, '/')
    .replace(/\$(?:\{(?:HOME|USERPROFILE)\}|HOME\b|USERPROFILE\b|env:USERPROFILE\b)|%(?:USERPROFILE|HOMEPATH)%/gi, HOME_REFERENCE);
  return normalized.replace(/file:\/\/[^/\s]*/gi, '').split(/[^\p{L}\p{N}_./~%$-]+/u).map(token => token
    .replace(/\/{2,}/gu, '/')
    .replace(/^\/(?:Users|root)(?=\/|$)/u, HOME_REFERENCE)
    .replace(/^~[^/]*(?:\/|$)/u, `${HOME_REFERENCE}/`));
}
/** Use the pinned SDK detector for raw text and each normalized path candidate. */
export function containsPrivatePath(value: string): boolean {
  const candidates = [value, ...pathCandidates(value)];
  return candidates.some(candidate => scanMutationSecrets(candidate).some(finding => finding.rule === 'absolute_home_path'));
}
