import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Durable write receipt reported by a real CLI process agent. */
export interface Completed { id: string; agent: string; marker: string; token: string }
/** IPC payload emitted by a process agent. */
interface Message { event: string; id: string; agent: string; completed: Completed[]; message: string; phase: string }

/** Settle worker barriers on errors and exits, allowing only an explicitly requested ready-state kill. */
export function monitorScaleWorker(child: ChildProcess, onPhase: (agent: string, phase: string) => void) {
  let isReady = false; let completed = false; let expectedKill = false;
  let readyResolve: (value: { id: string; agent: string }) => void; let readyReject: (error: Error) => void;
  let doneResolve: (value: Completed[]) => void; let doneReject: (error: Error) => void;
  const ready = new Promise<{ id: string; agent: string }>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const done = new Promise<Completed[]>((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
  /** Fail both barriers immediately, including failures before readiness. */
  const fail = (error: Error) => { readyReject(error); doneReject(error); };
  child.on('error', fail);
  child.on('message', (message: Message) => {
    if (message.event === 'phase') onPhase(message.agent, message.phase);
    if (message.event === 'ready') { isReady = true; readyResolve(message); }
    if (message.event === 'done') {
      completed = true; onPhase(message.agent, 'done');
      if (!isReady) readyReject(new Error('agent completed before barrier'));
      doneResolve(message.completed);
    }
    if (message.event === 'failed') fail(new Error(message.message));
  });
  const exit = once(child, 'exit').then(result => {
    const [code, signal] = result;
    if (expectedKill && signal === 'SIGKILL') { doneResolve([]); return result; }
    if (!completed || code !== 0 || signal !== null) {
      const error = new Error(`agent exited unexpectedly: code ${String(code)}, signal ${String(signal)}`);
      fail(error); throw error;
    }
    return result;
  });
  // Barriers are consumed at different phases; retain early rejections without unhandled promises.
  for (const promise of [ready, done, exit]) void promise.catch(() => {});
  /** Mark the intentional kill before signalling, and require a completed readiness barrier. */
  const killAfterReady = () => {
    assert.ok(isReady, 'agent must be ready before intentional SIGKILL'); expectedKill = true;
    if (!child.kill('SIGKILL')) { expectedKill = false; throw new Error('could not SIGKILL ready agent'); }
  };
  return { child, exit, ready, done, killAfterReady };
}

/** Validate every retained JSONL history and require the complete task-plus-project count. */
export function verifyScaleHistories(pmRoot: string, expected: number): number {
  const histories = readdirSync(join(pmRoot, 'history')).filter(file => file.endsWith('.jsonl'));
  for (const file of histories) for (const line of readFileSync(join(pmRoot, 'history', file), 'utf8').trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
  assert.equal(histories.length, expected, 'every task and the project must retain a history');
  return histories.length;
}
