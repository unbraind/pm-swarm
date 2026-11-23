/**
 * Deep-leg budget and receipt contracts (unbraind/pm-swarm#97).
 *
 * The deep coverage stage's wall-clock budget and worker maximum are explicit,
 * validated manifest values sized from measured deep-leg runtime, every gate
 * outcome that reaches its reconciliation decision emits a receipt with stage
 * timings, the actual termination reason, the worker count and the remaining
 * budget, and the deep workflow records queue wait separately from execution
 * plus the container's peak memory. A run that did not finish can never leave
 * a receipt that claims success.
 */

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseDocument } from "yaml";

import { runCoverageGate } from "../scripts/coverage-gate.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** Parse the deep workflow strictly, so a syntax error is a contract failure, not a silent gap. */
function parseDeepWorkflow(): { jobs: { deep: { steps: { name?: string; run?: string; if?: string }[]; "timeout-minutes"?: number } }; permissions: Record<string, string> } {
  const document = parseDocument(readFileSync(join(repositoryRoot, ".github/workflows/ci-deep.yml"), "utf8"), { uniqueKeys: true, strict: true });
  assert.deepEqual(document.errors, []);
  assert.deepEqual(document.warnings, []);
  return document.toJS() as ReturnType<typeof parseDeepWorkflow>;
}

