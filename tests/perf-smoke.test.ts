// 500-file performance smoke (M11): runs the compiled-independent CLI benchmark
// suite and asserts completion inside a deliberately generous CI budget. The
// recorded duration is environment-specific and is not a performance claim.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = fileURLToPath(new URL("../apps/cli/bin/ctrans.mjs", import.meta.url));
const BUDGET_MS = 120000;

describe("500-file performance smoke", () => {
  it(
    "translates 500 synthetic modules within the CI budget",
    async () => {
      const started = Date.now();
      const { stdout } = await exec(
        process.execPath,
        [CLI, "benchmark", "--suite", "perf", "--iterations", "1", "--json"],
        { cwd: ROOT, timeout: BUDGET_MS, maxBuffer: 8 * 1024 * 1024 },
      );
      const elapsed = Date.now() - started;
      const result = JSON.parse(stdout) as {
        suites: {
          status: string;
          cases: { correctness: boolean; metrics: { inputFiles: number; emittedFiles: number } }[];
        }[];
      };
      const suite = result.suites[0]!;
      expect(suite.status).toBe("ok");
      expect(suite.cases[0]!.correctness).toBe(true);
      expect(suite.cases[0]!.metrics.inputFiles).toBe(500);
      expect(suite.cases[0]!.metrics.emittedFiles).toBeGreaterThanOrEqual(500);
      expect(elapsed).toBeLessThan(BUDGET_MS);
    },
    BUDGET_MS + 30000,
  );
});
