import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import { gitEnvironment } from '../src/git-environment.ts';

/** Require a working Bun executable before starting packed consumer setup. */
export function requireBun(): string {
  const probe = spawnSync('bun', ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8', timeout: 300000 });
  const message = 'packed acceptance requires Bun on PATH';
  assert.equal(probe.error, undefined, message);
  assert.equal(probe.status, 0, message);
  const bun = probe.stdout.trim(); assert.ok(bun, message);
  return bun;
}

/** Resolve the supported host install spec from the declared peer dependency floor, so tests cannot drift from it. */
export function supportedHostSpec(): string {
  const range = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { peerDependencies: Record<string, string> }).peerDependencies['@unbrained/pm-cli'];
  const floor = range.startsWith('>=') ? range.slice(2) : range;
  assert.ok(/^\d+\.\d+\.\d+/.test(floor), `unsupported @unbrained/pm-cli peer dependency range: ${range}`);
  return `@unbrained/pm-cli@${floor}`;
}

/** Install one captured tarball with the supported host floor into an isolated non-Git consumer. */
export async function packedNonGitConsumer(t: TestContext, manager: "npm" | "bun") {
  const bun = requireBun();
  const packageRoot = process.cwd(); const scratch = mkdtempSync(join(tmpdir(), 'swarm-shared-install-'));
  t.after(() => rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const repo = join(scratch, 'project \u03a9 space'); mkdirSync(repo);
  const pmRoot = join(repo, '.agents/pm');
  const host = join(repo, 'node_modules/.bin/pm');
  const env = gitEnvironment({ ...process.env, HOME: scratch, GIT_CEILING_DIRECTORIES: scratch, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PM_PATH: pmRoot, PM_SOURCE_WORKSPACE_ROOT: repo, PM_SOURCE_PM_PATH: pmRoot, PM_GLOBAL_PATH: join(scratch, 'global-pm'), PM_AUTHOR: 'packed-worker', NPM_CONFIG_USERCONFIG: '/dev/null', npm_config_userconfig: '/dev/null' });
  for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY/.test(key) || key === 'NPM_MEDIA_SERVER') delete env[key];
  /** Run the real pinned host and reject extension activation or command failures. */
  const invoke = (runtime: string, args: string[]) => {
    const result = spawnSync(runtime, [host, '--path', pmRoot, ...args, '--json'], { cwd: repo, env, encoding: 'utf8', timeout: 300000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /Extension activation failures/);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: packageRoot, env, encoding: 'utf8', timeout: 300000 });
  assert.equal(packed.status, 0, packed.stderr);
  const filename = (JSON.parse(packed.stdout) as { filename: string }[])[0].filename;
  const tarball = join(repo, filename); writeFileSync(tarball, readFileSync(join(scratch, filename)));
  writeFileSync(join(repo, 'package.json'), '{"name":"swarm-plain-consumer","private":true,"type":"module"}\n');
  const installed = spawnSync(manager, [manager === 'npm' ? 'install' : 'add', '--ignore-scripts', supportedHostSpec(), tarball], { cwd: repo, env, encoding: 'utf8', timeout: 600000 });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  invoke(process.execPath, ['init', 'packed-shared', '--defaults', '--agent-guidance', 'skip']);
  invoke(process.execPath, ['install', `./${filename}`, '--project']);
  const nodeBin = join(scratch, 'node-only'); mkdirSync(nodeBin); symlinkSync(process.execPath, join(nodeBin, 'node'));
  env.PATH = nodeBin;
  return { bun, packageRoot, scratch, repo, pmRoot, host, env, invoke };
}
