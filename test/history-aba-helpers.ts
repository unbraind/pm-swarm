import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { snapshotGitResources } from './git-helpers.ts';
import { sharedFixture } from './shared-helpers.ts';
import type { fixture } from './helpers.ts';
import type { TestContext } from 'node:test';
import { gitEnvironment } from '../src/git-environment.ts';
import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { getHistoryPath, getItemPath } from '@unbrained/pm-cli/sdk';
import type { PmClient } from '@unbrained/pm-cli/sdk';
import { historySnapshot } from '../src/inspection.ts';
import { SettingsRefusal } from '../src/settings.ts';

/** Retain the peer's exact durable item and native history; ignored SDK read caches are not receipts. */
export function peerBytes(pmRoot: string, id: string): string[] { return [getItemPath(pmRoot, 'Task', id), getHistoryPath(pmRoot, id)].map(path => readFileSync(path, 'utf8')); }

/** Seeded operation counts make ABA vary while always restoring precisely the checked native document. */
let seed = 0xaba47129;
/** Advance the seeded generator and select a bounded native operation count. */
function repetitions(): number { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return 1 + (seed >>> 0) % 3; }

/** Compose legal release/claim/restore walks; the last restore always recreates the original document. */
function abaPlan(): ('release' | 'claim' | 'restore')[] {
  const count = repetitions(); const plan: ('release' | 'claim' | 'restore')[] = ['release'];
  for (let index = 0; index < count; index++) {
    const order = repetitions();
    plan.push(...(order === 1 ? ['release', 'claim'] as const : order === 2 ? ['claim', 'release'] as const : ['release', 'claim', 'restore'] as const));
  }
  return [...plan, 'restore'];
}

/** A separate SDK request uses only real release, claim and restore mutations, outside the failed caller's scope. */
export function historyPeer(client: PmClient, pmRoot: string) {
  const request = new AsyncResource('native-history-aba-peer');
  const release = client.release.bind(client); const claim = client.claim.bind(client); const restore = client.restore.bind(client);
  return { destroy: () => request.emitDestroy(), cycle: (id: string) => request.runInAsyncScope(async () => {
    const before = await historySnapshot(pmRoot, id); const original = peerBytes(pmRoot, id)[0]; for (const operation of abaPlan()) {
      if (operation === 'release') await release(id, { force: true });
      else if (operation === 'claim') await claim(id, { force: true });
      else await restore(id, String(before.version), { force: true, message: 'Peer native ABA restoration' });
    }
    assert.equal(peerBytes(pmRoot, id)[0], original, 'peer must recreate byte-identical item content');
    assert.ok((await historySnapshot(pmRoot, id)).historyHead.length > before.historyHead.length);
    return peerBytes(pmRoot, id);
  }) };
}

/** A peer history transition is successful even if its final content and token are identical. */
export function superseded(error: unknown): boolean { return error instanceof SettingsRefusal && error.code === 'swarm_superseded'; }


/** Assert the typed peer-success transport after the stronger durable-state assertions have passed. */
export function assertSuperseded(attempt: PromiseSettledResult<unknown>): void {
  assert.equal(attempt.status, 'rejected'); if (attempt.status === 'rejected') assert.ok(superseded(attempt.reason));
}

/** Run an actual separate SDK writer; the same worker also verifies native-lock exclusion with zero lock wait. */
export function historyPeerProcess(repo: string, pmRoot: string, author: string, id: string) {
  const code = `
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PmClient, readHistoryEntries, getHistoryPath, getItemPath, getItemAt} from '@unbrained/pm-cli/sdk';
const input=JSON.parse(process.argv[1]);
try {
  const client=new PmClient({cwd:input.repo,pmRoot:input.pmRoot,author:input.author,noExtensions:false});
  const history=await readHistoryEntries(getHistoryPath(input.pmRoot,input.id),input.id);
  const before=await getItemAt(input.id,history.at(-1).ts,{pmRoot:input.pmRoot});
  const path=getItemPath(input.pmRoot,'Task',input.id);const original=readFileSync(path,'utf8');
  for(const operation of input.plan){
    if(operation==='release')await client.release(input.id);
    else if(operation==='claim')await client.claim(input.id,{force:true});
    else await client.restore(input.id,String(before.as_of_version),{force:true,message:'Independent peer native ABA restoration'});
  }
  assert.equal(readFileSync(path,'utf8'),original);
  const after=await readHistoryEntries(getHistoryPath(input.pmRoot,input.id),input.id);assert.ok(after.length>history.length);
  console.log(JSON.stringify({byte_identical:true,history_growth:after.length-history.length}));
} catch(error) {console.error(JSON.stringify({code:error.code??'worker_failed',message:error.message}));process.exitCode=2;}
`;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', code, JSON.stringify({ repo, pmRoot, author, id, plan: abaPlan() })], {
    cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 20000,
    env: gitEnvironment({ ...process.env, PM_PATH: pmRoot, PM_SOURCE_WORKSPACE_ROOT: repo, PM_SOURCE_PM_PATH: pmRoot, PM_GLOBAL_PATH: join(pmRoot, 'runtime/peer-global'), PM_LOCK_WAIT_MS: '0' }),
  });
}

/** Share the real Git snapshot operation with the existing generation regressions. */
export const gitResources = snapshotGitResources;

/** Preserve all byte/resource assertions before evaluating the failure category. */
export function assertPeerPreserved(pmRoot: string, id: string, expected: string[], attempt: PromiseSettledResult<unknown>, git?: { repo: string; resources: string[] }): void {
  assert.deepEqual(peerBytes(pmRoot, id), expected);
  if (git !== undefined) assert.deepEqual(gitResources(git.repo), git.resources);
  assertSuperseded(attempt);
}

/** Prepare the same terminal lane used by generation and native-history tests, through real SDK writes. */
export async function prepareTerminalHistoryLane(f: Awaited<ReturnType<typeof fixture>> | Awaited<ReturnType<typeof sharedFixture>>, id: string): Promise<void> {
  if ('swarm' in f) { f.save(); await f.swarm.start(id); } else await f.shared.start(id);
  await f.client.update(id, { status: 'closed', message: 'Terminal cleanup fixture completed' });
  await f.client.claim(id, { author: 'swarm' in f ? f.swarm.author : f.shared.engine.author, force: true });
}

/** Create a genuine native claim and read its entire document for guard precondition tests. */
export async function claimedHistoryFixture(t: TestContext) {
  const f = await sharedFixture(t); const id = await f.item(); await f.client.claim(id);
  return { f, id, item: (await f.client.get(id, { depth: 'full' })).item };
}
