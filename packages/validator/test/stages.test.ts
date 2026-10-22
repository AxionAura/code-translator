// S5/S6 stage behavior (M10): flaky rerun-once policy, infrastructure
// classification, target-file attribution, and differential exclusion of
// unstable tests. A scripted `run` seam supplies sandbox results deterministically;
// no translated code is executed by these tests.
import { describe, expect, it } from "vitest";

import type { SandboxRunResult } from "@axion-ct/sandbox";

import {
  runS5,
  runS6,
  sourceRunnerScript,
  type S5Options,
  type SandboxRun,
  type TestOutcome,
} from "../src/index.js";

function report(
  outcomes: readonly { name: string; status: "passed" | "failed"; message?: string }[],
  workspace = "/tmp/ctrans-ws",
): string {
  return JSON.stringify({
    numTotalTestSuites: 1,
    testResults: [
      {
        name: `${workspace}/tests/test_mod.test.ts`,
        assertionResults: outcomes.map((outcome) => ({
          fullName: outcome.name,
          status: outcome.status,
          failureMessages: outcome.message === undefined ? [] : [outcome.message],
        })),
      },
    ],
  });
}

function completed(stdout: string, exitCode = 0, workspace = "/tmp/ctrans-ws"): SandboxRunResult {
  return {
    outcome: "completed",
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    workspacePath: workspace,
  };
}

function infra(
  outcome: "timeout" | "output-limit" | "spawn-failed" | "container-error",
): SandboxRunResult {
  return {
    outcome,
    exitCode: null,
    signal: "SIGKILL",
    stdout: "",
    stderr: "infrastructure detail",
    stdoutTruncated: outcome === "output-limit",
    stderrTruncated: false,
    durationMs: 1,
    workspacePath: "/tmp/ctrans-ws",
  };
}

const BASE_OPTIONS: S5Options = {
  capabilities: {
    bwrap: { available: true, version: "0.12", unavailableReason: null },
    prlimit: { available: true, version: "1", unavailableReason: null },
    networkIsolation: "enforced",
    filesystemIsolation: "bwrap-allowlist",
  },
  nodeModulesPath: "/tool/node_modules",
  vitestEntryPath: "/tool/node_modules/vitest/vitest.mjs",
  nodePath: "/usr/bin/node",
  timeoutMs: 1000,
};

function scripted(runs: readonly SandboxRunResult[]): { run: SandboxRun; calls: () => number } {
  let index = 0;
  return {
    run: async () => {
      const next = runs[Math.min(index, runs.length - 1)]!;
      index += 1;
      return next;
    },
    calls: () => index,
  };
}

const INPUT = {
  files: new Map([
    ["mod.ts", "export const x = 1;\n"],
    ["tests/test_mod.test.ts", "import '../mod.ts';\n"],
  ]),
  testFiles: ["tests/test_mod.test.ts"],
};

