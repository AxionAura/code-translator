// Benchmark harness (M11; docs/benchmarks.md). Deterministic correctness cases
// first, timings second: a failed case is never hidden by a fast number, and no
// result claims a performance improvement. Expensive suites (mini-projects, perf)
// are explicit/nightly; micro runs in the normal verification path.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CTransError, runPipeline } from "@axion-ct/core";
import { createPyToJsTranslator, JsToTsTranslator } from "@axion-ct/codegen-js";
import { createOxcJsParser, createOxcSyntaxValidator } from "@axion-ct/parser-js";
import { createPythonBridgeParser } from "@axion-ct/parser-py";
import { detectCapabilities } from "@axion-ct/sandbox";
import type { StageResult } from "@axion-ct/core";

import { runProject } from "./project-run.js";
import { runnerToolchain } from "./toolchain.js";

export type BenchmarkSuiteName = "micro" | "corpus" | "mini-projects" | "perf";
export type BenchmarkStatus = "ok" | "failed" | "skipped";

export interface BenchmarkCase {
  readonly name: string;
  readonly status: BenchmarkStatus;
  readonly iterations: number;
  readonly correctness: boolean;
  readonly wallMs: { readonly median: number; readonly p95: number; readonly total: number };
  readonly metrics: Readonly<Record<string, number | string>>;
  readonly details: readonly string[];
}

export interface BenchmarkSuiteResult {
  readonly name: BenchmarkSuiteName;
  readonly status: BenchmarkStatus;
  readonly cases: readonly BenchmarkCase[];
}

export interface BenchmarkResult {
  readonly version: 1;
  readonly generatedAt: string;
  readonly nodeVersion: string;
  readonly deterministic: true;
  readonly suites: readonly BenchmarkSuiteResult[];
}

export class BenchmarkResultError extends CTransError {
  constructor(message: string) {
    super("BENCHMARK-RESULT-INVALID", message);
  }
}

const SUITE_NAMES: readonly BenchmarkSuiteName[] = ["micro", "corpus", "mini-projects", "perf"];

export function isBenchmarkSuiteName(value: string): value is BenchmarkSuiteName {
  return (SUITE_NAMES as readonly string[]).includes(value);
}

