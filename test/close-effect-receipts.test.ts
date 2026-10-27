import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeEffects } from '../src/close-journal.ts';
import { SettingsRefusal } from '../src/settings.ts';

/** Durable secondary receipts validate complete native checkpoints before they can select any restore target. */
test('close effect receipts reject malformed ownership data and preserve valid checkpoints', () => {
  const point = { version: 1, hash: 'a'.repeat(64), historyHead: { length: 1, hash: 'b'.repeat(64) } };
  const effect = { id: 'public-item', before: point, after: { ...point, version: 2 } };
  for (const absent of [undefined, null, [], {}, { warnings: [] }]) assert.equal(closeEffects(absent), undefined);
  assert.deepEqual(closeEffects({ effects: [] }), []);
  assert.deepEqual(closeEffects({ effects: [effect] }), [effect]);
  const invalid = [null, {}, 4, 'invalid', [null], [[]], [{}], [{ id: 4 }], [{ ...effect, before: null }],
    ...[0, -1, '1'].map(version => [{ ...effect, before: { ...point, version } }]),
    ...[undefined, null, [], { length: '1', hash: 'b' }, { length: 1, hash: 4 }].map(historyHead => [{ ...effect, after: { ...point, historyHead } }]),
  ];
  for (const effects of invalid) assert.throws(() => closeEffects({ effects }), error => error instanceof SettingsRefusal && error.code === 'swarm_document_changed' && error.field === 'document');
});
