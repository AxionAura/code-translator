// Benchmark self-tests (M11): deterministic micro suite correctness, result-schema
// validation, and malformed/missing evidence detection. Timing values are not
// asserted; only correctness, schema validity, and the 500-file smoke budget are.
import { describe, expect, it } from "vitest";

import {
  BenchmarkResultError,
  PERF_FILE_COUNT,
  parseBenchmarkResult,
  runBenchmark,
  summarizeBenchmark,
} from "../apps/cli/src/benchmark.ts";

describe("benchmark harness", () => {
  it("runs the micro suite deterministically with correctness checks", async () => {
    const result = await runBenchmark("micro", { iterations: 1 });
    const parsed = parseBenchmarkResult(result);
    expect(parsed.suites[0]!.status).toBe("ok");
    expect(parsed.suites[0]!.cases.map((entry) => entry.name)).toEqual([
      "parse/python-small",
      "translate/python-to-typescript",
      "translate/python-to-javascript",
    ]);
    for (const entry of parsed.suites[0]!.cases) {
      expect(entry.correctness).toBe(true);
      expect(entry.status).toBe("ok");
      expect(entry.wallMs.median).toBeGreaterThanOrEqual(0);
    }
    expect(summarizeBenchmark(parsed)).toContain("timings are machine-local");
  }, 120000);

  it("runs the 500-file perf suite without executing generated code", async () => {
    const result = await runBenchmark("perf", { iterations: 1 });
    const parsed = parseBenchmarkResult(result);
    const entry = parsed.suites[0]!.cases[0]!;
    expect(entry.correctness).toBe(true);
    expect(entry.metrics["inputFiles"]).toBe(PERF_FILE_COUNT);
    expect(entry.metrics["emittedFiles"]).toBeGreaterThanOrEqual(PERF_FILE_COUNT);
  }, 120000);

  it("rejects malformed results instead of rendering them", async () => {
    const valid = await runBenchmark("micro", { iterations: 1 });
    const mutations: readonly ((value: Record<string, unknown>) => void)[] = [
      (value) => delete value["nodeVersion"],
      (value) => {
        value["suites"] = [];
      },
      (value) => {
        const suites = value["suites"] as Record<string, unknown>[];
        suites[0]!["cases"] = [];
      },
      (value) => {
        const suites = value["suites"] as Record<string, unknown>[];
        const cases = suites[0]!["cases"] as Record<string, unknown>[];
        (cases[0]!["wallMs"] as Record<string, unknown>)["median"] = Number.NaN;
      },
      (value) => {
        const suites = value["suites"] as Record<string, unknown>[];
        suites[0]!["name"] = "unknown-suite";
      },
      (value) => {
        const suites = value["suites"] as Record<string, unknown>[];
        const cases = suites[0]!["cases"] as Record<string, unknown>[];
        cases[0]!["correctness"] = "yes";
      },
      (value) => {
        const suites = value["suites"] as Record<string, unknown>[];
        const cases = suites[0]!["cases"] as Record<string, unknown>[];
        cases[0]!["metrics"] = { bad: Number.POSITIVE_INFINITY };
      },
    ];
    for (const mutate of mutations) {
      const clone = structuredClone(valid) as unknown as Record<string, unknown>;
      mutate(clone);
      expect(() => parseBenchmarkResult(clone)).toThrow(BenchmarkResultError);
    }
  });
});
