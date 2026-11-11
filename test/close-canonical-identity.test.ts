import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { getHistoryPath, getItemPath, hashDocument, locateItem, readLocatedItem, readSettings, resolveItemTypeRegistry, serializeItemDocument } from '@unbrained/pm-cli/sdk';
import { captureCloseMember, memberDigest, withCloseObserver } from '../src/close-journal.ts';
import { applyClose, prepareClose } from '../src/close-recovery.ts';
import { withSwarmLease } from '../src/lease.ts';
import { closeBytes, closeProcess, recoveryFixture } from './close-recovery-helpers.ts';

const VARIANTS = [
  { name: 'CRLF', encode: (text: string) => text.replaceAll('\n', '\r\n') },
  { name: 'UTF-8 BOM', encode: (text: string) => `\uFEFF${text}` },
  { name: 'trailing whitespace', encode: (text: string) => text.replaceAll('\n', '   \n') },
  { name: 'missing final newline', encode: (text: string) => text.trimEnd() },
  { name: 'extra final newlines', encode: (text: string) => `${text}\n\n` },
  { name: 'BOM plus CRLF and whitespace', encode: (text: string) => `\uFEFF${text.replaceAll('\n', '   \r\n')}\r\n` },
];
type Fixture = Awaited<ReturnType<typeof recoveryFixture>>;

/** Parse actual tracker files with the SDK's configured native document grammar. */
async function documents(fixture: Fixture) {
  const { f, ids } = fixture; const settings = await readSettings(f.pmRoot);
  return Promise.all(ids.map(async id => {
    const located = await locateItem(f.pmRoot, id, settings.id_prefix, settings.item_format, resolveItemTypeRegistry(settings).type_to_folder);
    assert.ok(located); return (await readLocatedItem(located, { schema: settings.schema })).document;
  }));
}

/** Persist a genuinely different encoding and prove the native parser sees identical content. */
async function variantFile(fixture: Fixture, variant: typeof VARIANTS[number], id = fixture.ids[1]): Promise<void> {
  const before = await documents(fixture); const path = getItemPath(fixture.f.pmRoot, 'Task', id);
  const original = readFileSync(path, 'utf8'); const encoded = variant.encode(original);
  assert.notEqual(encoded, original); writeFileSync(path, encoded);
  assert.equal(readFileSync(path, 'utf8'), encoded);
  assert.deepEqual(await documents(fixture), before, 'the on-disk variant changes spelling, never content');
}

/** Verify the settled native receipt replays through every public renderer without another write. */
async function assertSettled(fixture: Fixture): Promise<void> {
  const { f, id, token, ids } = fixture;
  const stable = closeBytes(f, ids);
  await assert.rejects(f.shared.close(id, 'Public native completion', token), { code: 'swarm_close_compensated' });
  for (const json of [false, true]) {
    const retry = f.cli('swarm', 'close', id, '--note', 'Public native completion', '--token', token, ...(json ? ['--json'] : []));
    assert.notEqual(retry.status, 0); assert.match(retry.stdout + retry.stderr, /swarm_close_compensated/);
  }
  assert.deepEqual(closeBytes(f, ids), stable, 'SDK/JSON/TOON retries append no duplicate writes');
}

/** A real SIGKILL after native close must converge to normalized native state and stable audit receipts. */
async function recoverVariant(t: Parameters<typeof recoveryFixture>[0], variant: typeof VARIANTS[number], primary = false) {
  const fixture = await recoveryFixture(t, 1); const { f, id, token, ids } = fixture;
  await variantFile(fixture, variant, primary ? id : ids[1]);
  const before = await documents(fixture); const histories = closeBytes(f, ids).histories;
  const killed = closeProcess(f, id, token, { kill: { boundary: 'closed' } });
  assert.equal(killed.signal, 'SIGKILL', killed.stdout + killed.stderr);
  assert.equal((await f.client.get(id)).item.status, 'closed');
  const recovered = closeProcess(f, id, token);
  assert.equal(recovered.outcome?.code, 'swarm_close_compensated', recovered.stdout + recovered.stderr);
  assert.notEqual((await f.client.get(id)).item.status, 'closed', 'the primary must not remain stranded');
  assert.deepEqual(await documents(fixture), before, 'native content and timestamps restore exactly');
  for (const [index, history] of closeBytes(f, ids).histories.entries()) assert.ok(history.startsWith(histories[index]));
  await assertSettled(fixture);
}

for (const variant of VARIANTS) test(`canonical compensation restores a ${variant.name} TOON dependent after native close SIGKILL`, async t => {
  await recoverVariant(t, variant);
});

