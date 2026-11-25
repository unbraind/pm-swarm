import { AsyncLocalStorage } from 'node:async_hooks';

/** The invoking host's relative tracker selector, scoped to one command. */
const tracker = new AsyncLocalStorage<string | undefined>();

/** Keep operator recovery on the same tracker without copying an absolute path. */
export function withCapacityTracker<T>(selector: string | undefined, operation: () => T): T {
  return tracker.run(selector, operation);
}

/** Safely quote a value for the POSIX retry command. */
function shellArg(value: string): string {
  return /^[a-zA-Z0-9_,.-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Render the same scoped command in structured refusals and their plain text. */
export function capacityCommand(...args: string[]): string {
  const selector = tracker.getStore();
  return ['pm swarm', ...args.map(shellArg), ...(selector === undefined ? [] : ['--path', shellArg(selector)])].join(' ');
}
