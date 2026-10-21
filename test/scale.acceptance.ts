import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { certifyCompleteListResult } from '@unbrained/pm-cli/sdk/query';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { runProcess } from './process-helpers.ts';
import { gitEnvironment } from '../src/git-environment.ts';

/** Durable write receipt reported by a real CLI process agent. */
interface Completed { id: string; agent: string; marker: string; token: string }
/** Explicit worker state for deterministic kill and survivor barriers. */
interface Agent { child: ChildProcess; exit: Promise<unknown[]>; ready: Promise<{ id: string; agent: string }>; done: Promise<Completed[]> }

/** Spawn a command without blocking the driver's worker and heartbeat event loops. */
async function command(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = await runProcess(executable, args, cwd, env);
  assert.equal(result.code, 0, result.stdout + result.stderr); return JSON.parse(result.stdout) as Record<string, unknown>;
}

test('50 real CLI agents retain every fenced write and reclaim 13 SIGKILL owners without git', { timeout: 1800000 }, async t => {
  const start = performance.now(); const root = mkdtempSync(join(tmpdir(), 'swarm-scale-')); const repo = join(root, 'project'); mkdirSync(repo);
  const pmRoot = join(repo, '.agents/pm'); const host = join(process.cwd(), 'node_modules/.bin/pm');
  const env = gitEnvironment({ ...process.env, HOME: root, PM_GLOBAL_PATH: join(root, 'global'), PM_PATH: pmRoot, PM_SOURCE_WORKSPACE_ROOT: repo, PM_SOURCE_PM_PATH: pmRoot, PM_AUTHOR: 'scale-driver', GIT_CEILING_DIRECTORIES: dirname(repo), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  delete env.NODE_TEST_CONTEXT; delete env.NODE_V8_COVERAGE;
  let verified = false;
  writeFileSync(join(tmpdir(), 'swarm-scale-latest.txt'), root);
  t.after(() => { if (verified) rmSync(root, { recursive: true, force: true }); });
  const phases = new Map<string, string>();
  const progress = setInterval(() => { const counts: Record<string, number> = {}; for (const phase of phases.values()) counts[phase] = (counts[phase] ?? 0) + 1; process.stderr.write(`scale: phases ${JSON.stringify(counts)}\n`); }, 15000);
  t.after(() => clearInterval(progress));
  /** Execute the real pinned host against the one non-Git tracker. */
  const pm = (args: string[]) => command(process.execPath, [host, ...args, '--json'], repo, env);
  await pm(['init', 'scale-proof', '--defaults', '--agent-guidance', 'skip']);
  const packed = await command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], process.cwd(), env) as unknown as { filename: string }[];
  const filename = packed[0].filename; writeFileSync(join(repo, filename), readFileSync(join(root, filename)));
  await pm(['install', `./${filename}`, '--project']);
  const bin = join(root, 'bin'); mkdirSync(bin); symlinkSync(process.execPath, join(bin, 'node')); Object.assign(env, { PATH: bin });
  const old = { ...process.env }; Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]; Object.assign(process.env, old); });
  const client = new PmClient({ cwd: repo, pmRoot, author: 'scale-driver', noExtensions: false });
  const ids: string[] = [];
  for (let i = 0; i < 87; i++) ids.push((await client.create({ id: `scale-${String(i).padStart(3, '0')}`, type: 'Task', title: `Parallel work ${i}`, file: [`path=src/item-${i}.ts`] })).item.id);
  const setupMs = performance.now() - start; process.stderr.write(`scale: setup complete (${Math.round(setupMs)} ms), starting 50 agents\n`);
  /** Launch an actual process agent whose individual mutations are actual CLI invocations. */
  const agent = (index: number, iterations: number, barrier: boolean): Agent => {
    const child = fork(new URL('./scale-worker.ts', import.meta.url), [], { env, execArgv: [], detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, 'SIGKILL'); });
    const exit = once(child, 'exit');
    let readyResolve: (value: { id: string; agent: string }) => void;
    let doneResolve: (value: Completed[]) => void; let reject: (error: Error) => void;
    const ready = new Promise<{ id: string; agent: string }>(resolve => { readyResolve = resolve; });
    const done = new Promise<Completed[]>((resolve, fail) => { doneResolve = resolve; reject = fail; });
    // Attach a handler immediately: intentionally killed workers do not send completion.
    void done.catch(() => {});
    child.on('message', (message: { event: string; id: string; agent: string; completed: Completed[]; message: string; phase: string }) => {
      if (message.event === 'phase') phases.set(message.agent, message.phase);
      if (message.event === 'ready') readyResolve(message);
      if (message.event === 'done') { phases.set(`agent-${index}`, 'done'); doneResolve(message.completed); }
      if (message.event === 'failed') reject(new Error(message.message));
    });
    child.send({ repo, host, env, agent: `agent-${index}`, iterations, barrier });
    return { child, exit, ready: barrier ? Promise.race([ready, done.then(() => { throw new Error('agent completed before barrier'); })]) : ready, done };
  };
  const contentionStart = performance.now(); const workers = Array.from({ length: 50 }, (_, index) => agent(index, 2, true));
  const ready = await Promise.all(workers.map(row => row.ready));
  assert.equal(new Set(ready.map(row => row.id)).size, 50, 'zero double selections');
  const assigned = new Map(certifyCompleteListResult(await client.listAllComplete()).items.map(item => [item.id, item.assignee]));
  for (const row of ready) assert.equal(assigned.get(row.id), row.agent, 'no overwritten claim');
  const claimedMs = performance.now() - contentionStart; process.stderr.write(`scale: 50 distinct owners have heartbeaten (${Math.round(claimedMs)} ms)\n`);
  const killed = workers.slice(0, 13); const survivors = workers.slice(13);
  for (const row of killed) row.child.kill('SIGKILL');
  for (const row of killed) { const [code, signal] = await row.exit; assert.equal(code, null); assert.equal(signal, 'SIGKILL'); }
  for (const row of survivors) row.child.send('continue');
  const completed = (await Promise.all(survivors.map(row => row.done))).flat();
  await Promise.all(survivors.map(row => row.exit));
  const loopsMs = performance.now() - contentionStart; process.stderr.write(`scale: 37 survivors completed two loops (${Math.round(loopsMs)} ms)\n`);
  const recoveryStart = performance.now();
  const reclaim = await pm(['swarm', 'reclaim', '--stale-after', '0.001']) as { recovered: { id: string; previous_owner: string; token: string }[] };
  assert.equal(reclaim.recovered.length, 13);
  assert.deepEqual(reclaim.recovered.map(row => row.id).sort(), ready.slice(0, 13).map(row => row.id).sort());
  assert.ok(reclaim.recovered.every(row => row.token === '2'));
  const reclaimMs = performance.now() - recoveryStart;
  const rescuers = Array.from({ length: 13 }, (_, index) => agent(50 + index, 1, false));
  completed.push(...(await Promise.all(rescuers.map(row => row.done))).flat()); await Promise.all(rescuers.map(row => row.exit));
  assert.equal(completed.length, 87); assert.equal(new Set(completed.map(row => row.id)).size, 87);
  assert.deepEqual(completed.map(row => row.id).sort(), ids.sort(), 'every original task completes exactly once');
  const final = new Map(certifyCompleteListResult(await client.listAllComplete()).items.map(item => [item.id, item]));
  for (const row of completed) {
    const item = final.get(row.id)!;
    assert.equal(item.status, 'closed'); assert.equal(item.assignee, undefined);
    assert.equal(item.swarm_token, (BigInt(row.token) + 1n).toString(), 'finish advances the held fence');
    assert.ok(item.files?.some(file => file.path === row.marker), 'zero lost sync writes');
    assert.equal(item.close_reason, `Verified ${row.marker}`, 'zero lost close evidence');
  }
  let histories = 0;
  for (const file of readdirSync(join(pmRoot, 'history')).filter(file => file.endsWith('.jsonl'))) {
    histories++; for (const line of readFileSync(join(pmRoot, 'history', file), 'utf8').trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
  }
  assert.equal((await pm(['health', '--strict-exit'])).ok, true, 'managed extension and strict health');
  assert.equal(existsSync(join(repo, '.git')), false);
  verified = true;
  t.diagnostic(JSON.stringify({ agents: 50, killed: 13, distinct_initial_owners: 50, completed: completed.length, double_ownership: 0, lost_writes: 0, histories, strict_health: 'clean', setup_ms: Math.round(setupMs), initial_claims_heartbeats_ms: Math.round(claimedMs), survivor_loops_ms: Math.round(loopsMs), reclaim_ms: Math.round(reclaimMs), recovery_loops_ms: Math.round(performance.now() - recoveryStart), total_ms: Math.round(performance.now() - start) }));
});
