import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { estimatePmOutputTokens, getHistoryPath, getItemPath, PmClient, readSettings } from '@unbrained/pm-cli/sdk';
import { readAssignmentBrief } from '../index.ts';
import type { AssignmentBrief } from '../index.ts';
import { fixture, swarmCli } from './helpers.ts';
import { durableSnapshot } from './privacy-snapshot.ts';
import { runProcess } from './process-helpers.ts';
import { sharedFixture } from './shared-helpers.ts';

test('concurrent agents receive only their fenced item and cannot use a transferred generation', async t => {
  const f = await sharedFixture(t);
  const parser = await f.item(['src/parser.ts'], 0);
  const renderer = await f.item(['src/renderer.ts'], 1);
  const overlap = await f.item(['src/parser.ts'], 2);
  await f.client.update(parser, {
    title: 'Parser assignment', description: 'Keep quoted fields intact.',
    acceptanceCriteria: 'Accept naïve and 日本語 input.',
    body: 'Oversized details. '.repeat(260),
  });
  await f.client.update(renderer, { title: 'Renderer assignment', acceptanceCriteria: 'Retain the existing layouts.' });
  await f.client.docs(parser, { add: ['docs/parser.md'] });
  await f.client.run('test', { id: parser, options: { add: ['command=node --test parser.test.js'] } });
  for (let index = 0; index < 6; index++) {
    await f.client.update(parser, { comment: [`Progress ${index} ${'parsed payload '.repeat(16)}`] });
  }

  /** Run separate host processes on the same synthetic tracker. */
  const run = (args: string[]) => runProcess(process.execPath, [f.host, 'swarm', ...args], f.repo, f.env);
  const agents = ['worker-one', 'worker-two'];
  const starts = await Promise.all(agents.map(agent => run(['next', '--agent', agent, '--json'])));
  const assignments = starts.map(result => {
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout) as { selected: string; token: string; agent: string };
  });
  assert.deepEqual(assignments.map(result => result.selected).sort(), [parser, renderer].sort());
  assert.equal((await f.client.get(overlap)).item.assignee, undefined);
  const ownership = assignments.find(result => result.selected === parser)!;
  const peer = assignments.find(result => result.selected === renderer)!;
  const histories = [parser, renderer].map(id => getHistoryPath(f.pmRoot, id));
  const before = histories.map(path => readFileSync(path, 'utf8'));

  /** Forward only one worker's assignment key, token and chosen output budget. */
  const brief = (claim: typeof ownership, format?: '--json') => run([
    'brief', claim.selected, '--agent', claim.agent, '--token', claim.token, '--token-budget', '256', ...(format ? [format] : []),
  ]);
  const [parserJson, rendererJson, parserToon, crossRead] = await Promise.all([
    brief(ownership, '--json'), brief(peer, '--json'), brief(ownership), brief({ ...ownership, agent: peer.agent }, '--json'),
  ]);
  for (const output of [parserJson, rendererJson, parserToon]) {
    assert.equal(output.code, 0, output.stderr || output.stdout);
    assert.ok(estimatePmOutputTokens(Buffer.byteLength(output.stdout)) <= 256);
  }
  assert.equal(crossRead.code, 2);
  assert.match(crossRead.stderr + crossRead.stdout, /swarm_stale_fence/);
  assert.doesNotMatch(crossRead.stderr + crossRead.stdout, /Parser assignment|parsed payload/);
  const parserBrief = JSON.parse(parserJson.stdout) as AssignmentBrief;
  const rendererBrief = JSON.parse(rendererJson.stdout) as AssignmentBrief;
  assert.equal(parserBrief.id, parser);
  assert.equal(parserBrief.agent, ownership.agent);
  assert.equal(parserBrief.token, ownership.token);
  assert.equal(parserBrief.context.acceptance_criteria, 'Accept naïve and 日本語 input.');
  assert.deepEqual(parserBrief.context.files, ['src/parser.ts']);
  assert.deepEqual(parserBrief.context.docs, ['docs/parser.md']);
  assert.deepEqual(parserBrief.context.tests, [{ command: 'node --test parser.test.js' }]);
  assert.equal(parserBrief.context.body, undefined);
  assert.equal(parserBrief.omission_receipt.body, 1);
  const deliveredComments = parserBrief.context.comments ?? [];
  assert.ok(deliveredComments[0]?.startsWith('Swarm claim token'));
  assert.equal(parserBrief.omission_receipt.comments, 7 - deliveredComments.length);
  assert.deepEqual(rendererBrief.omission_receipt, {});
  assert.doesNotMatch(parserJson.stdout + parserToon.stdout, /Renderer assignment|src\/renderer/);
  assert.doesNotMatch(rendererJson.stdout, /Parser assignment|src\/parser/);
  assert.match(parserToon.stdout, /Accept naïve and 日本語 input/);
  assert.deepEqual(histories.map(path => readFileSync(path, 'utf8')), before);

  const moved = f.run('swarm', 'handoff', parser, '--agent', ownership.agent, '--token', ownership.token, '--to', 'replacement', '--note', 'Resume at parser validation.');
  const returned = f.run('swarm', 'handoff', parser, '--agent', 'replacement', '--token', String(moved.token), '--to', ownership.agent, '--note', 'Validate the quoted field path.');
  const [stale, current] = await Promise.all([
    brief(ownership, '--json'), brief({ ...ownership, token: String(returned.token) }, '--json'),
  ]);
  assert.equal(stale.code, 2);
  assert.match(stale.stderr + stale.stdout, /swarm_stale_fence/);
  assert.equal(current.code, 0, current.stderr || current.stdout);
  assert.equal(JSON.parse(current.stdout).context.comments[0], 'Validate the quoted field path.');
});

