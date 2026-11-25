import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import extension, { withItemMutationObserver } from '../../index.ts';
import { testTime } from './time.ts';

/** Wait for an explicit fixture milestone with a bounded deadline. */
export async function waitForCapacityRace(ready: () => boolean, message: string) {
  const deadline = Date.now() + testTime(30_000);
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(20);
  }
}

/** Install a real CLI command with its existing mutation observer enabled for the first worker. */
export default {
  ...extension,
  activate(api: Parameters<NonNullable<typeof extension.activate>>[0]) {
    return extension.activate!({
      ...api,
      registerCommand(definition, override?) {
        if (typeof definition === 'string') return Reflect.apply(api.registerCommand, api, [definition, override]);
        const { name, run } = definition;
        if (name !== 'swarm next' || run === undefined) return api.registerCommand(definition);
        api.registerCommand({
          ...definition,
          run: ctx => {
            if (ctx.options.agent !== 'worker-a') return run(ctx);
            return withItemMutationObserver(async boundary => {
              if (boundary !== 'before_commit') return;
              writeFileSync(join(ctx.pm_root, 'admission-paused'), '');
              await waitForCapacityRace(() => existsSync(join(ctx.pm_root, 'admission-release')), 'First claim was not released');
            }, () => run(ctx));
          },
        });
      },
    });
  },
};