describe("S5 flaky rerun-once", () => {
  it("a clean first-attempt pass is not rerun", async () => {
    const { run, calls } = scripted([completed(report([{ name: "test_a", status: "passed" }]))]);
    const result = await runS5(INPUT, { ...BASE_OPTIONS, run });
    expect(result.status).toBe("pass");
    expect(result.rerunPerformed).toBe(false);
    expect(result.outcomes[0]!.attempts.length).toBe(1);
    expect(calls()).toBe(1);
  });

  it("fail-then-pass is flaky: excluded, but distinguishable from a clean pass", async () => {
    const { run, calls } = scripted([
      completed(
        report([
          { name: "test_clean", status: "passed" },
          { name: "test_flaky", status: "failed", message: "boom" },
        ]),
        1,
      ),
      completed(
        report([
          { name: "test_clean", status: "passed" },
          { name: "test_flaky", status: "passed" },
        ]),
      ),
    ]);
    const result = await runS5(INPUT, { ...BASE_OPTIONS, run });
    expect(result.status).toBe("pass");
    expect(result.rerunPerformed).toBe(true);
    expect(calls()).toBe(2);
    expect(result.flaky).toEqual(["test_flaky"]);
    const flaky = result.outcomes.find((outcome) => outcome.name === "test_flaky")!;
    expect(flaky.flaky).toBe(true);
    expect(flaky.outcome).toBe("passed");
    expect(flaky.attempts.map((attempt) => attempt.outcome)).toEqual(["failed", "passed"]);
    const clean = result.outcomes.find((outcome) => outcome.name === "test_clean")!;
    expect(clean.flaky).toBe(false);
    expect(clean.attempts.length).toBe(1);
    expect(result.details.some((detail) => detail.includes("flaky"))).toBe(true);
  });

  it("fail-then-fail keeps both attempts and fails", async () => {
    const { run, calls } = scripted([
      completed(report([{ name: "test_a", status: "failed", message: "first" }]), 1),
      completed(report([{ name: "test_a", status: "failed", message: "second" }]), 1),
    ]);
    const result = await runS5(INPUT, { ...BASE_OPTIONS, run });
    expect(result.status).toBe("fail");
    expect(calls()).toBe(2);
    expect(result.outcomes[0]!.attempts.length).toBe(2);
    expect(result.details[0]).toContain("tests/test_mod.test.ts");
    expect(result.details[0]).toContain("second");
  });

  it("reports first-pass tests that fail on the rerun without overturning the pass", async () => {
    const { run } = scripted([
      completed(
        report([
          { name: "test_clean", status: "passed" },
          { name: "test_bad", status: "failed" },
        ]),
        1,
      ),
      completed(
        report([
          { name: "test_clean", status: "failed" },
          { name: "test_bad", status: "failed" },
        ]),
        1,
      ),
    ]);
    const result = await runS5(INPUT, { ...BASE_OPTIONS, run });
    expect(result.status).toBe("fail");
    expect(result.outcomes.find((outcome) => outcome.name === "test_clean")!.outcome).toBe(
      "passed",
    );
    expect(result.details.some((detail) => detail.includes("failed on rerun"))).toBe(true);
  });

  it("all-flaky results are a warn, never a claim-supporting pass", async () => {
    const { run } = scripted([
      completed(report([{ name: "test_a", status: "failed" }]), 1),
      completed(report([{ name: "test_a", status: "passed" }])),
    ]);
    const result = await runS5(INPUT, { ...BASE_OPTIONS, run });
    expect(result.status).toBe("warn");
    expect(result.reason).toContain("flaky");
  });

  it("honors rerunFlaky: false (no recursive retry)", async () => {
    const { run, calls } = scripted([completed(report([{ name: "test_a", status: "failed" }]), 1)]);
    const result = await runS5(INPUT, { ...BASE_OPTIONS, rerunFlaky: false, run });
    expect(result.status).toBe("fail");
    expect(result.rerunPerformed).toBe(false);
    expect(calls()).toBe(1);
  });

  it("keeps first-attempt failures when the rerun cannot run", async () => {
    const { run } = scripted([
      completed(report([{ name: "test_a", status: "failed" }]), 1),
      infra("timeout"),
    ]);
    const result = await runS5(INPUT, { ...BASE_OPTIONS, run });
    expect(result.status).toBe("fail");
    expect(result.details.some((detail) => detail.includes("rerun unavailable"))).toBe(true);
  });

  it("classifies infrastructure outcomes as skipped (never as test failures)", async () => {
    for (const outcome of ["timeout", "output-limit", "spawn-failed", "container-error"] as const) {
      const { run } = scripted([infra(outcome)]);
      const result = await runS5(INPUT, { ...BASE_OPTIONS, run });
      expect(result.status, outcome).toBe("skipped");
      expect(result.outcomes).toEqual([]);
    }
  });

  it("treats an unparseable runner report as inconclusive evidence", async () => {
    const { run } = scripted([completed("not json")]);
    const result = await runS5(INPUT, { ...BASE_OPTIONS, run });
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("no parseable JSON");
  });

  it("fails when the runner reports an empty suite", async () => {
    const { run } = scripted([
      completed(JSON.stringify({ numTotalTestSuites: 0, testResults: [] })),
    ]);
    const result = await runS5(INPUT, { ...BASE_OPTIONS, run });
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("no tests collected");
  });
});