test('Git work uses the same brief and service discovery retains the bound item read', async t => {
  const f = await fixture(t);
  const id = await f.item(['src/lane.ts']);
  const linked = await f.item();
  await f.client.update(id, { dep: [`id=${linked},kind=related`] });
  f.save();
  const claim = swarmCli(f, ['start', id]);
  assert.equal(claim.status, 0, claim.stderr || claim.stdout);
  const handoff = swarmCli(f, ['handoff', id, '--to', 'lane-reviewer', '--note', 'Review the lane.']);
  assert.equal(handoff.status, 0, handoff.stderr || handoff.stdout);
  const { token } = JSON.parse(handoff.stdout) as { token: string };
  const manifestPath = join(f.pmRoot, 'extensions/pm-swarm/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { capabilities: string[] };
  manifest.capabilities.push('services');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const output = swarmCli(f, ['brief', id, '--agent', 'lane-reviewer', '--token', token]);
  assert.equal(output.status, 0, output.stderr || output.stdout);
  const receipt = JSON.parse(output.stdout) as AssignmentBrief;
  assert.equal(receipt.id, id);
  assert.equal(receipt.token_budget, 512);
  assert.deepEqual(receipt.context.files, ['src/lane.ts']);
  assert.deepEqual(receipt.context.dependencies, [{ id: linked, kind: 'related' }]);
  assert.equal('worktree' in receipt, false);
});

test('invalid budgets, ordinary core claims, resources and terminal work are refused', async t => {
  const f = await sharedFixture(t);
  const id = await f.item();
  const engine = f.shared.engine;
  await f.client.claim(id);
  await assert.rejects(readAssignmentBrief(engine, id, '1'), { code: 'swarm_stale_fence' });
  const claim = await f.shared.start(id);
  for (const invalid of [undefined, 'invalid']) {
    await assert.rejects(readAssignmentBrief(engine, id, invalid), /Supply the decimal --token/);
  }
  for (const invalid of [0, 0.5, 8193]) {
    await assert.rejects(readAssignmentBrief(engine, id, claim.token, invalid), /Set --token-budget/);
  }
  await assert.rejects(readAssignmentBrief(engine, id, claim.token, 1), /Increase --token-budget/);
  const missing = f.cli('swarm', 'brief', id, '--json');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr + missing.stdout, /Supply the decimal --token/);

  const resource = (await f.client.create({ type: 'Task', title: 'Public resource', tags: 'swarm-resource' })).item.id;
  const held = f.run('swarm', 'resource', resource, '--action', 'reserve');
  await assert.rejects(readAssignmentBrief(engine, resource, String(held.token)), /active work item/);

  const independent = new PmClient({ cwd: f.repo, pmRoot: f.pmRoot, author: 'shared-test', noExtensions: true });
  await independent.update(id, { status: 'canceled' });
  await independent.claim(id, { force: true });
  await assert.rejects(readAssignmentBrief(engine, id, claim.token), /active work item/);
});