export interface BenchmarkOptions {
  readonly iterations?: number;
  // Bounds a suite; a timeout is reported as a failed case, never silently ignored.
  readonly timeoutMs?: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

function timing(values: readonly number[]): BenchmarkCase["wallMs"] {
  return {
    median: median(values),
    p95: percentile(values, 0.95),
    total: values.reduce((sum, value) => sum + value, 0),
  };
}

function stageStatus(stages: readonly StageResult[], name: string): string {
  return stages.find((stage) => stage.stage === name)?.status ?? "missing";
}

async function microCase(
  name: string,
  iterations: number,
  action: () => Promise<{
    readonly correct: boolean;
    readonly metrics: Record<string, number | string>;
    readonly details?: string[];
  }>,
): Promise<BenchmarkCase> {
  const durations: number[] = [];
  let correct = true;
  let metrics: Record<string, number | string> = {};
  const details: string[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    try {
      const result = await action();
      durations.push(performance.now() - started);
      correct &&= result.correct;
      metrics = result.metrics;
      if (result.details !== undefined) details.push(...result.details);
    } catch (error) {
      durations.push(performance.now() - started);
      correct = false;
      details.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    name,
    status: correct ? "ok" : "failed",
    iterations,
    correctness: correct,
    wallMs: timing(durations),
    metrics,
    details: [...new Set(details)].slice(0, 10),
  };
}

async function runMicro(iterations: number): Promise<BenchmarkSuiteResult> {
  const source = [
    "def add(a: int, b: int) -> int:",
    "    return a + b",
    "",
    "def classify(value):",
    "    if value > 0:",
    "        return 'positive'",
    "    if value < 0:",
    "        return 'negative'",
    "    return 'zero'",
    "",
  ].join("\n");
  const parser = await createPythonBridgeParser();
  const parsed = await parser.parse(source, { filename: "bench.py" });
  const cases: BenchmarkCase[] = [
    await microCase("parse/python-small", iterations, async () => {
      const parsedOnce = await parser.parse(source, { filename: "bench.py" });
      return {
        correct: parsedOnce.ast.kind === "Module",
        metrics: { bytes: Buffer.byteLength(source, "utf8") },
      };
    }),
  ];
  for (const target of ["typescript", "javascript"] as const) {
    cases.push(
      await microCase(`translate/python-to-${target}`, iterations, async () => {
        const translator = await createPyToJsTranslator(target);
        const result = await runPipeline([{ filename: "bench.py", parseResult: parsed }], {
          target,
          translateUnit: translator,
          validateSyntax: await createOxcSyntaxValidator(),
        });
        const s1 = stageStatus(result.validationStages, "S1-syntax");
        return {
          correct: s1 === "pass" && result.emittedFiles.length > 0,
          metrics: {
            files: result.emittedFiles.length,
            ledgerEntries: result.ledger.length,
            claim: result.report.claimLevel,
          },
          ...(s1 === "pass" ? {} : { details: [`S1 status: ${s1}`] }),
        };
      }),
    );
  }
  return {
    name: "micro",
    status: cases.some((entry) => entry.status === "failed") ? "failed" : "ok",
    cases,
  };
}

function benchmarkAssetsRoot(): string {
  return process.env["CTRANS_BENCHMARKS_DIR"] ?? join(process.cwd(), "benchmarks");
}

async function runCorpus(iterations: number): Promise<BenchmarkSuiteResult> {
  const root = join(benchmarkAssetsRoot(), "corpus");
  let names: string[];
  try {
    names = readdirSync(root)
      .filter((name) => name.endsWith(".py"))
      .sort();
  } catch {
    return { name: "corpus", status: "skipped", cases: [] };
  }
  const files = names;
  const cases: BenchmarkCase[] = [];
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    const parser = await createPythonBridgeParser();
    const parsed = await parser.parse(source, { filename: file });
    cases.push(
      await microCase(`corpus/${file}/python-to-typescript`, iterations, async () => {
        const translator = await createPyToJsTranslator("typescript");
        const result = await runPipeline([{ filename: file, parseResult: parsed }], {
          target: "typescript",
          translateUnit: translator,
          validateSyntax: await createOxcSyntaxValidator(),
        });
        const s1 = stageStatus(result.validationStages, "S1-syntax");
        return {
          correct: s1 === "pass" && result.emittedFiles.length > 0,
          metrics: {
            bytes: Buffer.byteLength(source, "utf8"),
            ledgerEntries: result.ledger.length,
            claim: result.report.claimLevel,
          },
        };
      }),
    );
  }
  return {
    name: "corpus",
    status:
      files.length === 0
        ? "skipped"
        : cases.some((entry) => entry.status === "failed")
          ? "failed"
          : "ok",
    cases,
  };
}

async function runMiniProjects(iterations: number): Promise<BenchmarkSuiteResult> {
  const root = join(benchmarkAssetsRoot(), "projects");
  let projects: string[];
  try {
    projects = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { name: "mini-projects", status: "skipped", cases: [] };
  }
  const capabilities = await detectCapabilities();
  const toolchain = runnerToolchain();
  const cases: BenchmarkCase[] = [];
  for (const project of projects) {
    const durations: number[] = [];
    let status: BenchmarkStatus = "ok";
    let correctness = true;
    let metrics: Record<string, number | string> = {};
    const details: string[] = [];
    for (let index = 0; index < iterations; index += 1) {
      const outputRoot = mkdtempSync(join(tmpdir(), "ctrans-bench-"));
      const started = performance.now();
      try {
        const report = await runProject({
          sourceRoot: join(root, project, "input"),
          outputRoot,
          target: "typescript",
          intMode: "number",
          sandbox: capabilities,
          nodePath: process.execPath,
          pythonPath: "python3",
          ...toolchain,
          timeoutMs: 180000,
        });
        durations.push(performance.now() - started);
        const failed = report.pipeline.report.files.some((file) => file.status === "failed");
        correctness &&= !failed && stageStatus(report.stages, "S1-syntax") === "pass";
        metrics = {
          claim: report.pipeline.report.claimLevel,
          files: report.pipeline.report.files.length,
          s5: report.s5?.status ?? "skipped",
          s6: report.s6?.status ?? "skipped",
          differentialMatched: report.s6?.matched.length ?? 0,
        };
      } catch (error) {
        durations.push(performance.now() - started);
        status = "failed";
        correctness = false;
        details.push(error instanceof Error ? error.message : String(error));
      } finally {
        rmSync(outputRoot, { recursive: true, force: true });
      }
    }
    if (status !== "failed") status = correctness ? "ok" : "failed";
    cases.push({
      name: `mini-projects/${project}`,
      status,
      iterations,
      correctness,
      wallMs: timing(durations),
      metrics,
      details: [...new Set(details)].slice(0, 10),
    });
  }
  return {
    name: "mini-projects",
    status:
      projects.length === 0
        ? "skipped"
        : cases.some((entry) => entry.status === "failed")
          ? "failed"
          : "ok",
    cases,
  };
}

export const PERF_FILE_COUNT = 500;

// 500-file synthetic project: a dependency chain exercises ModuleGraph ordering and
// per-unit context without executing generated code. Timings are machine-local and
// must not be compared across hosts.
async function runPerf(iterations: number): Promise<BenchmarkSuiteResult> {
  const parser = await createOxcJsParser();
  const inputs: {
    readonly filename: string;
    readonly parseResult: Awaited<ReturnType<typeof parser.parse>>;
  }[] = [];
  for (let index = 0; index < PERF_FILE_COUNT; index += 1) {
    const previous =
      index === 0 ? "" : `import { value as previous } from "./m${String(index - 1)}.js";\n`;
    const body =
      index === 0
        ? `export const value = ${String(index)};\n`
        : `export const value = previous + ${String(index)};\n`;
    const content = `${previous}${body}`;
    inputs.push({
      filename: `m${String(index)}.js`,
      parseResult: await parser.parse(content, {
        filename: `m${String(index)}.js`,
        language: "javascript",
      }),
    });
  }
  const cases: BenchmarkCase[] = [
    await microCase("perf/500-modules-js-to-ts", iterations, async () => {
      const result = await runPipeline(inputs, {
        target: "typescript",
        translateUnit: new JsToTsTranslator(),
        validateSyntax: await createOxcSyntaxValidator(),
      });
      return {
        correct:
          result.emittedFiles.length >= PERF_FILE_COUNT &&
          stageStatus(result.validationStages, "S1-syntax") === "pass",
        metrics: {
          inputFiles: PERF_FILE_COUNT,
          emittedFiles: result.emittedFiles.length,
          ledgerEntries: result.ledger.length,
          claim: result.report.claimLevel,
        },
      };
    }),
  ];
  return { name: "perf", status: cases[0]!.status, cases };
}

export async function runBenchmark(
  suite: BenchmarkSuiteName,
  options: BenchmarkOptions = {},
): Promise<BenchmarkResult> {
  const iterations = options.iterations ?? (suite === "micro" ? 3 : 1);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1000) {
    throw new CTransError("BENCHMARK-OPTIONS", "iterations must be an integer 1..1000");
  }
  let result: BenchmarkSuiteResult;
  if (suite === "micro") result = await runMicro(iterations);
  else if (suite === "corpus") result = await runCorpus(iterations);
  else if (suite === "mini-projects") result = await runMiniProjects(iterations);
  else result = await runPerf(iterations);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    deterministic: true,
    suites: [result],
  };
}

