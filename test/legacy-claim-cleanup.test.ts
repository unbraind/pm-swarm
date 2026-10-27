import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitImportedItem, getItemPath, readSettings, resolveItemTypeRegistry } from '@unbrained/pm-cli/sdk';
import { historySnapshot } from '../src/inspection.ts';
import { fixture } from './helpers.ts';
import { sharedFixture } from './shared-helpers.ts';
import { withStartTransitionObserver } from '../src/swarm.ts';
import { branchExists } from '../src/git.ts';
import { failRename } from './rename-faults.ts';

/** Import a new canonical SDK history stream without altering any existing record. */
async function legacy(f: Pick<Awaited<ReturnType<typeof fixture>>, 'pmRoot' | 'item'>, assignee: string): Promise<string> {
  const template = await f.item(); const document = structuredClone((await historySnapshot(f.pmRoot, template)).document);
  const id = `${template}-legacy`; document.metadata.id = id; document.metadata.assignee = assignee; delete document.metadata.claim_principal;
  const settings = await readSettings(f.pmRoot);
  const result = await commitImportedItem({ pmRoot: f.pmRoot, id, itemPath: getItemPath(f.pmRoot, 'Task', id, undefined, resolveItemTypeRegistry(settings).type_to_folder), document, author: 'fixture-importer', message: 'Legacy ownership fixture', settings, conflictWarningPrefix: 'fixture_import_conflict' });
  assert.equal(result.committed, true); return id;
}

for (const mode of ['Git', 'shared'] as const) test(`${mode} cleanup treats imported blank assignees as unclaimed through the native SDK`, async t => {
  const lane = mode === 'Git' ? await fixture(t) : undefined;
  const tracker = mode === 'shared' ? await sharedFixture(t) : undefined;
  const f = lane ?? tracker!;
  for (const assignee of ['', '   ']) {
    const id = await legacy(f, assignee);
    assert.equal((await f.client.get(id)).item.assignee, undefined, 'the SDK canonicalizes imported blank ownership');
    lane?.save();
    const restore = failRename(t, (_source, target) => target.includes('agent-'), 'Legacy acquisition receipt failure');
    try { await assert.rejects(lane !== undefined ? lane.swarm.start(id) : tracker!.shared.start(id), /Legacy acquisition receipt failure/); }
    finally { restore(); }
    assert.equal((await f.client.get(id)).item.assignee, undefined);
  }
});

test('a legacy existing claim keeps its owner while new lane fields and Git resources roll back', async t => {
  const f = await fixture(t); const id = await legacy(f, 'swarm-test'); f.save();
  assert.equal((await historySnapshot(f.pmRoot, id)).document.metadata.claim_principal, undefined);
  await assert.rejects(withStartTransitionObserver(transition => { if (transition === 'published') throw new Error('Legacy lane publication failed'); }, () => f.swarm.start(id)), /Legacy lane publication failed/);
  const item = (await f.client.get(id)).item; assert.equal(item.assignee, 'swarm-test'); assert.equal(item.swarm_branch, undefined);
  assert.equal(branchExists(f.repo, `swarm/${id}`), false);
});
