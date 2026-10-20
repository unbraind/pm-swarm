import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

/** Require a working Bun executable before starting packed consumer setup. */
export function requireBun(): string {
  const probe = spawnSync('bun', ['-e', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' });
  const message = 'packed acceptance requires Bun on PATH';
  assert.equal(probe.error, undefined, message);
  assert.equal(probe.status, 0, message);
  const bun = probe.stdout.trim(); assert.ok(bun, message);
  return bun;
}
