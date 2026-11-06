import { PmClient } from '@unbrained/pm-cli/sdk';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { withCloseObserver } from '../src/close-journal.ts';

/** Real worker controls only diagnostic boundaries; every tracker mutation uses the native SDK. */
interface Input { repo: string; pmRoot: string; id: string; token: string; kill?: number | { boundary: string; occurrence?: number }; fail?: string; author?: string; note?: string }
const input = JSON.parse(process.argv[2]) as Input;
const author = input.author ?? 'shared-test';
const client = new PmClient({ cwd: input.repo, pmRoot: input.pmRoot, author });
let index = 0;
const occurrences = new Map<string, number>();
try {
  const result = await withCloseObserver((boundary, id) => {
    process.stdout.write(`${JSON.stringify({ boundary, id, index })}\n`);
    const occurrence = (occurrences.get(boundary) ?? 0) + 1; occurrences.set(boundary, occurrence);
    if (input.kill === index++ || typeof input.kill === 'object' && input.kill.boundary === boundary && occurrence === (input.kill.occurrence ?? 1)) process.kill(process.pid, 'SIGKILL');
    if (input.fail === boundary) throw new Error('Injected close boundary failure');
  }, () => new SharedTracker(new Swarm(input.repo, input.pmRoot, client, author)).close(input.id, input.note ?? 'Public native completion', input.token));
  process.stdout.write(`${JSON.stringify({ result })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ code: Reflect.get(Object(error), 'code'), restored: Reflect.get(Object(error), 'restored'), pending: Reflect.get(Object(error), 'pending'), message: error instanceof Error ? error.message : 'Unknown failure' })}\n`);
  process.exitCode = 2;
}
