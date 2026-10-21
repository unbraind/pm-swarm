import { spawn } from 'node:child_process';
import { once } from 'node:events';

/** Capture actual process output while keeping the caller's timers responsive. */
export async function runProcess(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 300000) {
  const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const [code, signal] = await once(child, 'close');
  return { code: code as number | null, signal: signal as string | null, stdout, stderr };
}
