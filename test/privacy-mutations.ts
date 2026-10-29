import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlanProgress } from '../src/progress.ts';
import { sharedFixture } from './shared-helpers.ts';
import { swarmCommandDefinitions } from '../src/commands.ts';

/** One mutating invocation declared by the production command registry. */
export interface MutationVariant {
  command: string;
  id: boolean;
  flags: readonly string[];
  options: Record<string, unknown>;
}
/** Enumerate registry metadata rather than maintaining a second command/action list. */
export function mutationVariants(): MutationVariant[] {
  return Object.entries(swarmCommandDefinitions).flatMap(([command, definition]) => definition.mutations.map(options => ({ command, id: definition.id, flags: definition.flags, options: { ...options } })));
}
/** Supply valid scalar domains using only flags registered by each invocation. */
export function mutationInputs(variant: MutationVariant, id = 'public-item'): { args: string[]; options: Record<string, unknown> } {
  const required: Record<string, string> = { to: 'receiver', note: 'Public context', token: '1', staleAfter: '120', step: 'public-step', revision: 'a'.repeat(64), evidence: 'Public evidence' };
  const options: Record<string, unknown> = {};
  for (const flag of variant.flags) {
    const key = flag.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    if (required[key] !== undefined) options[key] = required[key];
  }
  return { args: variant.id || variant.command === 'deadlocks' ? [id] : [], options: { ...options, ...variant.options } };
}

/** Create an owned core Plan through the real CLI and read its coherent progress revision. */
export async function ownedPlan(f: Awaited<ReturnType<typeof sharedFixture>>) {
  const plan = f.run('plan', 'create', '--title', 'Privacy plan', '--step', 'Produce');
  const progress = new PlanProgress({ cwd: f.repo, pmRoot: f.pmRoot, author: 'shared-test' }, true);
  const initial = await progress.view(String(plan.id));
  f.run('plan', 'update-step', String(plan.id), initial.steps[0].id, '--step-owner', 'shared-test');
  return { plan, progress, view: await progress.view(String(plan.id)) };
}

/** Declare a real SDK-discovered service extension; native client ownership remains with the host. */
export function declareService(f: Awaited<ReturnType<typeof sharedFixture>>): void {
  const provider = join(f.pmRoot, 'extensions/refusal-storage'); mkdirSync(provider);
  writeFileSync(join(provider, 'manifest.json'), JSON.stringify({ name: 'refusal-storage', version: '1.0.0', entry: 'entry.js', capabilities: ['services'] }));
  writeFileSync(join(provider, 'entry.js'), 'export default { activate() {} };\n');
}
