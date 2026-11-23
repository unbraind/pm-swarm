#!/usr/bin/env node
/**
 * Coverage gate for the package test suite.
 *
 * Runs the published `c8` reporter over `node --test`, with the TypeScript
 * sources measured directly: Node executes `.ts` natively, so the reported
 * line numbers are the ones an author edits, and `--all` adds every authored
 * file matched by the include patterns even when no test loads it, so an
 * untested module appears at zero instead of vanishing from the percentages.
 *
 * The gate exists for four things a bare `c8 --check-coverage` cannot do:
 *
 * - the thresholds it enforces (statements, branches, functions and lines) are
 *   read from the `coverageGate` block of `package.json`, so a threshold change
 *   shows up in review as a deliberate diff next to the scripts it governs;
 *   the same block carries the wall-clock budget (`deadlineMs`) and the worker
 *   maximum (`testConcurrency`) — both required, both sized from measured
 *   deep-leg runtime on the runner classes that execute this gate, never
 *   hidden constants;
 * - the report is invalidated before the run and again on every failure, so a
 *   leftover report from an earlier, broader run can never satisfy a check;
 * - the reported file list is reconciled against a fresh walk of the configured
 *   source locations, so a file the glob machinery fails to match cannot
 *   escape the measurement — it is named as a violation instead;
 * - every outcome emits a receipt with the stage timings, the actual
 *   termination reason, the worker count and the budget headroom, so an
 *   incomplete run is diagnosable from evidence and never becomes a success.
 *
 * There is deliberately no ignore list. An executable module must be exercised
 * by the suite; a module that erases to nothing reports vacuous full coverage
 * once any test loads it, so the remedy for a type-only finding is an import,
 * never an exemption.
 *
 * @example
 * ```bash
 * node scripts/coverage-gate.ts [repository-root]
 * ```
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";

import { isMainInvocation } from "./main-invocation.ts";

/** Coverage dimensions enforced independently, matching the c8 summary keys. */
const DIMENSIONS = ["statements", "branches", "functions", "lines"] as const;

/** One dimension name from the enforced set. */
type CoverageDimension = (typeof DIMENSIONS)[number];

/** Validated per-dimension thresholds read from the manifest block. */
type ThresholdTable = Record<CoverageDimension, number>;

/**
 * Directory names never treated as authored source while walking a configured
 * location, so a `sources: ["."]` style entry cannot pull in tests, build
 * output or installed dependencies.
 */
const SKIPPED_DIRECTORY_NAMES = [
  "node_modules",
  "dist",
  "dist-test",
  "coverage",
  "test",
  "tests",
  ".agents",
  ".git",
  ".github",
];

/** Glob patterns kept out of the c8 report, aligned with the skipped names. */
const C8_EXCLUDES = [
  "test/**",
  "tests/**",
  "dist/**",
  "dist-test/**",
  "node_modules/**",
  "coverage/**",
  ".agents/**",
  ".github/**",
  "**/*.d.ts",
];

/** The `coverageGate` block read from `package.json`. */
interface CoverageGateConfig {
  /**
   * Source locations the gate requires to appear in the report. Each entry is
   * a directory, walked recursively for `.ts` files, or one source file; a
   * directory is enumerated at run time so a file added later joins the
   * required set automatically instead of freezing at configuration time.
   */
  readonly sources: readonly string[];
  /** Additional directory names skipped while walking, beyond the defaults. */
  readonly skipDirs?: readonly string[];
  /** Test file arguments handed to `node --test`. */
  readonly tests: readonly string[];
  /** Threshold enforced per dimension; every entry must be a number. */
  readonly thresholds?: Partial<ThresholdTable>;
  /**
   * Wall-clock budget in milliseconds for the whole c8 execution. Required and
   * validated as a positive integer: the deadline is a deliberate, reviewed
   * number sized from measured deep-leg runtime on the runner classes that
   * execute this gate, never a hidden constant, so an unsized manifest fails
   * closed instead of inheriting a budget nobody configured.
   */
  readonly deadlineMs?: number;
  /**
   * Maximum number of `node --test` workers c8 may start. Required and
   * validated as a positive integer; the run caps it by the parallelism the
   * runner actually exposes (container CPU quota included), so a manifest
   * sized for a wider host still yields at most one worker per available
   * CPU on a smaller one.
   */
  readonly testConcurrency?: number;
}

/** The `package.json` fields this gate reads. */
interface PackageManifest {
  readonly coverageGate?: CoverageGateConfig;
}

