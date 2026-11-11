import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLOSE_INTENT, parseCloseJournal, withCloseObserver } from '../src/close-journal.ts';
import type { CloseJournal } from '../src/close-journal.ts';
import { closeBytes, closeProcess, recoveryFixture } from './close-recovery-helpers.ts';

test('native persisted intent validation rejects malformed plans and progress without another mutation', async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1);
  await f.shared.close(id, 'Public native completion', token);
  const encoded = String((await f.client.get(id, { depth: 'full' })).item[CLOSE_INTENT]);
  const journal = parseCloseJournal(f.shared.engine, encoded);
  const mutations = [
    (value: CloseJournal) => { value.protocol = 'legacy' as CloseJournal['protocol']; },
    (value: CloseJournal) => { value.compensation_id = '../foreign'; },
    (value: CloseJournal) => { value.members = []; },
    (value: CloseJournal) => { value.members.push(value.members[0]); },
    (value: CloseJournal) => { value.members[0].head.length = 0; },
    (value: CloseJournal) => { value.members[0].digest = 'wrong'; },
    (value: CloseJournal) => { value.members[0].version = 0; },
    (value: CloseJournal) => { value.members[0].document_hash = 'wrong'; },
    (value: CloseJournal) => { value.post.push(value.post[0]); },
    (value: CloseJournal) => { value.post[0].head.hash = 'wrong'; },
    (value: CloseJournal) => { value.post[0].id = 'foreign'; },
    (value: CloseJournal) => { value.restored = [id]; },
    (value: CloseJournal) => { value.restored = [ids[1], ids[1]]; },
    (value: CloseJournal) => { value.warnings = undefined; },
    ...[
      ['id', 42], ['note', false], ['token', {}], ['phase', 'unknown'], ['members', {}], ['post', null], ['restored', null], ['warnings', [false]], ['result_signature', 17], ['result_signature', 'invalid'],
    ].map(([key, invalid]) => (value: CloseJournal) => { Reflect.set(value, String(key), invalid); }),
    (value: CloseJournal) => { value.members[0].id = 'different-primary'; },
    (value: CloseJournal) => { value.members[1].head.hash = 'wrong'; },
    (value: CloseJournal) => { Reflect.set(value.members[1], 'id', 42); },
    (value: CloseJournal) => { value.post[0].head.length = 0; },
    (value: CloseJournal) => { value.restored = ['foreign']; },
  ];
  const cases = mutations.map(mutate => ({ mutate, code: 'swarm_close_recovery_unsupported' }));
  cases.push({ mutate: value => { value.note = ['', 'home', 'private', 'note'].join('/'); }, code: 'swarm_private_path' });
  for (const { mutate, code } of cases) {
    const value = structuredClone(journal); mutate(value);
    await f.client.update(id, { force: true, field: [`${CLOSE_INTENT}=${JSON.stringify(value)}`] });
    const before = closeBytes(f, ids);
    await assert.rejects(f.shared.close(id, journal.note, token), { code });
    assert.deepEqual(closeBytes(f, ids), before);
  }
  for (const invalid of [undefined, '{}', 'null', '[]', '{bad json}']) assert.throws(() => parseCloseJournal(f.shared.engine, invalid), { code: 'swarm_close_recovery_unsupported' });
  assert.equal(parseCloseJournal(f.shared.engine, encoded).compensation_id, journal.compensation_id);
  for (const phase of ['applying', 'compensating'] as const) assert.equal(parseCloseJournal(f.shared.engine, JSON.stringify({ ...journal, phase, warnings: undefined })).phase, phase);
});

test('completed compensation permits a new claim generation and another native completion', async t => {
  const { f, id, token } = await recoveryFixture(t, 1);
  await assert.rejects(withCloseObserver(boundary => { if (boundary === 'before_commit') throw new Error('Ordinary boundary failure'); }, () => f.shared.close(id, 'Public native completion', token)), { code: 'swarm_close_compensated' });
  const next = await f.shared.start(id); assert.ok(BigInt(next.token) > BigInt(token));
  const finished = closeProcess(f, id, next.token, { note: 'New completion attempt' });
  assert.equal(finished.status, 0, finished.stdout + finished.stderr);
});

test('a native deletion during pending recovery produces an explicit partial member receipt', async t => {
  const { f, id, token, ids } = await recoveryFixture(t, 1);
  assert.equal(closeProcess(f, id, token, { kill: { boundary: 'before_commit' } }).signal, 'SIGKILL');
  await f.client.delete(ids[1], { force: true });
  const result = closeProcess(f, id, token);
  assert.equal(result.outcome?.code, 'swarm_compensation_partial');
  assert.equal((await f.client.get(id)).item.status, 'closed');
});
