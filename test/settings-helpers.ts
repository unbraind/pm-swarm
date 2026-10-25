import assert from 'node:assert/strict';
import { createExtensionTestHarness } from '@unbrained/pm-cli/sdk/testing';
import type { ExtensionCommandSdk, ExtensionApi } from '@unbrained/pm-cli/sdk/authoring';

/** Obtain a genuine tracker-bound host service without replacing SDK behavior. */
export async function hostSdk(pmRoot: string): Promise<ExtensionCommandSdk> {
  let sdk: ExtensionCommandSdk | undefined;
  const host = await createExtensionTestHarness({
    /** Capture the actual injected host service using native registration. */
    activate(api: ExtensionApi) { api.registerCommand({ name: 'capture-sdk', run: ctx => { sdk = ctx.sdk; return {}; } }); },
  }, { name: 'settings-verification', capabilities: ['commands'] });
  await host.runCommand({ command: 'capture-sdk', pmRoot, global: { author: 'settings-test' } });
  assert.ok(sdk); return sdk;
}
