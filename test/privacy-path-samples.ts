/** Committed route and filename shapes complement the generated, uncommitted fleet corpus. */
export const relativePathSamples = [
  'src/app/(auth)/page.ts', 'src/app/[id]/page.ts', 'src/app/[...slug]/page.ts',
  'src/app/[[...slug]]/page.ts', 'src/app/@slot/page.ts', 'src/app/(group)/@panel/[id]/page.ts',
  '(group)/page.ts', '[id]/page.ts', '@slot/page.ts', 'docs/a(b)[c]{d}@e/file.md',
  'docs/guide;notes.md', 'docs/label:notes.md', 'src/日本語/файл.ts',
];
/** Preserve each whole path when it appears bare, in prose, or within Markdown wrappers. */
export function pathPresentations(path: string): string[] {
  return [path, `See ${path} for implementation.`, `See \`${path}\` for implementation.`, `**${path}**`, `[source](${path})`, `[outer]([inner](${path}))`, `![image](<${path}>)`, `[${path}]`, `("${path}")`];
}
