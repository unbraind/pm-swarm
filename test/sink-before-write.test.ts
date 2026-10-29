import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readHistoryEntries, getHistoryPath } from '@unbrained/pm-cli/sdk';
import { commitItemMutation, readItemHistoryHead, SettingsRefusal } from '../src/settings.ts';
import { sharedFixture } from './shared-helpers.ts';
import { unchanged } from './privacy-snapshot.ts';

test('the locked pre-write callback can refuse a real native mutation without a receipt or tracker change', async t => {
  const f = await sharedFixture(t); const id = await f.item(); const item = (await f.client.get(id, { depth: 'full' })).item;
  const history = await readItemHistoryHead(f.pmRoot, id); let checked = 0;
  await unchanged(f.pmRoot, () => commitItemMutation({ id, item, options: { add: 'Public prospective comment' } }, admitted => f.client.comments(admitted.id, admitted.options), { history,
    beforeWrite: async () => {
      assert.equal((await readHistoryEntries(getHistoryPath(f.pmRoot, id), id)).length, history.length); checked++;
      throw new SettingsRefusal('swarm_document_changed', 'Refresh the checked snapshot before retrying.');
    },
  }), 'locked-callback', error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed');
  assert.equal(checked, 1); assert.deepEqual((await f.client.get(id)).item.comments ?? [], []);
});
