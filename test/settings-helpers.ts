import assert from 'node:assert/strict';
import { createExtensionTestHarness } from '@unbrained/pm-cli/sdk/testing';
import extension from '../index.ts';
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

/** Activate the package's actual registrations for shared privacy boundary checks. */
export function swarmHost() {
  return createExtensionTestHarness(extension, { name: 'pm-swarm', capabilities: ['commands', 'schema', 'renderers'] });
}
/** Assert host ownership and the expected privacy decision in both output formats. */
export async function assertPrivacyRendering(host: Awaited<ReturnType<typeof swarmHost>>, value: string, refused: boolean): Promise<void> {
  for (const format of ['json', 'toon'] as const) {
    const result = await host.runRendererOverride({ command: 'swarm handoff', format, result: { id: 'public-item', note: value } });
    assert.equal(result.overridden, true); assert.deepEqual(result.warnings, []);
    assert.equal(result.rendered!.includes('swarm_private_path'), refused);
    if (refused) assert.equal(result.rendered!.includes(value), false);
  }
}