function targetOutcome(
  name: string,
  outcome: "passed" | "failed",
  options: { file?: string; flaky?: boolean } = {},
): TestOutcome {
  return {
    name,
    file: options.file ?? "tests/test_mod.test.ts",
    outcome,
    flaky: options.flaky ?? false,
    attempts: [{ outcome, message: null }],
  };
}

function sourceRun(
  outcomes: readonly { name: string; outcome: "passed" | "failed" }[],
): SandboxRunResult {
  return completed(JSON.stringify(outcomes), 0, "/tmp/source-ws");
}

describe("S6 differential", () => {
  const options = {
    capabilities: BASE_OPTIONS.capabilities,
    nodePath: "/usr/bin/node",
    pythonPath: "python3",
    timeoutMs: 1000,
  };
  const input = {
    sourceFiles: new Map([["mod.py", "def x(): return 1\n"]]),
    sourceTestModules: [{ path: "tests/test_mod.py", testNames: ["test_a", "test_b"] }],
    targetOutcomes: [targetOutcome("test_a", "passed"), targetOutcome("test_b", "passed")],
    sourceRunnerScript: sourceRunnerScript(),
  };

  it("passes when stable outcomes match", async () => {
    const { run } = scripted([
      sourceRun([
        { name: "test_a", outcome: "passed" },
        { name: "test_b", outcome: "passed" },
      ]),
    ]);
    const result = await runS6({ ...options, run }, input);
    expect(result.status).toBe("pass");
    expect(result.matched.length).toBe(2);
    expect(result.flaky).toEqual([]);
  });

  it("excludes flaky target tests from the comparison (never counts them as matches)", async () => {
    const { run } = scripted([
      sourceRun([
        { name: "test_a", outcome: "passed" },
        { name: "test_b", outcome: "passed" },
      ]),
    ]);
    const result = await runS6(
      { ...options, run },
      {
        ...input,
        targetOutcomes: [
          targetOutcome("test_a", "passed"),
          targetOutcome("test_b", "passed", { flaky: true }),
        ],
      },
    );
    expect(result.status).toBe("pass");
    expect(result.matched.map((entry) => entry.name)).toEqual(["test_a"]);
    expect(result.flaky).toEqual(["test_b"]);
    expect(result.sourceOnly).toEqual([]);
    expect(result.targetOnly).toEqual([]);
  });

  it("warns when every comparable outcome was flaky (no stable evidence)", async () => {
    const { run } = scripted([sourceRun([{ name: "test_a", outcome: "passed" }])]);
    const result = await runS6(
      { ...options, run },
      {
        ...input,
        sourceTestModules: [{ path: "tests/test_mod.py", testNames: ["test_a"] }],
        targetOutcomes: [targetOutcome("test_a", "passed", { flaky: true })],
      },
    );
    expect(result.status).toBe("warn");
    expect(result.matched).toEqual([]);
  });

  it("fails with target-file attribution on a divergence", async () => {
    const { run } = scripted([
      sourceRun([
        { name: "test_a", outcome: "passed" },
        { name: "test_b", outcome: "failed" },
      ]),
    ]);
    const result = await runS6({ ...options, run }, input);
    expect(result.status).toBe("fail");
    expect(result.mismatched.length).toBe(1);
    expect(result.details[0]).toContain("tests/test_mod.test.ts:");
    expect(result.details[0]).toContain("source=failed target=passed");
  });

  it("classifies source-runner infrastructure failures as skipped", async () => {
    const { run } = scripted([infra("container-error")]);
    const result = await runS6({ ...options, run }, input);
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("container-error");
  });
});