test('brief withholds private fields from real tracker snapshots in JSON and TOON', async t => {
  const f = await sharedFixture(t);
  const id = await f.item(['src/public.ts']);
  const { token } = await f.shared.start(id);
  const independent = new PmClient({ cwd: f.repo, pmRoot: f.pmRoot, author: 'shared-test', noExtensions: true });
  const [comment, criteria, file, note] = ['progress', 'acceptance', 'footprint', 'note'].map(name => ['', 'home', 'synthetic-private', name].join('/'));
  const credential = ['ghp_', 'x'.repeat(36)].join('');
  await independent.update(id, {
    comment: [`Progress at ${comment}`, 'Public progress row'], acceptanceCriteria: `Verify ${criteria}`,
    description: 'Keep this public description.', body: 'Public detail. '.repeat(300),
  });
  await independent.files(id, { add: [file] });
  await independent.notes(id, { add: note });
  await independent.run('test', { id, options: { add: [`command=echo ${credential}`] } });
  const before = durableSnapshot(f.pmRoot);

  const expected = { acceptance_criteria: 'withheld: privacy', files: 'withheld: privacy', tests: 'withheld: privacy', body: 1, comments: 'withheld: privacy' };
  for (const format of [[], ['--json']]) {
    const result = f.cli('swarm', 'brief', id, '--token', token, '--token-budget', '256', ...format);
    assert.equal(result.status, 0, result.stderr);
    for (const value of [comment, criteria, file, note, credential, 'Public progress row', 'src/public.ts']) {
      assert.ok(!(result.stdout + result.stderr).includes(value));
    }
    assert.match(result.stdout, /withheld: privacy/);
    assert.match(result.stdout, /Keep this public description\./);
    assert.ok(estimatePmOutputTokens(Buffer.byteLength(result.stdout)) <= 256);
    if (format.length > 0) {
      const brief = JSON.parse(result.stdout) as AssignmentBrief;
      assert.deepEqual(brief.omission_receipt, expected);
      assert.deepEqual(brief.context, { title: 'Shared work', description: 'Keep this public description.' });
    }
  }
  assert.equal(durableSnapshot(f.pmRoot), before);
});

test('brief scans custom statuses and normalized footprints while refusing unsafe identity', async t => {
  const f = await sharedFixture(t);
  const id = await f.item();
  const { token } = await f.shared.start(id);
  const privatePath = ['', 'home', 'synthetic-private', 'identity'].join('/');
  const credential = ['ghp_', 'x'.repeat(36)].join('');
  const engine = f.shared.engine;
  for (const [requestedId, requestedToken] of [[privatePath, token], [id, privatePath]]) {
    await assert.rejects(readAssignmentBrief(engine, requestedId, requestedToken), { code: 'swarm_private_path' });
  }
  await assert.rejects(readAssignmentBrief(engine, credential, token), /Remove credential-shaped text/);
  const refused = f.cli('swarm', 'brief', id, '--agent', credential, '--token', token, '--json');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr + refused.stdout, /Remove credential-shaped text/);
  assert.ok(!(refused.stderr + refused.stdout).includes(credential));

  const prefs = await readSettings(f.pmRoot);
  writeFileSync(join(f.pmRoot, 'schema/statuses.json'), JSON.stringify([...prefs.schema.statuses, { id: credential, roles: ['active'] }]));
  await f.client.update(id, { status: credential });
  await f.client.files(id, { add: ['src/legacy.ts'] });
  // Native writes normalize paths. Simulate a legacy row that still needs read-time normalization.
  const itemPath = getItemPath(f.pmRoot, 'Task', id, prefs.item_format);
  const stored = readFileSync(itemPath, 'utf8');
  assert.match(stored, /src\/legacy\.ts/);
  writeFileSync(itemPath, stored.replace('src/legacy.ts', 'src/../~'));
  const brief = await readAssignmentBrief(engine, id, token);
  assert.equal(brief.status, undefined);
  assert.equal(brief.context.files, undefined);
  assert.deepEqual(brief.omission_receipt, { status: 'withheld: privacy', files: 'withheld: privacy' });
});
