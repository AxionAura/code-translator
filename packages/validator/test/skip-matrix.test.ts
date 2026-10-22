// Stage × capability skip matrix (M10 acceptance gate): every skip reason the
// validator can produce is exercised with the condition that causes it. A skip is
// always visible with a stable, meaningful reason — never a pass, never a failure.
import { describe, expect, it } from "vitest";

import {
  SandboxIsolationError,
  type SandboxRunResult,
  type SandboxRunSpec,
} from "@axion-ct/sandbox";

import { runS4, runS5, runS6, runS7, sourceRunnerScript, type BuildTarget } from "../src/index.js";

const capabilities = {
  bwrap: { available: false, version: null, unavailableReason: "bwrap not found" },
  prlimit: { available: false, version: null, unavailableReason: "prlimit not found" },
  networkIsolation: "policy-only" as const,
  filesystemIsolation: "none" as const,
};

function result(overrides: Partial<SandboxRunResult>): SandboxRunResult {
  return {
    outcome: "completed",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    workspacePath: "/tmp/ws",
    ...overrides,
  };
}

const FILES = new Map([["mod.ts", "export const x = 1;\n"]]);
const S5_INPUT = {
  files: new Map([...FILES, ["tests/test_mod.test.ts", ""]]),
  testFiles: ["tests/test_mod.test.ts"],
};
const BASE_S5 = {
  capabilities,
  nodeModulesPath: "/tool/node_modules",
  vitestEntryPath: "/tool/vitest.mjs",
  nodePath: "/usr/bin/node",
};

describe("documented skip reasons", () => {
  it("S4: missing toolchain, no JS build step, infrastructure, isolation refusal", async () => {
    const missingToolchain = await runS4(
      { files: FILES, target: "typescript" },
      { capabilities, nodePath: "/usr/bin/node", pythonPath: "python3" },
    );
    expect(missingToolchain.status).toBe("skipped");
    expect(missingToolchain.reason).toMatch(/toolchain is not configured/);
    const cases: readonly {
      name: string;
      target: BuildTarget;
      run?: (spec: SandboxRunSpec) => Promise<SandboxRunResult>;
      reason: RegExp;
    }[] = [
      { name: "javascript", target: "javascript", reason: /no build step/ },
      {
        name: "timeout",
        target: "typescript",
        run: async () => result({ outcome: "timeout", exitCode: null }),
        reason: /timed out \(infrastructure\)/,
      },
      {
        name: "output-limit",
        target: "typescript",
        run: async () => result({ outcome: "output-limit", exitCode: null }),
        reason: /output exceeded the sandbox cap/,
      },
      {
        name: "spawn-failed",
        target: "typescript",
        run: async () => result({ outcome: "spawn-failed", exitCode: null }),
        reason: /failed to spawn/,
      },
      {
        name: "container-error",
        target: "typescript",
        run: async () => result({ outcome: "container-error", exitCode: 125 }),
        reason: /container failed to start/,
      },
    ];
    for (const entry of cases) {
      const s4 = await runS4(
        { files: FILES, target: entry.target },
        {
          capabilities,
          nodePath: "/usr/bin/node",
          pythonPath: "python3",
          ...(entry.target === "typescript"
            ? {
                nodeModulesPath: "/tool/node_modules",
                typescriptEntryPath: "/tool/tsc",
              }
            : {}),
          ...(entry.run === undefined ? {} : { run: entry.run }),
        },
      );
      expect(s4.status, entry.name).toBe("skipped");
      expect(s4.reason, entry.name).toMatch(entry.reason);
    }
  });

  it("S5: every sandbox outcome and unparseable evidence maps to skipped", async () => {
    const outcomes = ["timeout", "output-limit", "spawn-failed", "container-error"] as const;
    for (const outcome of outcomes) {
      const s5 = await runS5(S5_INPUT, {
        ...BASE_S5,
        run: async () => result({ outcome, exitCode: null, stderr: "infra" }),
      });
      expect(s5.status, outcome).toBe("skipped");
      expect(s5.reason, outcome).not.toBeNull();
    }
    const unparseable = await runS5(S5_INPUT, {
      ...BASE_S5,
      run: async () => result({ stdout: "garbage" }),
    });
    expect(unparseable.status).toBe("skipped");
    expect(unparseable.reason).toContain("no parseable JSON");
  });

  it("S5: isolation refusal is surfaced to the caller (strict contract)", async () => {
    await expect(
      runS5(S5_INPUT, {
        ...BASE_S5,
        run: async () => {
          throw new SandboxIsolationError("network isolation required but unavailable");
        },
      }),
    ).rejects.toBeInstanceOf(SandboxIsolationError);
  });

  it("S6: source-runner infrastructure and unparseable output map to skipped", async () => {
    const options = {
      capabilities,
      nodePath: "/usr/bin/node",
      pythonPath: "python3",
    };
    const input = {
      sourceFiles: new Map([["mod.py", "def x(): return 1\n"]]),
      sourceTestModules: [{ path: "tests/test_mod.py", testNames: ["test_x"] }],
      targetOutcomes: [],
      sourceRunnerScript: sourceRunnerScript(),
    };
    for (const outcome of ["timeout", "output-limit", "spawn-failed", "container-error"] as const) {
      const s6 = await runS6(
        { ...options, run: async () => result({ outcome, exitCode: null, stderr: "infra" }) },
        input,
      );
      expect(s6.status, outcome).toBe("skipped");
    }
    const unparseable = await runS6(
      { ...options, run: async () => result({ stdout: "garbage" }) },
      input,
    );
    expect(unparseable.status).toBe("skipped");
    expect(unparseable.reason).toContain("no parseable");
    const failed = await runS6(
      {
        ...options,
        run: async () => result({ exitCode: 2, stdout: "[]", stderr: "import failed" }),
      },
      input,
    );
    expect(failed.status).toBe("skipped");
    expect(failed.reason).toContain("source runner failed");
  });

  it("S7: missing harness is caller-level; refusal/timeout are explicit skips", async () => {
    const harness = { argv: ["node", "h.mjs"] };
    const refused = await runS7(
      { files: FILES, harness },
      {
        capabilities,
        run: async () => {
          throw new SandboxIsolationError("execution refused");
        },
      },
    );
    expect(refused.status).toBe("skipped");
    expect(refused.reason).toContain("refused");
    for (const outcome of ["timeout", "output-limit", "spawn-failed", "container-error"] as const) {
      const s7 = await runS7(
        { files: FILES, harness },
        {
          capabilities,
          run: async () => result({ outcome, exitCode: null, stderr: "infra" }),
        },
      );
      expect(s7.status, outcome).toBe("skipped");
    }
  });
});