/** One dimension block from c8's `coverage-summary.json`. */
interface MetricSummary {
  /** Covered percentage for the dimension, already rounded by the reporter. */
  readonly pct: number;
}

/** c8's summary: one metric block per dimension for `total` and for each file. */
type CoverageSummary = {
  readonly [entry: string]: { readonly [dimension: string]: MetricSummary };
};

/** Injectable runner and stream boundaries, so the suite measures this gate with itself. */
export interface CoverageGateOptions {
  /**
   * Runner override: the executable and the launcher script it is handed.
   * Tests substitute a failing or report-less runner to reach the refusal
   * paths without sabotaging a real report.
   */
  readonly runner?: { readonly executable: string; readonly script: string };
  /** Success logger used by the CLI and the suite. */
  readonly log?: (message: string) => void;
  /** Failure logger used by the CLI and the suite. */
  readonly error?: (message: string) => void;
}

/** The walked source inventory and the c8 include patterns covering it. */
interface SourceInventory {
  /** Repository-relative POSIX paths the report must contain. */
  readonly required: readonly string[];
  /** One `--include` pattern per configured location, plus the package entry. */
  readonly include: readonly string[];
}

/**
 * Gate failure carrying a diagnostic for the error stream. Thrown rather than
 * calling `process.exit` so the suite can drive every refusal without ending
 * the test process.
 */
class CoverageGateFailure extends Error {}

/** How the c8 child ended, exactly as the gate receipt records it. */
interface TerminationRecord {
  /** `exit` for a delivered exit code, `signal`, `deadline` or `start-failure`. */
  readonly kind: "exit" | "signal" | "deadline" | "start-failure";
  /** Child exit code when it delivered one, otherwise `null`. */
  readonly exitCode: number | null;
  /** Terminating signal name when the runner died to one, otherwise `null`. */
  readonly signal: string | null;
}

/** Everything the gate observed about one c8 execution. */
interface C8RunRecord {
  /** How the runner ended: the actual termination reason, not a guess. */
  readonly termination: TerminationRecord;
  /** Runner exit status to propagate; non-zero when it never delivered one. */
  readonly status: number;
  /** Wall-clock milliseconds the c8 execution stage consumed. */
  readonly executionMs: number;
  /** Worker count actually handed to `node --test` after the parallelism cap. */
  readonly testConcurrency: number;
  /** Start-failure diagnostic when the runner could not be launched. */
  readonly startFailure: string | null;
}

/** One measured gate run, emitted for every outcome so budget sizing and diagnosis never rely on guesses. */
interface GateReceipt {
  /** Receipt schema version, so consumers can reject a shape they do not know. */
  readonly schema: 1;
  /** True only for a fully measured run that met every threshold. */
  readonly complete: boolean;
  /** Exit code the gate returns for this run. */
  readonly exitCode: number;
  /** The c8 child's actual termination reason. */
  readonly termination: TerminationRecord;
  /** Milliseconds per gate stage: configuration walk, c8 execution, reconciliation. */
  readonly stageTimingsMs: { readonly configure: number; readonly execute: number; readonly reconcile: number };
  /** The configured wall-clock budget that governed the execution stage. */
  readonly deadlineMs: number;
  /** Worker count actually used, after the runner-parallelism cap. */
  readonly testConcurrency: number;
  /** Budget left when the run ended before its deadline; `null` when it did not. */
  readonly headroomMs: number | null;
  /** Peak resident set of this gate process in kilobytes as the platform reports it. */
  readonly gatePeakRssKb: number;
  /** Number of required source files the report was reconciled against. */
  readonly requiredFiles: number;
  /** Reconciliation violations, empty for a complete run. */
  readonly violations: readonly string[];
}

/**
 * Read and validate the `coverageGate` block of one repository root.
 *
 * A missing block, a missing or non-numeric threshold, or an empty test list
 * each fail closed with a remediation message, because a gate that guesses at
 * its configuration reports numbers nobody configured.
 */