test('canonical compensation also restores a noncanonical primary document', async t => {
  await recoverVariant(t, VARIANTS.at(-1)!, true);
});

test('every admission and live member digest equals the SDK document identity across disk encodings', async t => {
  const fixture = await recoveryFixture(t, 1); const { f, ids } = fixture;
  const originals = closeBytes(f, ids).items;
  const expected = (await documents(fixture)).map(document => hashDocument(document));
  for (const variant of VARIANTS) for (const [index, id] of ids.entries()) {
    writeFileSync(getItemPath(f.pmRoot, 'Task', id), originals[index]);
    await variantFile(fixture, variant, id);
    assert.equal((await captureCloseMember(f.shared.engine, id)).member.digest, expected[index]);
    assert.equal(await memberDigest(f.shared.engine, id), expected[index]);
  }
});

test('legacy v3 raw admission digests recover through their certified canonical history', async t => {
  const fixture = await recoveryFixture(t, 1); const { f, id, token } = fixture;
  await variantFile(fixture, VARIANTS.at(-1)!); const before = await documents(fixture);
  const prepared = await prepareClose(f.shared.engine, id, 'Public native completion', token, await captureCloseMember(f.shared.engine, id));
  // This is the exact admission field emitted by the previous v3 implementation, not a repaired receipt.
  prepared.journal.members = prepared.journal.members.map(member => ({ ...member, digest: createHash('sha256').update(readFileSync(getItemPath(f.pmRoot, 'Task', member.id))).digest('hex') }));
  await assert.rejects(withSwarmLease(f.pmRoot, f.shared.engine.author, lease => withCloseObserver(boundary => {
    if (boundary === 'closed') throw new Error('Interrupted legacy native close');
  }, () => applyClose(f.shared.engine, lease, prepared))), { code: 'swarm_close_compensated' });
  assert.deepEqual(await documents(fixture), before);
  await assertSettled(fixture);
});

test('harmless encoding recovers but genuine dependent content changed after admission still refuses', async t => {
  // The old implementation already refused real divergence; this must-allow control makes the pair revert-sensitive.
  await recoverVariant(t, VARIANTS[0]);
  const fixture = await recoveryFixture(t, 1); const { f, id, token, ids } = fixture;
  await variantFile(fixture, VARIANTS[1]);
  assert.equal(closeProcess(f, id, token, { kill: { boundary: 'closed' } }).signal, 'SIGKILL');
  const changed = (await documents(fixture))[1]; changed.metadata.description = 'Independent peer content';
  const settings = await readSettings(f.pmRoot);
  writeFileSync(getItemPath(f.pmRoot, 'Task', ids[1]), serializeItemDocument(changed, { format: settings.item_format, schema: settings.schema }));
  const stable = closeBytes(f, ids);
  assert.equal(closeProcess(f, id, token).outcome?.code, 'swarm_compensation_partial');
  assert.deepEqual(closeBytes(f, ids), stable, 'unlogged peer content and native history must survive refusal');
});


test('native digest and compensation honor the located JSON Markdown format inside a TOON tracker', async t => {
  const fixture = await recoveryFixture(t, 1); const { f, id, token, ids } = fixture;
  const before = await documents(fixture); const dependent = ids[1];
  const path = getItemPath(f.pmRoot, 'Task', dependent, 'json_markdown');
  const settings = await readSettings(f.pmRoot);
  writeFileSync(path, `${serializeItemDocument(before[1], { format: 'json_markdown', schema: settings.schema }).replaceAll('\n', '\r\n')}\r\n`);
  unlinkSync(getItemPath(f.pmRoot, 'Task', dependent));
  assert.equal((await f.client.get(dependent)).item.status, 'blocked');
  assert.equal(await memberDigest(f.shared.engine, dependent), hashDocument(before[1]));
  assert.equal(closeProcess(f, id, token, { kill: { boundary: 'closed' } }).signal, 'SIGKILL');
  assert.equal(closeProcess(f, id, token).outcome?.code, 'swarm_close_compensated');
  assert.deepEqual(await documents(fixture), before);
  const restored = await locateItem(f.pmRoot, dependent, settings.id_prefix, settings.item_format, resolveItemTypeRegistry(settings).type_to_folder);
  assert.ok(restored); const restoredPath = restored.itemPath;
  const bytes = readFileSync(restoredPath, 'utf8'); const historyPath = getHistoryPath(f.pmRoot, dependent);
  const history = readFileSync(historyPath, 'utf8');
  await assert.rejects(f.shared.close(id, 'Public native completion', token), { code: 'swarm_close_compensated' });
  assert.equal(readFileSync(restoredPath, 'utf8'), bytes); assert.equal(readFileSync(historyPath, 'utf8'), history);
});
