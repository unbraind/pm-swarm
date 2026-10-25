import { commitMutation } from './settings.ts';
import { readFileSync } from 'node:fs';
import { runLinkedTests, resolveGlobalPmRoot } from '@unbrained/pm-cli/sdk';
import type { LinkedTest } from '@unbrained/pm-cli/sdk';
import { isMainInvocation } from '../scripts/main-invocation.ts';

/** Execute the host's linked-test semantics from the candidate worktree's own process context. */
export async function verifyLinkedTests(tests: LinkedTest[], pmRoot: string): Promise<boolean> {
  const results = await commitMutation({ tests }, admitted => runLinkedTests(admitted.tests, undefined, { pmRoot, sourceRoots: { projectPmRoot: pmRoot, globalPmRoot: resolveGlobalPmRoot(process.cwd()) }, workspaceContext: 'snapshot', overrideLinkedWorkspaceContext: true, failOnEmptyTestRun: true }));
  if (results.some(result => result.status !== 'passed')) commitMutation(results.map(result => ({ status: result.status, error: result.error, stderr: result.stderr })), admitted => process.stderr.write(JSON.stringify(admitted) + '\n'));
  return results.length > 0 && results.every(result => result.status === 'passed');
}

if (isMainInvocation(process.argv, import.meta.url)) {
  const input = JSON.parse(readFileSync(0, 'utf8')) as { tests: LinkedTest[]; pmRoot: string };
  const passed = await verifyLinkedTests(input.tests, input.pmRoot);
  process.stdout.write(JSON.stringify({ passed }));
  process.exitCode = passed ? 0 : 1;
}