function loadConfiguration(root: string): { config: CoverageGateConfig; thresholds: ThresholdTable; deadlineMs: number; testConcurrency: number } {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageManifest;
  const config = manifest.coverageGate;
  if (config === undefined) throw new CoverageGateFailure("package.json has no `coverageGate` block.");
  const thresholds: ThresholdTable = { statements: 0, branches: 0, functions: 0, lines: 0 };
  for (const dimension of DIMENSIONS) {
    const value = config.thresholds?.[dimension];
    if (typeof value !== "number") {
      throw new CoverageGateFailure(`coverageGate.thresholds.${dimension} is missing or not a number.`);
    }
    thresholds[dimension] = value;
  }
  if (!Array.isArray(config.tests) || config.tests.length === 0) {
    throw new CoverageGateFailure("coverageGate.tests must list at least one test entry.");
  }
  if (typeof config.deadlineMs !== "number" || !Number.isInteger(config.deadlineMs) || config.deadlineMs <= 0) {
    throw new CoverageGateFailure("coverageGate.deadlineMs is missing or not a positive integer.");
  }
  if (typeof config.testConcurrency !== "number" || !Number.isInteger(config.testConcurrency) || config.testConcurrency <= 0) {
    throw new CoverageGateFailure("coverageGate.testConcurrency is missing or not a positive integer.");
  }
  return { config, thresholds, deadlineMs: config.deadlineMs, testConcurrency: config.testConcurrency };
}

/**
 * Recursively collect the authored TypeScript files below one directory,
 * pruning skipped directory names and declaration files.
 */
function walkDirectory(root: string, directory: string, skipped: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name)) found.push(...walkDirectory(root, join(directory, entry.name), skipped));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      found.push(relative(root, join(directory, entry.name)).split(sep).join("/"));
    }
  }
  return found;
}

/**
 * Walk the configured source locations and add the package entry point.
 *
 * The entry file at the repository root is authored TypeScript outside the
 * configured directories, so the gate requires it whenever it exists instead
 * of trusting the configuration to remember it. Both the required file list
 * and the include patterns come from this one walk, so the two cannot drift
 * apart between the presence check and the threshold check.
 */
function inventorySources(root: string, config: CoverageGateConfig, skipped: ReadonlySet<string>): SourceInventory {
  const required: string[] = [];
  const include: string[] = [];
  for (const source of config.sources) {
    const target = resolve(root, source);
    const name = relative(root, target).split(sep).join("/") || ".";
    if (!existsSync(target)) {
      throw new CoverageGateFailure(`coverageGate.sources names ${name}, which does not exist.`);
    }
    if (statSync(target).isDirectory()) {
      include.push(name === "." ? "**/*.ts" : `${name}/**/*.ts`);
      required.push(...walkDirectory(root, target, skipped));
    } else {
      if (!target.endsWith(".ts") || target.endsWith(".d.ts")) {
        throw new CoverageGateFailure(
          `coverageGate.sources names ${name}, which is not a TypeScript source file.`,
        );
      }
      include.push(name);
      required.push(name);
    }
  }
  const entry = relative(root, join(root, "index.ts"));
  if (existsSync(join(root, entry)) && !required.includes(entry)) {
    required.push(entry);
    include.push(entry);
  }
  if (required.length === 0) {
    throw new CoverageGateFailure("source walk found no files; check `coverageGate.sources`.");
  }
  return { required, include };
}

/**
 * Resolve the c8 launcher from this package's own dependencies.
 *
 * Resolution, not a hardcoded path, keeps the gate working from any working
 * directory, and a genuinely missing reporter propagates the resolver's error
 * to the caller's failure handling instead of being papered over here.
 */
function resolveC8Launcher(): string {
  return createRequire(import.meta.url).resolve("c8/bin/c8.js");
}

/**
 * Run c8 over the configured tests and report how the runner ended.
 * Incremental merging releases each raw process report before loading the next,
 * avoiding the all-reports heap exhaustion seen after a passing Node 26 suite.
 *
 * The wall-clock budget comes from the manifest's `deadlineMs`: sized from
 * measured deep-leg runtime rather than a hidden constant, and enforced by
 * `spawnSync`'s timeout, which kills the child and reports `ETIMEDOUT` so the
 * actual termination reason reaches the receipt. The worker count is the
 * manifest's `testConcurrency` capped by the parallelism this runner exposes
 * (container CPU quotas included), so one manifest value sizes every eligible
 * runner class without oversubscribing a smaller host.
 *
 * `NODE_V8_COVERAGE` and `NODE_TEST_CONTEXT` are removed from the child
 * environment: this gate itself runs inside an outer coverage run during the
 * suite, and the inherited raw-coverage directory would make the inner
 * reporter read the outer run's dumps, while the inherited test-runner context
 * makes the inner `node --test` believe it is a recursive invocation and skip
 * every test file.
 */
