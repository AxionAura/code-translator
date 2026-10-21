// M11 command tests: `validate` on an existing target project and `benchmark`
// deterministic suites, including result-file writing and hardened usage errors.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { parseBenchmarkResult } from "../src/benchmark.ts";
import { runCliCommand } from "../src/main.ts";

const workspace = mkdtempSync(join(tmpdir(), "ctrans-cli-commands-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

const FIXTURE_TARGET = new URL(
  "../../../tests/fixtures/project-barrels-multi-module/expected",
  import.meta.url,
).pathname;

describe("ctrans validate", () => {
  it("validates an existing target project with all seven stage entries", async () => {
    const result = await runCliCommand(["validate", FIXTURE_TARGET, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      target: string;
      claimLevel: number;
      stages: { stage: string; status: string }[];
    };
    expect(parsed.target).toBe("typescript");
    expect(parsed.stages.map((stage) => stage.stage)).toEqual([
      "S1-syntax",
      "S2-types",
      "S3-dependencies",
      "S4-build",
      "S5-tests",
      "S6-differential",
      "S7-smoke",
    ]);
    expect(parsed.stages.find((stage) => stage.stage === "S1-syntax")!.status).toBe("pass");
    expect(parsed.stages.find((stage) => stage.stage === "S4-build")!.status).toBe("pass");
    // No source graph, so S3/S6 are honestly skipped and cap the numeric claim.
    expect(parsed.claimLevel).toBeLessThanOrEqual(2);
  }, 120000);

  it("rejects non-directories, empty projects, and unsupported flags", async () => {
    const nonDirectory = await runCliCommand(["validate", join(workspace, "missing"), "--json"]);
    expect(nonDirectory.code).toBe(1);
    const parsed = JSON.parse(nonDirectory.stderr) as { error: { code: string } };
    expect(parsed.error.code).toBeTruthy();

    const empty = join(workspace, "empty");
    rmSync(empty, { recursive: true, force: true });
    mkdirSync(empty, { recursive: true });
    const emptyResult = await runCliCommand(["validate", empty, "--json"]);
    expect(emptyResult.code).toBe(1);
    expect(emptyResult.stderr).toContain("VALIDATE-NO-FILES");

    const badFlag = await runCliCommand(["validate", FIXTURE_TARGET, "--repair"]);
    expect(badFlag.code).toBe(2);
    expect(badFlag.stderr).toContain("validate accepts");
  });
});

describe("ctrans benchmark", () => {
  it("runs the deterministic micro suite and emits a schema-valid result", async () => {
    const resultsPath = join(workspace, "results", "micro.json");
    const result = await runCliCommand([
      "benchmark",
      "--suite",
      "micro",
      "--iterations",
      "1",
      "--json",
      "--results",
      resultsPath,
    ]);
    expect(result.code, result.stderr).toBe(0);
    const parsed = parseBenchmarkResult(JSON.parse(result.stdout));
    expect(parsed.suites[0]!.name).toBe("micro");
    expect(parsed.suites[0]!.status).toBe("ok");
    expect(parsed.suites[0]!.cases.length).toBe(3);
    expect(parsed.suites[0]!.cases.every((entry) => entry.correctness)).toBe(true);
    expect(existsSync(resultsPath)).toBe(true);
    expect(() => parseBenchmarkResult(JSON.parse(readFileSync(resultsPath, "utf8")))).not.toThrow();
  }, 120000);

  it("runs the corpus suite from the repository benchmark assets", async () => {
    const result = await runCliCommand([
      "benchmark",
      "--suite",
      "corpus",
      "--iterations",
      "1",
      "--json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    const parsed = parseBenchmarkResult(JSON.parse(result.stdout));
    expect(parsed.suites[0]!.status).toBe("ok");
    expect(parsed.suites[0]!.cases.length).toBeGreaterThanOrEqual(3);
  }, 120000);

  it("rejects unknown suites, invalid iterations, and unrelated flags", async () => {
    for (const args of [
      ["benchmark", "--suite", "nope"],
      ["benchmark", "--iterations", "0"],
      ["benchmark", "--to", "ts"],
      ["benchmark", "extra"],
    ]) {
      const result = await runCliCommand(args);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stderr.length).toBeGreaterThan(0);
    }
  });
});
