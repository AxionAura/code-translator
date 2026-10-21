// S4 build and S7 smoke contracts (M10): real work is delegated to trusted
// toolchains inside the sandbox, infrastructure is never a source verdict, and
// S7 is opt-in with bounded harness input.
import { describe, expect, it } from "vitest";

import { SandboxIsolationError, type SandboxRunResult, type SandboxRunSpec } from "@ctrans/sandbox";

import { runS4, runS7, type SmokeHarness } from "../src/index.js";

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

const capabilities = {
  bwrap: { available: true, version: "0.12", unavailableReason: null },
  prlimit: { available: true, version: "1", unavailableReason: null },
  networkIsolation: "enforced" as const,
};

const FILES = new Map([
  ["mod.ts", "export const x = 1;\n"],
  ["tests/test_mod.test.ts", "import '../mod.ts';\n"],
]);

describe("S4 build", () => {
  const options = {
    capabilities,
    nodePath: "/usr/bin/node",
    pythonPath: "python3",
    nodeModulesPath: "/tool/node_modules",
    typescriptEntryPath: "/tool/node_modules/typescript/bin/tsc",
    timeoutMs: 1000,
  };

  it("runs the pinned tsc CLI over a generated tsconfig", async () => {
    let seen: SandboxRunSpec | null = null;
    const s4 = await runS4(
      { files: FILES, target: "typescript" },
      {
        ...options,
        run: async (spec) => {
          seen = spec;
          return result({});
        },
      },
    );
    expect(s4.status).toBe("pass");
    expect(seen!.argv).toEqual([
      "/usr/bin/node",
      "/tool/node_modules/typescript/bin/tsc",
      "--noEmit",
      "-p",
      "tsconfig.json",
    ]);
    const tsconfig = seen!.files.find((file) => file.path === "tsconfig.json");
    expect(tsconfig?.content).toContain('"strict": true');
    expect(seen!.symlinks?.map((link) => link.path)).toEqual([
      "node_modules/typescript",
      "node_modules/vitest",
    ]);
  });

  it("fails on a real build diagnostic", async () => {
    const s4 = await runS4(
      { files: FILES, target: "typescript" },
      {
        ...options,
        run: async () =>
          result({
            exitCode: 2,
            stdout: "mod.ts(1,1): error TS2304: Cannot find name 'x'.",
            stderr: "",
          }),
      },
    );
    expect(s4.status).toBe("fail");
    expect(s4.details[0]).toContain("mod.ts:");
    expect(s4.details[0]).toContain("error TS2304");
  });

  it("maps infrastructure outcomes to skipped, never fail", async () => {
    for (const outcome of ["timeout", "output-limit", "spawn-failed", "container-error"] as const) {
      const s4 = await runS4(
        { files: FILES, target: "typescript" },
        { ...options, run: async () => result({ outcome, exitCode: null }) },
      );
      expect(s4.status, outcome).toBe("skipped");
    }
  });

  it("skips honestly when the build toolchain is not configured", async () => {
    const s4 = await runS4(
      { files: FILES, target: "typescript" },
      { capabilities, nodePath: "/usr/bin/node", pythonPath: "python3" },
    );
    expect(s4.status).toBe("skipped");
    expect(s4.reason).toContain("toolchain is not configured");
  });

  it("reports JavaScript targets as having no build step", async () => {
    const s4 = await runS4({ files: FILES, target: "javascript" }, options);
    expect(s4.status).toBe("skipped");
    expect(s4.reason).toContain("no build step");
  });

  it("runs compileall for Python output through the sandbox", async () => {
    let seen: SandboxRunSpec | null = null;
    const s4 = await runS4(
      { files: new Map([["mod.py", "def x():\n    return 1\n"]]), target: "python" },
      {
        capabilities,
        nodePath: "/usr/bin/node",
        pythonPath: "python3",
        run: async (spec) => {
          seen = spec;
          return result({});
        },
      },
    );
    expect(s4.status).toBe("pass");
    expect(seen!.argv).toEqual(["python3", "-m", "compileall", "-q", "."]);
    expect(seen!.requireNetworkIsolation).toBe(true);
  });
});