function runC8(
  root: string,
  config: CoverageGateConfig,
  inventory: SourceInventory,
  options: CoverageGateOptions,
  timeout: number,
  testConcurrencyLimit: number,
): C8RunRecord {
  const runner = options.runner ?? { executable: process.execPath, script: resolveC8Launcher() };
  const env = { ...process.env, TZ: "UTC" } as NodeJS.ProcessEnv;
  delete env.NODE_V8_COVERAGE;
  delete env.NODE_TEST_CONTEXT;
  const excludes = [...C8_EXCLUDES, ...(config.skipDirs ?? []).map(name => `**/${name}/**`)];
  const testConcurrency = Math.max(1, Math.min(testConcurrencyLimit, availableParallelism()));
  const executeStartedAt = Date.now();
  const result = spawnSync(
    runner.executable,
    [
      runner.script,
      "--all",
      "--merge-async",
      "--temp-directory",
      join(root, "coverage", "tmp"),
      ...inventory.include.flatMap(pattern => ["--include", pattern]),
      ...excludes.flatMap(pattern => ["--exclude", pattern]),
      "--reporter=json-summary",
      "--reporter=json",
      "--reporter=lcov",
      "--reporter=text",
      "--reports-directory",
      join(root, "coverage"),
      process.execPath,
      "--test",
      `--test-concurrency=${testConcurrency}`,
      ...config.tests,
    ],
    { timeout, cwd: root, env, stdio: "inherit" },
  );
  const executionMs = Date.now() - executeStartedAt;
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") {
      return {
        termination: { kind: "deadline", exitCode: null, signal: null },
        status: 1,
        executionMs,
        testConcurrency,
        startFailure: null,
      };
    }
    return {
      termination: { kind: "start-failure", exitCode: null, signal: null },
      status: 1,
      executionMs,
      testConcurrency,
      startFailure: result.error.message,
    };
  }
  if (result.signal !== null) {
    return {
      termination: { kind: "signal", exitCode: null, signal: result.signal },
      status: result.status ?? 1,
      executionMs,
      testConcurrency,
      startFailure: null,
    };
  }
  return {
    termination: { kind: "exit", exitCode: result.status, signal: null },
    status: result.status ?? 1,
    executionMs,
    testConcurrency,
    startFailure: null,
  };
}

/**
 * Reconcile the written summary against the walked inventory and thresholds.
 *
 * Every required file must appear as its own entry — c8's aggregate total is
 * computed only over the files the report contains, so a file the reporter
 * never emitted would otherwise be measurable by nobody — and each dimension
 * must meet its configured percentage on that same report.
 */
function reconcile(root: string, required: readonly string[], thresholds: ThresholdTable): string[] {
  const summaryPath = join(root, "coverage", "coverage-summary.json");
  if (!existsSync(summaryPath)) {
    throw new CoverageGateFailure("c8 exited successfully but wrote no coverage summary; inspect the runner output above.");
  }
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as CoverageSummary;
  const reported = new Set(Object.keys(summary).map(key => relative(root, resolve(root, key)).split(sep).join("/")));
  const totals = summary["total"] as { readonly [dimension in CoverageDimension]: MetricSummary };
  return [
    ...required
      .filter(file => !reported.has(file))
      .map(file => `${file}: never loaded by the suite and absent from the report; import it from a test.`),
    ...DIMENSIONS.filter(dimension => totals[dimension].pct < thresholds[dimension])
      .map(dimension => `${dimension}: ${totals[dimension].pct}% covered, ${thresholds[dimension]}% required.`),
  ];
}

/**
 * Build the receipt for one measured run.
 *
 * Headroom is the budget the execution stage did not consume, `null` exactly
 * when the deadline ended the run; an incomplete run never reports headroom.
 */
function buildReceipt(
  parameters: {
    readonly deadlineMs: number;
    readonly requiredFiles: number;
    readonly configureMs: number;
  },
  run: C8RunRecord,
  outcome: { readonly exitCode: number; readonly reconcileMs: number; readonly violations: readonly string[] },
): GateReceipt {
  return {
    schema: 1,
    complete: outcome.exitCode === 0 && outcome.violations.length === 0 && run.termination.kind === "exit" && run.termination.exitCode === 0,
    exitCode: outcome.exitCode,
    termination: run.termination,
    stageTimingsMs: { configure: parameters.configureMs, execute: run.executionMs, reconcile: outcome.reconcileMs },
    deadlineMs: parameters.deadlineMs,
    testConcurrency: run.testConcurrency,
    headroomMs: run.termination.kind === "deadline" ? null : Math.max(0, parameters.deadlineMs - run.executionMs),
    gatePeakRssKb: process.resourceUsage().maxRSS,
    requiredFiles: parameters.requiredFiles,
    violations: outcome.violations,
  };
}

