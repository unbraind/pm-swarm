import { PmClient } from '@unbrained/pm-cli/sdk';
import { SharedTracker } from '../src/shared-tracker.ts';
import { Swarm } from '../src/swarm.ts';

/** Pause only after the actual native close returns, while the caller's receipt is still lost. */
interface Input { repo: string; pmRoot: string; id: string; token: string }
const input = JSON.parse(process.argv[2]) as Input;
const client = new PmClient({ cwd: input.repo, pmRoot: input.pmRoot, author: 'shared-test' });
const close = client.close.bind(client);
client.close = new Proxy(close, { async apply(target, receiver, args: unknown[]) {
  const result: unknown = await Reflect.apply(target, receiver, args); process.send?.('committed');
  await new Promise<void>(resolve => { process.once('message', () => resolve()); });
  return result;
} });
await new SharedTracker(new Swarm(input.repo, input.pmRoot, client, 'shared-test')).close(input.id, 'Public native completion', input.token);
