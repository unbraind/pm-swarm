import { PmClient } from '@unbrained/pm-cli/sdk';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';
import { CompensationPartialRefusal } from '../src/close-compensation.ts';

/** A real process pauses after the SDK durably starts compensation, before any member restore. */
interface Input { repo: string; pmRoot: string; id: string; token: string }
const input = JSON.parse(process.argv[2]) as Input;
const client = new PmClient({ cwd: input.repo, pmRoot: input.pmRoot, author: 'shared-test' });
const shared = new SharedTracker(new Swarm(input.repo, input.pmRoot, client, 'shared-test'));
try {
  await shared.close(input.id, 'Public completion', input.token, { async onTransition(context) {
    if (context.transition === 'committing') throw new Error('Begin native compensation');
    if (context.transition === 'step_compensating' && context.stepId === 'close') {
      process.send?.({ event: 'ready' });
      await new Promise<void>(resolve => { process.once('message', () => resolve()); });
    }
  } });
  throw new Error('Expected the explicit multi-item compensation refusal');
} catch (error) {
  if (!(error instanceof CompensationPartialRefusal)) throw error;
  process.send?.({ event: 'refused', code: error.code, restored: error.restored, pending: error.pending, transaction_id: error.transaction_id });
  process.disconnect?.();
}
