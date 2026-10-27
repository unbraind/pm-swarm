import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PmClient, getHistoryPath } from '@unbrained/pm-cli/sdk';
import { Swarm } from '../src/swarm.ts';
import { SharedTracker } from '../src/shared-tracker.ts';
import { SettingsRefusal, withItemMutationObserver } from '../src/settings.ts';
import { touchHeartbeat } from '../src/lease.ts';
import { durableSnapshot } from './privacy-snapshot.ts';

interface Probe { cwd: string; pmRoot: string; host: string; id: string; layout: 'shared' | 'separate'; boundary: string; private: boolean }
const input = JSON.parse(process.argv[2]) as Probe;
const client = new PmClient({ cwd: input.cwd, pmRoot: input.pmRoot, author: 'shared-test', noExtensions: false });
const engine = new Swarm(input.cwd, input.pmRoot, client, 'shared-test'); const shared = new SharedTracker(engine);
const manifestPath = join(input.pmRoot, 'extensions/pm-swarm/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
let injected = false; let expected = ''; let peerHistory = '';
/** Preserve package runtime in comparisons while excluding SDK-owned ignored cache/usage receipts. */
function durable(): [string, unknown][] {
  return JSON.parse(durableSnapshot(input.pmRoot)) as [string, unknown][];
}
const before = durable();
/** A separate real core CLI commits the peer edit; no SDK return value is substituted. */
function compete(): void {
  assert.equal(injected, false); injected = true;
  const title = input.private ? encodeURIComponent(['', 'home', 'private', 'peer-title'].join('/')) : 'Public peer title';
  const peer = spawnSync(process.execPath, [input.host, '--no-extensions', 'update', input.id, '--title', title, '--json'], { cwd: input.cwd, encoding: 'utf8', env: process.env });
  assert.equal(peer.status, 0, 'Independent peer update must commit');
  peerHistory = readFileSync(getHistoryPath(input.pmRoot, input.id), 'utf8');
  // The native host activates this installed package at its next call. Same-version SDK copies still differ by identity.
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, entry: `${input.layout}-entry.js` }));
  const peerState = durable().filter(([name]) => name !== 'runtime/swarm' && !name.startsWith('runtime/swarm/'));
  const priorRuntime = before.filter(([name]) => name === 'runtime/swarm' || name.startsWith('runtime/swarm/'));
  expected = JSON.stringify([...peerState, ...priorRuntime].sort(([left], [right]) => left.localeCompare(right)));
}

if (input.boundary === 'corpus-return') {
  const corpus = engine.corpus.bind(engine);
  engine.corpus = async () => { const result = await corpus(); if (!injected) compete(); return result; };
}
if (input.boundary === 'snapshot-return') {
  const get = client.get.bind(client);
  client.get = async (...args) => { const result = await get(...args); if (args[0] === input.id && !injected) compete(); return result; };
}
if (input.boundary === 'writer-entry') {
  const update = client.update.bind(client);
  client.update = async (...args) => { if (!injected) compete(); return update(...args); };
}
let returned = false; let refusalCode = '';
await assert.rejects(withItemMutationObserver(boundary => { if (boundary === input.boundary && !injected) compete(); }, async () => { await shared.start(input.id); returned = true; }), (error: unknown) => {
  assert.ok(error instanceof SettingsRefusal, `Use a portable typed refusal across package copies: ${String(error).replace(/(?:file:\/\/)?\/[^\s"')]+/g, '[coordinate]')}`);
  refusalCode = error.code;
  const expectedCode = input.boundary === 'snapshot-return' ? 'swarm_superseded' : input.layout === 'separate' ? 'swarm_sdk_mismatch' : input.boundary === 'corpus-return' ? 'swarm_private_path' : 'swarm_superseded';
  assert.equal(error.code, expectedCode);
  if (expectedCode === 'swarm_superseded') assert.equal(error.field, 'history');
  assert.ok(error.remedy.length > 20); return true;
});
assert.equal(injected, true); assert.equal(returned, false);
if (refusalCode === 'swarm_sdk_mismatch') assert.throws(() => touchHeartbeat(input.pmRoot, 'shared-test'), error => error instanceof SettingsRefusal && error.code === 'swarm_sdk_mismatch');
assert.equal(readFileSync(getHistoryPath(input.pmRoot, input.id), 'utf8'), peerHistory);
assert.equal(JSON.stringify(durable().sort(([left], [right]) => left.localeCompare(right))), expected, 'Only the peer document/history and installed-layout transition may persist');
process.stdout.write(JSON.stringify({ injected: 1, tracker_changes_by_package: 0, partial_receipts: 0, peer_history_preserved: true }));
