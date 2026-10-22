import { spawn } from 'node:child_process';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';

/** Retain process failures immediately when callers consume termination after output barriers. */
export function processExit(child: ChildProcess, event: 'close' | 'exit') {
  const exit = once(child, event);
  void exit.catch(() => {});
  return exit;
}

/** Settle lease-holder readiness on data, early close or spawn failure without deferred rejections. */
export function monitorLeaseHolder(child: ChildProcessWithoutNullStreams) {
  const exit = processExit(child, 'close');
  const controller = new AbortController();
  const ready = Promise.race([
    once(child.stdout, 'data', { signal: controller.signal }),
    exit.then(([code, signal]) => { throw new Error(`child exited before lease held: code ${String(code)}, signal ${String(signal)}`); }),
  ]).finally(() => controller.abort());
  void ready.catch(() => {});
  return { ready, exit };
}

/** Capture actual process output while keeping the caller's timers responsive. */
export async function runProcess(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 300000) {
  const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const [code, signal] = await once(child, 'close');
  return { code: code as number | null, signal: signal as string | null, stdout, stderr };
}