/**
 * Emit one run's receipt: a machine-readable line on the appropriate stream
 * for every outcome, plus the durable `coverage/gate-receipt.json` file for a
 * fully measured, threshold-meeting run.
 *
 * The line is the diagnosis channel for refused runs (deadline, start
 * failure, suite failure, violations): the report directory is invalidated on
 * every failure, so nothing a failed run leaves behind can satisfy a check,
 * while the receipt still records the actual termination reason and stage
 * timings. The file is written only next to the complete reports of a clean
 * run, so its existence is itself evidence of a finished gate.
 */
function emitReceipt(
  root: string,
  receipt: GateReceipt,
  log: (message: string) => void,
  failure: (message: string) => void,
): void {
  const line = `coverage-gate receipt: ${JSON.stringify(receipt)}`;
  if (receipt.complete) {
    log(line);
    writeFileSync(join(root, "coverage", "gate-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  } else {
    failure(line);
  }
}

/**
 * Run the whole gate against one repository root and return the exit code.
 *
 * Reports are invalidated before the run and again on every failure, so a red
 * run leaves no green-looking artefact behind; a clean run leaves the json,
 * json-summary, lcov and gate-receipt reports in place for consumers. Every
 * outcome after the execution stage emits a receipt with stage timings, the
 * actual termination reason and the remaining budget, so sizing the deadline
 * from measured runs never depends on re-deriving what the runner did.
 *
 * @param root - Repository root whose `package.json` configures the gate.
 * @param options - Optional runner and stream boundaries for the suite.
 * @returns The process exit code: zero only on a fully measured, fully covered run.
 */
export function runCoverageGate(root: string, options: CoverageGateOptions = {}): number {
  const log = options.log ?? console.log;
  const failure = options.error ?? console.error;
  const reports = join(root, "coverage");
  try {
    const configureStartedAt = Date.now();
    const { config, thresholds, deadlineMs, testConcurrency } = loadConfiguration(root);
    const skipped = new Set(SKIPPED_DIRECTORY_NAMES);
    for (const name of config.skipDirs ?? []) skipped.add(name);
    const inventory = inventorySources(root, config, skipped);
    rmSync(reports, { recursive: true, force: true });
    const configureMs = Date.now() - configureStartedAt;
    const run = runC8(root, config, inventory, options, deadlineMs, testConcurrency);
    const parameters = { deadlineMs, requiredFiles: inventory.required.length, configureMs };
    const launchFailure = run.termination.kind === "deadline"
      ? `the c8 coverage run exceeded its ${deadlineMs} ms deadline; inspect the runner output above.`
      : run.termination.kind === "start-failure"
        ? `failed to start the c8 reporter: ${run.startFailure}`
        : null;
    if (launchFailure !== null) {
      rmSync(reports, { recursive: true, force: true });
      emitReceipt(root, buildReceipt(parameters, run, { exitCode: 1, reconcileMs: 0, violations: [] }), log, failure);
      failure(`coverage-gate: ${launchFailure}`);
      return 1;
    }
    if (run.status !== 0) {
      rmSync(reports, { recursive: true, force: true });
      emitReceipt(root, buildReceipt(parameters, run, { exitCode: run.status, reconcileMs: 0, violations: [] }), log, failure);
      return run.status;
    }
    const reconcileStartedAt = Date.now();
    const violations = reconcile(root, inventory.required, thresholds);
    const reconcileMs = Date.now() - reconcileStartedAt;
    const exitCode = violations.length > 0 ? 1 : 0;
    const receipt = buildReceipt(parameters, run, { exitCode, reconcileMs, violations });
    if (violations.length > 0) {
      rmSync(reports, { recursive: true, force: true });
      emitReceipt(root, receipt, log, failure);
      failure(`coverage-gate: ${violations.length} violation(s) after the run:\n${violations.join("\n")}`);
      return 1;
    }
    emitReceipt(root, receipt, log, failure);
    log(`coverage-gate: ${inventory.required.length} source file(s) reported; every threshold met.`);
    return 0;
  } catch (gateFailure) {
    rmSync(reports, { recursive: true, force: true });
    failure(`coverage-gate: ${gateFailure}`);
    return 1;
  }
}

if (isMainInvocation(process.argv, import.meta.url)) {
  process.exitCode = runCoverageGate(process.argv[2] ?? process.cwd());
}
