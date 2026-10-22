import assert from 'node:assert/strict';
import { once } from 'node:events';
import { runProcess } from './process-helpers.ts';

/** Isolated CLI process-agent configuration, supplied over IPC only. */
interface Configuration { host: string; repo: string; env: NodeJS.ProcessEnv; agent: string; iterations: number; barrier: boolean }
/** Retained acknowledgement for every completed real CLI loop. */
interface Completed { id: string; agent: string; marker: string; token: string }

/** Run the actual host parser, extension loader and SDK in a separate process. */
async function cli(config: Configuration, args: string[]): Promise<Record<string, unknown>> {
  process.send!({ event: 'phase', phase: args[0], agent: config.agent, id: args[1] });
  const result = await runProcess(process.execPath, [config.host, 'swarm', ...args, '--agent', config.agent, '--json'], config.repo, config.env, 900000);
  assert.equal(result.code, 0, `CLI ${args.join(' ')}; signal ${result.signal}; ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/** Publish readiness at a point with retained ownership and no child process to orphan. */
async function run(config: Configuration): Promise<void> {
  const completed: Completed[] = [];
  for (let cycle = 0; cycle < config.iterations; cycle++) {
    const next = await cli(config, ['next']); const id = String(next.selected); const token = String(next.token);
    assert.notEqual(next.selected, null); assert.match(token, /^\d+$/);
    await cli(config, ['heartbeat']);
    if (cycle === 0 && config.barrier) {
      const resume = once(process, 'message'); process.send!({ event: 'ready', id, token, agent: config.agent }); await resume;
    }
    const marker = `evidence/${config.agent}-${cycle}.ts`;
    await cli(config, ['sync', id, '--token', token, '--files', marker, '--apply']);
    await cli(config, ['close', id, '--token', token, '--note', `Verified ${marker}`]);
    completed.push({ id, token, marker, agent: config.agent });
  }
  process.send!({ event: 'done', agent: config.agent, completed }); process.disconnect!();
}

process.once('message', (config: Configuration) => { run(config).catch((error: unknown) => { process.send!({ event: 'failed', message: String(error) }); process.exitCode = 1; process.disconnect!(); }); });
