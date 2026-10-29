import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sharedFixture } from './shared-helpers.ts';
import { blockedDependent, closeClaim, nativeBytes } from './close-native-helpers.ts';
import { peerBytes } from './history-aba-helpers.ts';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
for (const dependency of ['blocked_by', 'dependencies'] as const) test(`swarm preserves native close and dependent lifecycle bytes for ${dependency}`, async t => {
  const f = await sharedFixture(t);
  const id = await f.item(); const dependent = await f.item(); const claim = await f.shared.start(id);
  await f.client.update(id, { blockedReason: 'Public blocker reason' });
  await f.client.update(dependent, { status: 'blocked', blockedReason: 'Awaiting public work', ...(dependency === 'blocked_by' ? { blockedBy: id } : { dep: [`id=${id},kind=blocked_by`] }) });
  const nativeRoot = join(f.repo, 'native-oracle'); cpSync(f.pmRoot, nativeRoot, { recursive: true });
  const oracle = new PmClient({ cwd: f.repo, pmRoot: nativeRoot, author: 'shared-test' });
  const native = await oracle.close(id, 'Public completion');
  const expected = [nativeBytes(nativeRoot, id), nativeBytes(nativeRoot, dependent)];
  assert.equal((await oracle.get(dependent)).item.status, 'open');
  const result = await f.shared.close(id, 'Public completion', claim.token);
  assert.equal((await f.client.get(dependent)).item.status, 'open');
  assert.deepEqual([nativeBytes(f.pmRoot, id), nativeBytes(f.pmRoot, dependent)], expected);
  assert.deepEqual(result.warnings, native.warnings);
  assert.equal((await f.client.get(id)).item.blocked_reason, undefined);
});

test('native dependent refusal warnings survive SDK CLI JSON and TOON close receipts', async t => {
  const f = await sharedFixture(t);
  for (const format of ['sdk', 'json', 'toon'] as const) {
    const { id, claim } = await closeClaim(f); const dependent = await blockedDependent(f, id);
    // The title survives native unblock and must therefore be refused at the dependent's own sink.
    await f.client.update(dependent, { title: encodeURIComponent(['', 'home', 'private', 'dependent'].join('/')) });
    const before = peerBytes(f.pmRoot, dependent);
    if (format === 'sdk') {
      const result = await f.shared.close(id, 'Public completion', claim.token);
      assert.ok(result.warnings?.some(value => value.startsWith(`auto_unblock_failed:${dependent}:`) && value.includes('swarm_private_path')));
    } else {
      const result = f.cli('swarm', 'close', id, '--note', 'Public completion', '--token', claim.token, ...(format === 'json' ? ['--json'] : []));
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /auto_unblock_failed/); assert.match(result.stdout, /swarm_private_path/);
    }
    assert.deepEqual(peerBytes(f.pmRoot, dependent), before);
  }
});