/** Write a minimal gate fixture manifest with an explicit budget and worker maximum. */
function writeManifest(root: string, coverageGate: Record<string, unknown>): void {
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "deep-budget-fixture", type: "module", private: true, coverageGate })}\n`);
}

/** One explicit budget for a fixture: the deadline and the worker maximum. */
interface FixtureBudget {
  readonly deadlineMs: number;
  readonly testConcurrency: number;
}

/** Materialize the minimal single-entry gate fixture the termination cases share. */
function writeEntryFixture(root: string, budget: FixtureBudget): void {
  writeManifest(root, { sources: ["entry.ts"], tests: ["absent.test.ts"], thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 }, ...budget });
  writeFileSync(join(root, "entry.ts"), "export const value = 1;\n");
}

/** Materialize the covered recursive counter fixture the reconciliation cases share. */
function writeCounterFixture(root: string, budget: FixtureBudget): void {
  writeManifest(root, { sources: ["src"], tests: ["test/*.test.ts"], thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 }, ...budget });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/counter.ts"), "export function counter(start: number, steps: number): number {\n  if (steps === 0) return start;\n  return counter(start + 1, steps - 1);\n}\n");
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "test/counter.test.ts"), 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { counter } from "../src/counter.ts";\ntest("both arms", () => {\n  assert.equal(counter(7, 0), 7);\n  assert.equal(counter(7, 3), 10);\n});\n');
}

/** Shared stream recorder: every gate line lands in one buffer for later inspection. */
function recordingStreams(): { buffer: string[]; sink: (line: string) => void } {
  const buffer: string[] = [];
  return { buffer, sink: line => buffer.push(line) };
}

/** Find and parse the single receipt line a gate run emitted, if any. */
function parseReceiptLine(buffer: readonly string[]): Record<string, unknown> | undefined {
  const raw = buffer.find(line => line.startsWith("coverage-gate receipt: "));
  return raw === undefined ? undefined : JSON.parse(raw.slice("coverage-gate receipt: ".length)) as Record<string, unknown>;
}

/** Run the gate with recorded streams and report status, the joined lines and the parsed receipt. */
function capturedReceipt(root: string, runner?: { executable: string; script: string }): { status: number; seen: string; receipt: Record<string, unknown> | undefined } {
  const { buffer, sink } = recordingStreams();
  const status = runCoverageGate(root, { log: sink, error: sink, ...(runner === undefined ? {} : { runner }) });
  return { status, seen: buffer.join("\n"), receipt: parseReceiptLine(buffer) };
}

test("the deep workflow measures queue wait separately from execution and records peak memory", () => {
  const workflow = parseDeepWorkflow();
  assert.deepEqual(workflow.permissions, { contents: "read", actions: "read" });
  const steps = workflow.jobs.deep.steps;
  const queue = steps.find(step => step.name === "Record queue wait separately from execution");
  assert.ok(queue, "the deep workflow must record queue wait before any execution step");
  assert.match(queue.run!, /api\.github\.com\/repos\/unbraind\/pm-swarm\/actions\/runs\/\$GITHUB_RUN_ID/);
  assert.match(queue.run!, /jq -r \.created_at/);
  assert.doesNotMatch(queue.run!, /set -e/, "a measurement step must never fail the gate");
  assert.match(queue.run!, /GITHUB_STEP_SUMMARY/);
  assert.match(queue.run!, /EXECUTION_START_EPOCH=.*>> "\$GITHUB_ENV"/);
  assert.match(queue.run!, /queue wait/);
  const record = steps.find(step => step.name === "Record execution span, peak memory and the coverage gate receipt");
  assert.ok(record, "the deep workflow must close with an always() timing record");
  assert.equal(record.if, "always()");
  assert.match(record.run!, /EXECUTION_START_EPOCH/);
  assert.match(record.run!, /memory\.peak/);
  assert.match(record.run!, /gate-receipt\.json/);
  assert.ok(steps.indexOf(record!) > steps.findIndex(step => step.name === "Full npm release gate"), "the record must follow the gate");
});

test("the manifest budget is explicit, positive and leaves the deep job headroom", () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as { coverageGate: { deadlineMs: unknown; testConcurrency: unknown } };
  assert.equal(Number.isInteger(manifest.coverageGate.deadlineMs) && manifest.coverageGate.deadlineMs as number > 0, true, "coverageGate.deadlineMs must be a positive integer sized from measured deep-leg runtime");
  assert.equal(Number.isInteger(manifest.coverageGate.testConcurrency) && manifest.coverageGate.testConcurrency as number > 0, true, "coverageGate.testConcurrency must be a positive integer");
  const jobCapMs = (parseDeepWorkflow().jobs.deep["timeout-minutes"] ?? 0) * 60000;
  assert.ok(jobCapMs > 0, "the deep job must declare its timeout");
  assert.ok(
    (manifest.coverageGate.deadlineMs as number) <= jobCapMs - 1800000,
    "the c8 deadline must leave at least half an hour of the deep job for every non-coverage stage",
  );
});

test("a complete run writes a receipt with headroom, stage timings and its termination reason", () => {
  const root = mkdtempSync(join(tmpdir(), "deep-receipt-complete-"));
  try {
    writeCounterFixture(root, { deadlineMs: 1200000, testConcurrency: 2 });
    const outcome = capturedReceipt(root);
    assert.equal(outcome.status, 0, outcome.seen);
    assert.ok(outcome.receipt, "a complete run must emit a receipt");
    const stored = JSON.parse(readFileSync(join(root, "coverage", "gate-receipt.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(stored, outcome.receipt);
    assert.equal(stored.schema, 1);
    assert.equal(stored.complete, true);
    assert.equal(stored.exitCode, 0);
    assert.deepEqual(stored.termination, { kind: "exit", exitCode: 0, signal: null });
    const stages = stored.stageTimingsMs as Record<string, number>;
    assert.ok(stages.execute > 0, "the receipt must time the execution stage");
    assert.ok(stages.configure >= 0 && stages.reconcile >= 0);
    assert.ok((stored.headroomMs as number) > 0, "a complete receipt must show time headroom against its deadline");
    assert.equal(stored.deadlineMs, 1200000);
    assert.equal(stored.testConcurrency, Math.max(1, Math.min(2, availableParallelism())));
    assert.equal(stored.requiredFiles, 1);
    assert.deepEqual(stored.violations, []);
    assert.ok((stored.gatePeakRssKb as number) > 0, "the receipt must record the gate process peak");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deadline run records its real termination reason and leaves no artefact that could pass", { timeout: 30000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "deep-receipt-deadline-"));
  try {
    writeEntryFixture(root, { deadlineMs: 1, testConcurrency: 1 });
    mkdirSync(join(root, "coverage"));
    writeFileSync(join(root, "coverage", "coverage-summary.json"), '{"total":"stale success"}');
    const stall = join(root, "stall.mjs");
    writeFileSync(stall, "setInterval(() => {}, 1000);\n");
    const outcome = capturedReceipt(root, { executable: process.execPath, script: stall });
    assert.equal(outcome.status, 1);
    assert.match(outcome.seen, /the c8 coverage run exceeded its 1 ms deadline/);
    assert.ok(outcome.receipt, "a deadline run must still emit its receipt for diagnosis");
    assert.equal(outcome.receipt!.complete, false);
    assert.deepEqual(outcome.receipt!.termination, { kind: "deadline", exitCode: null, signal: null });
    assert.equal(outcome.receipt!.headroomMs, null);
    assert.ok((outcome.receipt!.stageTimingsMs as Record<string, number>).execute >= 1);
    assert.equal(existsSync(join(root, "coverage")), false, "no report directory, and no receipt file, may survive a refused run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the gate refuses a manifest without an explicit sized budget and worker maximum", () => {
  const thresholds = { statements: 100, branches: 100, functions: 100, lines: 100 };
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ sources: ["entry.ts"], tests: ["entry.test.ts"], thresholds, testConcurrency: 1 }, /deadlineMs is missing or not a positive integer/],
    [{ sources: ["entry.ts"], tests: ["entry.test.ts"], thresholds, deadlineMs: 0, testConcurrency: 1 }, /deadlineMs is missing or not a positive integer/],
    [{ sources: ["entry.ts"], tests: ["entry.test.ts"], thresholds, deadlineMs: -60000, testConcurrency: 1 }, /deadlineMs is missing or not a positive integer/],
    [{ sources: ["entry.ts"], tests: ["entry.test.ts"], thresholds, deadlineMs: 1.5, testConcurrency: 1 }, /deadlineMs is missing or not a positive integer/],
    [{ sources: ["entry.ts"], tests: ["entry.test.ts"], thresholds, deadlineMs: 1200000 }, /testConcurrency is missing or not a positive integer/],
    [{ sources: ["entry.ts"], tests: ["entry.test.ts"], thresholds, deadlineMs: 1200000, testConcurrency: 0 }, /testConcurrency is missing or not a positive integer/],
  ];
  const seen: string[] = [];
  for (const [coverageGate, pattern] of cases) {
    const root = mkdtempSync(join(tmpdir(), "deep-budget-invalid-"));
    try {
      writeManifest(root, coverageGate);
      const outcome = capturedReceipt(root);
      assert.equal(outcome.status, 1);
      assert.match(outcome.seen, pattern);
      assert.equal(outcome.receipt, undefined, "a gate that never launched its runner emits no receipt");
      seen.push(outcome.seen);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.equal(seen.length, cases.length);
});

test("the runner receives the configured deadline and worker maximum", { timeout: 30000 }, t => {
  const root = mkdtempSync(join(tmpdir(), "deep-budget-honored-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeEntryFixture(root, { deadlineMs: 1234567, testConcurrency: 1 });
  const lines: string[] = [];
  let observedTimeout: unknown;
  let observedArgv: readonly string[] = [];
  const original = childProcess.spawnSync;
  const hook = t.mock.method(childProcess, "spawnSync", new Proxy(original, { apply(target, receiver, args: unknown[]) {
    const options = args[2] as Record<string, unknown>;
    observedTimeout = options.timeout;
    observedArgv = args[1] as string[];
    // A real stalled child reports the OS timeout; scale only the wait so the regression stays fast.
    return Reflect.apply(target, receiver, [process.execPath, ["-e", "setInterval(() => {}, 1000)"], { ...options, timeout: 25 }]);
  } }));
  syncBuiltinESMExports();
  try {
    assert.equal(runCoverageGate(root, { runner: { executable: process.execPath, script: "unused.mjs" }, log: line => lines.push(line), error: line => lines.push(line) }), 1);
  } finally {
    hook.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(observedTimeout, 1234567, "the spawn deadline must come from the manifest budget");
  assert.ok(observedArgv.includes("--test-concurrency=1"), "the worker maximum must come from the manifest");
  assert.match(lines.join("\n"), /exceeded its 1234567 ms deadline/);
  assert.match(lines.join("\n"), /"deadlineMs":1234567/);
});

test("a signal-killed runner records the signal as its actual termination reason", { timeout: 30000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "deep-receipt-signal-"));
  try {
    writeEntryFixture(root, { deadlineMs: 1200000, testConcurrency: 1 });
    const killer = join(root, "killer.mjs");
    writeFileSync(killer, "process.kill(process.pid, 'SIGKILL');\n");
    const outcome = capturedReceipt(root, { executable: process.execPath, script: killer });
    assert.equal(outcome.status, 1);
    assert.ok(outcome.receipt);
    assert.equal(outcome.receipt!.complete, false);
    assert.deepEqual(outcome.receipt!.termination, { kind: "signal", exitCode: null, signal: "SIGKILL" });
    assert.equal(existsSync(join(root, "coverage")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("threshold violations reach the receipt as an incomplete run with no surviving report", () => {
  const root = mkdtempSync(join(tmpdir(), "deep-receipt-violations-"));
  try {
    writeCounterFixture(root, { deadlineMs: 1200000, testConcurrency: 2 });
    writeFileSync(join(root, "src/idle.ts"), "export function idle(value: number): number {\n  return value * 3;\n}\n");
    const outcome = capturedReceipt(root);
    assert.equal(outcome.status, 1);
    assert.ok(outcome.receipt);
    assert.equal(outcome.receipt!.complete, false, "a run with reconciliation violations is incomplete even though the suite exited zero");
    assert.equal(outcome.receipt!.exitCode, 1);
    assert.deepEqual(outcome.receipt!.termination, { kind: "exit", exitCode: 0, signal: null });
    assert.ok((outcome.receipt!.violations as unknown[]).length > 0);
    assert.match(outcome.seen, /% covered, 100% required/);
    assert.equal(existsSync(join(root, "coverage")), false, "the invalidated reports must not survive a refused run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a silent runner that exits zero without a report stays a refusal with no complete receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "deep-receipt-silent-"));
  try {
    writeEntryFixture(root, { deadlineMs: 1200000, testConcurrency: 1 });
    const quiet = join(root, "quiet.mjs");
    writeFileSync(quiet, "process.exit(0);\n");
    const outcome = capturedReceipt(root, { executable: process.execPath, script: quiet });
    assert.equal(outcome.status, 1);
    assert.match(outcome.seen, /wrote no coverage summary/);
    assert.doesNotMatch(outcome.seen, /"complete":true/, "an incomplete run must never become a success");
    assert.equal(existsSync(join(root, "coverage", "gate-receipt.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a runner that ends without a status or a signal still records an exit without a code", { timeout: 30000 }, t => {
  const vanishingRoot = mkdtempSync(join(tmpdir(), "deep-receipt-vanish-"));
  t.after(() => rmSync(vanishingRoot, { recursive: true, force: true }));
  writeEntryFixture(vanishingRoot, { deadlineMs: 1200000, testConcurrency: 1 });
  const results: unknown[] = [null, { status: 1, signal: "SIGTERM", error: undefined }];
  const original = childProcess.spawnSync;
  const hook = t.mock.method(childProcess, "spawnSync", new Proxy(original, { apply(target, receiver, args: unknown[]) {
    const result = results.shift();
    if (result === null) return { status: null, signal: null, error: undefined, output: [] } as object;
    return result;
  } }));
  syncBuiltinESMExports();
  const vanished = capturedReceipt(vanishingRoot, { executable: process.execPath, script: "unused.mjs" });
  assert.equal(vanished.status, 1, "a vanished runner with no delivered status must fail the gate");
  assert.ok(vanished.receipt);
  assert.deepEqual(vanished.receipt!.termination, { kind: "exit", exitCode: null, signal: null }, "the receipt must record the missing exit code instead of inventing one");
  const signalledRoot = mkdtempSync(join(tmpdir(), "deep-receipt-signalled-"));
  t.after(() => rmSync(signalledRoot, { recursive: true, force: true }));
  writeEntryFixture(signalledRoot, { deadlineMs: 1200000, testConcurrency: 1 });
  const signalled = capturedReceipt(signalledRoot, { executable: process.execPath, script: "unused.mjs" });
  assert.equal(signalled.status, 1);
  assert.deepEqual(signalled.receipt!.termination, { kind: "signal", exitCode: null, signal: "SIGTERM" }, "a runner with both a signal and a status records the signal as its reason and the delivered status");
  hook.mock.restore();
  syncBuiltinESMExports();
});
