import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { gitEnvironment } from '../src/git-environment.ts';
import { assertFixtureRepo, fixtureGit, fixtureSnapshot } from './git-helpers.ts';

/** Install and invoke the packed artifact in independent real npm and Bun consumers. */
test('packed npm/npx and native Bun/bunx run all swarm commands and retain path privacy', { timeout: 600000 }, t => {
  const root = process.cwd(); const scratch = mkdtempSync(join(tmpdir(), 'swarm-install-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const decoy = join(scratch, 'decoy'); mkdirSync(decoy); fixtureGit(decoy, ['init', '-b', 'main']);
  writeFileSync(join(decoy, 'sentinel'), 'preserve decoy contents\n'); fixtureGit(decoy, ['add', 'sentinel']);
  const before = fixtureSnapshot(decoy);
  /** Run an isolated consumer command, refusing nonzero setup or command results. */
  const run = (cwd: string, bin: string, args: string[]) => {
    const env = gitEnvironment({ ...process.env, GIT_DIR: join(decoy, '.git'), HOME: scratch, PM_PATH: join(cwd, '.agents/pm'), PM_AUTHOR: 'install-test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', NPM_CONFIG_USERCONFIG: '/dev/null', npm_config_userconfig: '/dev/null' });
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete (env as NodeJS.ProcessEnv)[key];
    if (bin === 'git' && args[0] !== 'init') assertFixtureRepo(cwd);
    const result = spawnSync(bin, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.status, 0, `${bin} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`); return result.stdout;
  };
  const packed = JSON.parse(run(root, 'npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch])) as { filename: string; files: { path: string }[] }[];
  for (const { path } of packed[0].files) assert.ok(path.startsWith('dist/') || ['package.json', 'manifest.json', 'LICENSE', 'README.md', 'CHANGELOG.md'].includes(path), path);
  const tarball = join(scratch, packed[0].filename);
  for (const runtime of ['npm', 'bun']) {
    const cwd = join(scratch, runtime); mkdirSync(cwd); writeFileSync(join(cwd, 'package.json'), '{"name":"swarm-consumer","private":true,"type":"module"}\n');
    run(cwd, runtime, [runtime === 'npm' ? 'install' : 'add', '--ignore-scripts', tarball, '@unbrained/pm-cli@2026.10.15']);
    run(cwd, 'git', ['init', '-b', 'main', cwd]);
    assertFixtureRepo(cwd);
    const runner = runtime === 'npm' ? 'npx' : 'bunx'; const prefix = runtime === 'npm' ? ['--no-install', 'pm'] : ['--bun', '--no-install', 'pm'];
    /** Invoke the installed host with the packed project extension enabled. */
    const pm = (...args: string[]) => run(cwd, runner, [...prefix, ...args]);
    pm('init', 'consumer', '--defaults', '--agent-guidance', 'skip');
    appendFileSync(join(cwd, '.gitignore'), '\n.agents/pm/extensions/\nnode_modules/\nlanes/\n');
    pm('install', tarball, '--project');
    pm('swarm', 'settings', '--root', 'lanes', '--limit', '2', '--apply', '--json');
    const raw = JSON.parse(readFileSync(join(cwd, '.agents/pm/settings.json'), 'utf8')) as { swarm: { lane_limit: number } }; assert.equal(raw.swarm.lane_limit, 2);
    const id = (JSON.parse(pm('create', 'Task', 'Consumer lane', '--json')) as { id: string }).id;
    pm('files', id, '--add', 'code.txt'); writeFileSync(join(cwd, 'code.txt'), 'base\n');
    writeFileSync(join(cwd, 'verify.test.js'), "import {test} from 'node:test';import assert from 'node:assert/strict';test('packed lane',()=>assert.equal(2+2,4));\n");
    pm('test', id, '--add', `command=${runtime === 'npm' ? 'node --test' : 'bun test'} verify.test.js`);
    run(cwd, 'git', ['add', '.agents/pm', '.gitignore', '.gitattributes', 'code.txt', 'package.json', 'verify.test.js', ...(existsSync(join(cwd, 'package-lock.json')) ? ['package-lock.json'] : []), ...(existsSync(join(cwd, 'bun.lock')) ? ['bun.lock'] : [])]);
    run(cwd, 'git', ['-c', 'user.name=SteveBot', '-c', 'user.email=1153461+unbraind@users.noreply.github.com', 'commit', '-m', 'Record consumer']);
    const plan = JSON.parse(pm('swarm', 'plan', '--json')) as { suggested_start_set: string[] }; assert.deepEqual(plan.suggested_start_set, [id]); assert.match(pm('swarm', 'plan'), /suggested_start_set/);
    assert.doesNotMatch(pm('swarm', 'plan'), /complete_list|read_output|estimated_tokens/);
    assert.match(pm('swarm', 'plan', '--full'), /complete_list/);
    const next = JSON.parse(pm('swarm', 'next', '--dry-run', '--agent', 'install-test', '--json')) as { selected: string; dry_run: boolean };
    assert.equal(next.selected, id); assert.equal(next.dry_run, true);
    const start = JSON.parse(pm('swarm', 'next', '--agent', 'install-test', '--json')) as { branch: string; selected: string };
    assert.equal(start.branch, `swarm/${id}`); assert.equal(start.selected, id);
    const status = JSON.parse(pm('swarm', 'status', '--json')) as { lanes: unknown[] }; assert.equal(status.lanes.length, 1);
    const detailed = JSON.parse(pm('swarm', 'status', '--full', '--json')) as { predictions: { left_id: string; right_id: string; tree: string }[] };
    assert.equal(detailed.predictions.length, 1); assert.equal(detailed.predictions[0].left_id, id); assert.equal(detailed.predictions[0].right_id, 'base'); assert.match(detailed.predictions[0].tree, /^[a-f0-9]{40,64}$/);
    assert.equal((JSON.parse(pm('swarm', 'sync', id, '--json')) as { dry_run: boolean }).dry_run, true);
    assert.deepEqual((JSON.parse(pm('swarm', 'land', '--json')) as { order: string[] }).order, [id]);
    run(cwd, 'git', ['add', '.agents/pm']);
    run(cwd, 'git', ['-c', 'user.name=SteveBot', '-c', 'user.email=1153461+unbraind@users.noreply.github.com', 'commit', '-m', 'Record lane']);
    assert.equal((JSON.parse(pm('swarm', 'land', '--execute', '--json')) as { executed: boolean }).executed, true);
    assert.equal((JSON.parse(pm('swarm', 'reap', '--dry-run', '--json')) as { removed: string[] }).removed.length, 0);
    for (const file of run(cwd, 'git', ['ls-files', '-z', '.agents/pm']).split('\0').filter(Boolean)) assert.equal(readFileSync(join(cwd, file), 'utf8').includes(scratch), false, file);
  }
  assert.deepEqual(fixtureSnapshot(decoy), before, 'Decoy repository changed');
});