// Strict result schema (benchmark self-test): missing cases, non-finite timings, or
// malformed metrics are rejected instead of being rendered as a report.
export function parseBenchmarkResult(value: unknown): BenchmarkResult {
  const fail = (message: string): never => {
    throw new BenchmarkResultError(message);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("benchmark result must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record["version"] !== 1) fail("benchmark result version must be 1");
  if (typeof record["generatedAt"] !== "string") fail("generatedAt must be a string");
  if (typeof record["nodeVersion"] !== "string") fail("nodeVersion must be a string");
  if (record["deterministic"] !== true) fail("deterministic must be true");
  if (!Array.isArray(record["suites"]) || record["suites"].length === 0) {
    fail("suites must be a non-empty array");
  }
  const suites = record["suites"] as unknown[];
  for (const suite of suites) {
    if (typeof suite !== "object" || suite === null) fail("suite must be an object");
    const suiteRecord = suite as Record<string, unknown>;
    if (!SUITE_NAMES.includes(suiteRecord["name"] as BenchmarkSuiteName)) {
      fail(`unknown suite name "${String(suiteRecord["name"])}"`);
    }
    if (!["ok", "failed", "skipped"].includes(suiteRecord["status"] as string)) {
      fail("suite status must be ok, failed, or skipped");
    }
    if (!Array.isArray(suiteRecord["cases"])) fail("suite cases must be an array");
    const cases = suiteRecord["cases"] as unknown[];
    if (suiteRecord["status"] === "ok" && cases.length === 0) {
      fail(`suite "${String(suiteRecord["name"])}" is ok but has no cases`);
    }
    for (const entry of cases) {
      if (typeof entry !== "object" || entry === null) fail("case must be an object");
      const testCase = entry as Record<string, unknown>;
      if (typeof testCase["name"] !== "string" || testCase["name"] === "") {
        fail("case name must be a non-empty string");
      }
      if (!["ok", "failed", "skipped"].includes(testCase["status"] as string)) {
        fail(`case ${String(testCase["name"])} has an invalid status`);
      }
      if (typeof testCase["correctness"] !== "boolean") {
        fail(`case ${String(testCase["name"])} must declare correctness`);
      }
      if (!Number.isInteger(testCase["iterations"]) || (testCase["iterations"] as number) < 1) {
        fail(`case ${String(testCase["name"])} iterations must be a positive integer`);
      }
      const wall = testCase["wallMs"];
      if (typeof wall !== "object" || wall === null) {
        fail(`case ${String(testCase["name"])} wallMs must be an object`);
      }
      for (const key of ["median", "p95", "total"] as const) {
        const number = (wall as Record<string, unknown>)[key];
        if (typeof number !== "number" || !Number.isFinite(number) || number < 0) {
          fail(
            `case ${String(testCase["name"])} wallMs.${key} must be a finite non-negative number`,
          );
        }
      }
      const metrics = testCase["metrics"];
      if (typeof metrics !== "object" || metrics === null || Array.isArray(metrics)) {
        fail(`case ${String(testCase["name"])} metrics must be an object`);
      }
      for (const [key, metric] of Object.entries(metrics as Record<string, unknown>)) {
        const valid =
          (typeof metric === "number" && Number.isFinite(metric)) || typeof metric === "string";
        if (!valid)
          fail(`case ${String(testCase["name"])} metric ${key} must be numeric or string`);
      }
      if (!Array.isArray(testCase["details"])) {
        fail(`case ${String(testCase["name"])} details must be an array`);
      }
    }
  }
  return value as unknown as BenchmarkResult;
}

export function summarizeBenchmark(result: BenchmarkResult): string {
  const lines = [
    `benchmark (${result.nodeVersion}); timings are machine-local and not a performance claim`,
  ];
  for (const suite of result.suites) {
    lines.push(`suite ${suite.name}: ${suite.status}`);
    for (const testCase of suite.cases) {
      lines.push(
        `  ${testCase.name}: ${testCase.status} (${String(testCase.iterations)} iter, median ${testCase.wallMs.median.toFixed(1)} ms, p95 ${testCase.wallMs.p95.toFixed(1)} ms)${testCase.correctness ? "" : " [CORRECTNESS FAILED]"}`,
      );
      const metrics = Object.entries(testCase.metrics)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(", ");
      if (metrics !== "") lines.push(`    ${metrics}`);
      for (const detail of testCase.details) lines.push(`    ! ${detail}`);
    }
  }
  return lines.join("\n");
}