describe("S7 smoke", () => {
  const options = { capabilities, timeoutMs: 5000 };

  it("passes when exit code and stdout match", async () => {
    const harness: SmokeHarness = {
      argv: ["node", "harness.mjs"],
      expectedStdout: "3\n",
      files: [{ path: "harness.mjs", content: "console.log(3);\n" }],
    };
    let seen: SandboxRunSpec | null = null;
    const s7 = await runS7(
      { files: FILES, harness },
      {
        ...options,
        run: async (spec) => {
          seen = spec;
          return result({ stdout: "3\n" });
        },
      },
    );
    expect(s7.status).toBe("pass");
    expect(seen!.stdin).toBeUndefined();
    expect(seen!.requireNetworkIsolation).toBe(true);
    expect(seen!.files.some((file) => file.path === "harness.mjs")).toBe(true);
  });

  it("forwards bounded stdin and compares includes/exit code", async () => {
    let seen: SandboxRunSpec | null = null;
    const s7 = await runS7(
      {
        files: FILES,
        harness: {
          argv: ["node", "h.mjs"],
          stdin: "input\n",
          stdoutIncludes: "ok",
          expectedExitCode: 2,
        },
      },
      {
        ...options,
        run: async (spec) => {
          seen = spec;
          return result({ stdout: "not ok", exitCode: 2 });
        },
      },
    );
    expect(seen!.stdin).toBe("input\n");
    expect(s7.status).toBe("pass");
  });

  it("fails on exit/stdout mismatches without leaking captured output into details", async () => {
    const s7 = await runS7(
      {
        files: FILES,
        harness: { argv: ["node", "h.mjs"], expectedExitCode: 0, expectedStdout: "secret-output" },
      },
      { ...options, run: async () => result({ stdout: "different-secret-value", exitCode: 1 }) },
    );
    expect(s7.status).toBe("fail");
    expect(s7.stdout).toBe("different-secret-value");
    expect(s7.details.join(" ")).not.toContain("different-secret-value");
  });

  it("classifies infrastructure outcomes and isolation refusal as skipped", async () => {
    const timeout = await runS7(
      { files: FILES, harness: { argv: ["node", "h.mjs"] } },
      { ...options, run: async () => result({ outcome: "timeout", exitCode: null }) },
    );
    expect(timeout.status).toBe("skipped");
    const refused = await runS7(
      { files: FILES, harness: { argv: ["node", "h.mjs"] } },
      {
        ...options,
        run: async () => {
          throw new SandboxIsolationError("network isolation required but unavailable");
        },
      },
    );
    expect(refused.status).toBe("skipped");
    expect(refused.reason).toContain("refused");
  });

  it("rejects unsafe or contradictory harness manifests before execution", async () => {
    let executed = false;
    const run = async (): Promise<SandboxRunResult> => {
      executed = true;
      return result({});
    };
    await expect(
      runS7(
        {
          files: FILES,
          harness: { argv: ["node", "h.mjs"], files: [{ path: "../x", content: "" }] },
        },
        { ...options, run },
      ),
    ).rejects.toThrow(/workspace-relative/);
    await expect(
      runS7(
        {
          files: FILES,
          harness: { argv: [], files: [] },
        },
        { ...options, run },
      ),
    ).rejects.toThrow(/argv/);
    await expect(
      runS7(
        {
          files: FILES,
          harness: {
            argv: ["node"],
            files: [{ path: "mod.ts", content: "collision" }],
          },
        },
        { ...options, run },
      ),
    ).rejects.toThrow(/collides/);
    await expect(
      runS7(
        { files: FILES, harness: { argv: ["node"], expectedStdout: "a", stdoutIncludes: "b" } },
        { ...options, run },
      ),
    ).rejects.toThrow(/not both/);
    expect(executed).toBe(false);
  });
});
