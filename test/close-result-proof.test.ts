import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCloseProposals, validCloseResult } from '../src/close-proofs.ts';
import { readItemHistoryHead } from '../src/settings.ts';
import { appendCopiedClosePhase, closeBytes, closeProcess, pendingClose } from './close-recovery-helpers.ts';

test('a copied committed phase cannot invent a successful warning receipt for a half-closed native domain', async t => {
  const { f, id, token, ids, journal } = await pendingClose(t, 1, 'native');
  assert.equal((await f.client.get(ids[1])).item.status, 'blocked');
  const forged = { ...journal, phase: 'committed' as const, warnings: ['Invented success receipt'], proofs: await loadCloseProposals(f.shared.engine, journal), post: [{ id, head: await readItemHistoryHead(f.pmRoot, id) }] };
  assert.equal(validCloseResult(forged), false);
  assert.equal(validCloseResult({ ...forged, result_signature: 'not-signed' }), false);
  assert.equal(validCloseResult({ ...forged, result_signature: '0'.repeat(128) }), false);
  assert.equal(validCloseResult({ ...forged, phase: 'applying' }), false);
  await appendCopiedClosePhase(f, forged, { field: [`swarm_token=${BigInt(token) + 1n}`], unset: ['swarm_handoff', 'swarm_claimed_at'] });
  const before = closeBytes(f, ids); const replay = closeProcess(f, id, token);
  assert.equal(replay.outcome?.code, 'swarm_compensation_partial', replay.stdout + replay.stderr);
  assert.deepEqual(closeBytes(f, ids), before);
});
