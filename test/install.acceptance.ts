import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { once } from 'node:events';
import { isBuiltin } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import { gitEnvironment } from '../src/git-environment.ts';
import { assertFixtureRepo, fixtureGit, fixtureSnapshot } from './git-helpers.ts';

/** Install and invoke the packed artifact in independent real npm and Bun consumers. */
test('packed npm/npx and native Bun/bunx run all swarm commands and retain path privacy', { timeout: 600000 }, async t => {
  const root = process.cwd(); const scratch = mkdtempSync(join(tmpdir(), 'swarm-install-'));
  t.after(() => rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const decoy = join(scratch, 'decoy'); mkdirSync(decoy); fixtureGit(decoy, ['init', '-b', 'main']);
  writeFileSync(join(decoy, 'sentinel'), 'preserve decoy contents\n'); fixtureGit(decoy, ['add', 'sentinel']);
  const before = fixtureSnapshot(decoy);
  const inherited = { ...process.env, GIT_DIR: join(decoy, '.git'), PM_SOURCE_WORKSPACE_ROOT: decoy, PM_SOURCE_PM_PATH: join(decoy, '.agents/pm') };
  /** Isolate the real host from user configuration and inherited Git and pm targets. */
  const environment = (cwd: string) => {
    const env = gitEnvironment({ ...inherited, HOME: scratch, PM_PATH: join(cwd, '.agents/pm'), PM_SOURCE_WORKSPACE_ROOT: cwd, PM_SOURCE_PM_PATH: join(cwd, '.agents/pm'), PM_GLOBAL_PATH: join(scratch, '.pm-cli'), PM_AUTHOR: 'install-test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', NPM_CONFIG_USERCONFIG: '/dev/null', npm_config_userconfig: '/dev/null' });
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete (env as NodeJS.ProcessEnv)[key];
    delete env.PM_BUILD_CONSUMER_LEASE; delete env.PM_BUILD_CONSUMER_LEASE_ROOT;
    return env;
  };
  /** Run an isolated consumer command, refusing activation warnings even on success. */
  const run = (cwd: string, bin: string, args: string[]) => {
    if (bin === 'git' && args[0] !== 'init') assertFixtureRepo(cwd);
    const result = spawnSync(bin, args, { cwd, env: environment(cwd), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    assert.doesNotMatch(result.stdout + result.stderr, /Extension activation failures/);
    assert.equal(result.status, 0, `${bin} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`); return result.stdout;
  };
  const packed = JSON.parse(run(root, 'npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch])) as { filename: string; files: { path: string }[] }[];
  for (const { path } of packed[0].files) assert.ok(path.startsWith('dist/') || ['package.json', 'manifest.json', 'LICENSE', 'README.md', 'CHANGELOG.md'].includes(path), path);
  const tarball = join(scratch, packed[0].filename);
  const extracted = join(scratch, 'extracted'); mkdirSync(extracted);
  run(scratch, 'tar', ['-xzf', tarball, '-C', extracted]);
  const packageDir = join(extracted, 'package');
  for (const runtime of ['npm', 'bun']) {
    const cwd = join(scratch, runtime); mkdirSync(cwd); writeFileSync(join(cwd, 'package.json'), '{"name":"swarm-consumer","private":true,"type":"module"}\n');
    run(cwd, runtime, [runtime === 'npm' ? 'install' : 'add', '--ignore-scripts', '@unbrained/pm-cli@2026.10.15']);
    run(cwd, 'git', ['init', '-b', 'main', cwd]);
    assertFixtureRepo(cwd);
    const runner = runtime === 'npm' ? 'npx' : 'bunx'; const prefix = runtime === 'npm' ? ['--no-install', 'pm'] : ['--bun', '--no-install', 'pm'];
    /** Invoke the installed host with the packed project extension enabled. */
    const pm = (...args: string[]) => run(cwd, runner, [...prefix, ...args]);
    pm('init', 'consumer', '--defaults', '--agent-guidance', 'skip');
    appendFileSync(join(cwd, '.gitignore'), '\n.agents/pm/extensions/\nnode_modules/\nlanes/\n');
    assert.equal(existsSync(join(cwd, 'node_modules/pm-swarm')), false);
    pm('install', packageDir, '--project');
    assert.ok(existsSync(join(cwd, '.agents/pm/extensions/pm-swarm/dist/src/watch.js')));
    if (runtime === 'npm') assert.equal(existsSync(join(cwd, 'node_modules/@toon-format/toon')), false);
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
    const start = JSON.parse(pm('swarm', 'start', id, '--agent', 'install-test', '--json')) as { branch: string; worktree: string };
    assert.equal(start.branch, `swarm/${id}`);
    assert.equal(start.worktree, join(cwd, 'lanes', `${runtime}-${id}`));
    const host = join(cwd, 'node_modules/.bin/pm');
    const directPlan = JSON.parse(run(cwd, runtime === 'npm' ? process.execPath : 'bun', [host, 'swarm', 'plan', '--json'])) as { suggested_start_set: string[] };
    assert.deepEqual(directPlan.suggested_start_set, []);
    for (const json of [false, true]) {
      const watchArgs = [host, 'swarm', 'status', '--watch', '--interval', '0.1'];
      if (json) watchArgs.push('--json');
      const child = spawn(runtime === 'npm' ? process.execPath : 'bun', watchArgs, { env: { ...environment(cwd), PM_SWARM_TEST_POLL_HEARTBEAT: '1' }, cwd, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
      const exit = once(child, 'exit');
      const stream = { output: '', error: '' };
      child.stdout.on('data', chunk => { stream.output += chunk.toString(); });
      child.stderr.on('data', chunk => { stream.error += chunk.toString(); });
      try {
        const deadline = Date.now() + 15000;
        while ((!stream.output.includes(json ? '\n' : '\n\n') || !stream.error.includes('pm-swarm:test:poll-complete\n')) && child.exitCode === null && Date.now() < deadline) await delay(30);
        assert.doesNotMatch(stream.output + stream.error, /Extension activation failures|Unknown command/);
        assert.ok(stream.error.includes('pm-swarm:test:poll-complete\n'), stream.output + stream.error);
        const frame = stream.output.split(json ? '\n' : '\n\n')[0];
        const event = (json ? JSON.parse(frame) : decodeToon(frame)) as { event: string; data: { id: string } };
        assert.equal(event.event, 'lane_added'); assert.equal(event.data.id, id);
        const initial = stream.output;
        const polls = stream.error.split('pm-swarm:test:poll-complete\n').length - 1;
        const pollDeadline = Date.now() + 15000;
        while (stream.error.split('pm-swarm:test:poll-complete\n').length - 1 < polls + 2 && child.exitCode === null && Date.now() < pollDeadline) await delay(30);
        assert.ok(stream.error.split('pm-swarm:test:poll-complete\n').length - 1 >= polls + 2, stream.output + stream.error);
        assert.equal(stream.output, initial, 'unchanged packed watch polls are silent');
        child.kill('SIGINT');
        const [code, signal] = await exit;
        assert.equal(code, 0, stream.error); assert.equal(signal, null);
        assert.equal(stream.output.trimEnd(), initial.trimEnd(), 'watch shutdown emits no extra frames');
        assert.doesNotMatch(stream.error, /Extension activation failures/);
      } finally { child.kill('SIGKILL'); await exit; }
    }
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

/** Reject undeclared runtime imports across every compiled JavaScript module. */
test('built artifact has zero runtime dependencies beyond Node and the pm SDK', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies?: object; optionalDependencies?: object };
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(manifest.optionalDependencies ?? {}), []);
  const files = readdirSync('dist', { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.js'));
  assert.ok(files.length > 0, 'build must produce JavaScript');
  for (const file of files) {
    const source = readFileSync(join('dist', file), 'utf8');
    for (const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      assert.ok(specifier.startsWith('./') || specifier.startsWith('../') || (specifier.startsWith('node:') && isBuiltin(specifier)) || /^@unbrained\/pm-cli\/sdk(?:\/|$)/.test(specifier), `${file}: forbidden runtime import ${specifier}`);
    }
  }
});


/** Exercise the actual tarball on a plain tracker through Node and native Bun. */
test('packed tarball coordinates a non-git tracker with explicit files and healthy history', { timeout: 600000 }, async t => {
  const packageRoot = process.cwd(); const scratch = mkdtempSync(join(tmpdir(), 'swarm-shared-install-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const repo = join(scratch, 'project'); mkdirSync(repo);
  const pmRoot = join(repo, '.agents/pm');
  const host = join(packageRoot, 'node_modules/.bin/pm');
  const env = gitEnvironment({ ...process.env, HOME: scratch, GIT_CEILING_DIRECTORIES: scratch, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PM_PATH: pmRoot, PM_SOURCE_WORKSPACE_ROOT: repo, PM_SOURCE_PM_PATH: pmRoot, PM_GLOBAL_PATH: join(scratch, 'global-pm'), PM_AUTHOR: 'packed-worker' });
  /** Run the real pinned host and reject extension activation or command failures. */
  const invoke = (runtime: string, args: string[]) => {
    const result = spawnSync(runtime, [host, ...args, '--json'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /Extension activation failures/);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: packageRoot, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const filename = (JSON.parse(packed.stdout) as { filename: string }[])[0].filename;
  const tarball = join(repo, filename); writeFileSync(tarball, readFileSync(join(scratch, filename)));
  invoke(process.execPath, ['init', 'packed-shared', '--defaults', '--agent-guidance', 'skip']);
  invoke(process.execPath, ['install', `./${filename}`, '--project']);
  const nodeBin = join(scratch, 'node-only'); mkdirSync(nodeBin); symlinkSync(process.execPath, join(nodeBin, 'node'));
  const bun = spawnSync('bun', ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' }).stdout.trim(); assert.ok(bun);
  env.PATH = nodeBin;
  for (const runtime of [process.execPath, bun]) {
    const id = invoke(runtime, ['create', 'Task', 'Packed shared lane']).id as string;
    invoke(runtime, ['files', id, '--add', 'src/work.ts']);
    const selected = invoke(runtime, ['swarm', 'next', '--agent', 'packed-worker']);
    assert.equal(selected.selected, id); assert.equal(selected.mode, 'shared-tracker'); assert.equal('branch' in selected, false);
    const synced = invoke(runtime, ['swarm', 'sync', id, '--files', 'src/work.ts,test/work.test.ts', '--apply']);
    assert.deepEqual(synced.add, ['test/work.test.ts']);
    const status = invoke(runtime, ['swarm', 'status']); assert.equal((status.lanes as unknown[]).length, 1);
    invoke(runtime, ['update', id, '--status', 'closed', '--message', 'Packed work verified']);
    // A terminal item can retain a stale claim after import or explicit override.
    invoke(runtime, ['claim', id, '--force']);
    assert.deepEqual(invoke(runtime, ['swarm', 'reap', '--dry-run']).released, [id]);
    assert.deepEqual(invoke(runtime, ['swarm', 'reap']).released, [id]);
    assert.equal(invoke(runtime, ['health', '--strict-exit']).ok, true);
  }
  assert.equal(existsSync(join(repo, '.git')), false);
});
