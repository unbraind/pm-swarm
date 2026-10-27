import type { PmClient } from '@unbrained/pm-cli/sdk';

/** Lose only a real SDK return, optionally admitting an independent peer after the native commit. */
export function loseReturn(client: PmClient, method: 'claim' | 'update' | 'close' | 'restore', returnNumber = 1, beforeLoss?: () => Promise<void>) {
  const original = client[method].bind(client); let injected = false; let returns = 0;
  Reflect.set(client, method, new Proxy(original, { async apply(target, receiver, args: unknown[]) {
    const result: unknown = await Reflect.apply(target, receiver, args);
    if (++returns === returnNumber) { injected = true; await beforeLoss?.(); throw new Error('Lost native SDK return'); } return result;
  } }));
  return { restore: () => { Reflect.set(client, method, original); }, injected: () => injected };
}
