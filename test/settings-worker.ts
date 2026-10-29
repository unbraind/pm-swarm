import { hostSdk } from './settings-helpers.ts';
import { updateSettings } from '../src/settings.ts';

const [pmRoot, boundary, operationId] = process.argv.slice(2);
const sdk = await hostSdk(pmRoot);
await updateSettings(sdk, pmRoot, { lane_limit: 2 }, { apply: true, operationId,
  /** Suspend at the requested product boundary until the parent kills this process. */
  checkpoint: async step => {
    if (step !== boundary) return;
    process.send!({ boundary });
    await onceResumed();
  },
});
/** Keep the IPC channel active without consuming CPU while awaiting the injected crash. */
async function onceResumed(): Promise<void> { await new Promise<void>(resolve => { process.once('message', resolve); }); }
