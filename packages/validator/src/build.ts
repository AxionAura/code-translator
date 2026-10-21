// S4 build (docs/validation.md §1): a structural build check distinct from S2's
// type oracle. TypeScript runs the pinned `tsc --noEmit` CLI over a generated
// project tsconfig; Python runs `compileall` (compile only, never import);
// JavaScript has no build step and is reported skipped with that reason. The
// tools are trusted; the emitted project is untrusted data. Infrastructure
// failures (timeout, spawn, container) are skips, never source defects.
import { join } from "node:path";

import type { StageResult } from "@ctrans/core";
import {
  SandboxIsolationError,
  SandboxRunner,
  type ContainerRunOptions,
  type SandboxCapabilities,
  type SandboxRunResult,
  type SandboxRunSpec,
} from "@ctrans/sandbox";

import type { SandboxRun } from "./stages.js";

export type BuildTarget = "typescript" | "javascript" | "python";

export interface S4Options {
  readonly capabilities: SandboxCapabilities;
  readonly nodePath: string;
  readonly pythonPath: string;
  readonly nodeModulesPath?: string;
  readonly typescriptEntryPath?: string;
  readonly timeoutMs?: number;
  readonly strict?: boolean;
  readonly container?: ContainerRunOptions;
  readonly run?: SandboxRun;
}

export interface S4Input {
  readonly files: ReadonlyMap<string, string>;
  readonly target: BuildTarget;
}

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      strict: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      allowJs: true,
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      skipLibCheck: true,
      types: [],
    },
    include: ["**/*.ts"],
  },
  null,
  2,
);

export async function runS4(input: S4Input, options: S4Options): Promise<StageResult> {
  if (input.target === "javascript") {
    return {
      stage: "S4-build",
      status: "skipped",
      reason: "JavaScript target has no build step (S1 syntax validation is authoritative)",
      details: [],
    };
  }
  if (input.target === "python") {
    return runPythonCompile(input, options);
  }
  return runTypeScriptBuild(input, options);
}

async function runTypeScriptBuild(input: S4Input, options: S4Options): Promise<StageResult> {
  if (options.nodeModulesPath === undefined || options.typescriptEntryPath === undefined) {
    return {
      stage: "S4-build",
      status: "skipped",
      reason: "TypeScript build toolchain is not configured (nodeModulesPath/typescriptEntryPath)",
      details: [],
    };
  }
  const files = new Map(input.files);
  files.set("tsconfig.json", TSCONFIG);
  const strict = options.strict === true;
  const spec: SandboxRunSpec = {
    argv: [options.nodePath, options.typescriptEntryPath, "--noEmit", "-p", "tsconfig.json"],
    files: [...files.entries()].map(([path, content]) => ({ path, content })),
    symlinks: [
      { path: "node_modules/typescript", target: join(options.nodeModulesPath, "typescript") },
      // Emitted test modules import vitest; its types resolve through the
      // toolchain copy (nothing is installed).
      { path: "node_modules/vitest", target: join(options.nodeModulesPath, "vitest") },
    ],
    timeoutMs: options.timeoutMs ?? 120000,
    stdoutCapBytes: 4 * 1024 * 1024,
    stderrCapBytes: 1024 * 1024,
    // tsc parses but never executes project code; no network isolation is needed.
    requireNetworkIsolation: false,
    // Tool-controlled toolchain mounts (used by strict containers and by the host
    // bwrap profile when the path lives under the shadowed /tmp).
    containerMounts: [{ path: options.nodeModulesPath, readOnly: true }],
    ...(strict
      ? {
          strict: true,
          containerArgv: ["node", options.typescriptEntryPath, "--noEmit", "-p", "tsconfig.json"],
        }
      : {}),
  };
  return classifyBuildRun(await runSpec(options, spec), "TypeScript");
}

async function runPythonCompile(input: S4Input, options: S4Options): Promise<StageResult> {
  const strict = options.strict === true;
  const spec: SandboxRunSpec = {
    argv: [options.pythonPath, "-m", "compileall", "-q", "."],
    files: [...input.files.entries()].map(([path, content]) => ({ path, content })),
    timeoutMs: options.timeoutMs ?? 120000,
    stdoutCapBytes: 4 * 1024 * 1024,
    stderrCapBytes: 1024 * 1024,
    // compileall compiles untrusted source with the trusted interpreter; it never
    // imports user modules, but it is still executed through the sandbox.
    requireNetworkIsolation: true,
    ...(strict ? { strict: true, containerArgv: ["python3", "-m", "compileall", "-q", "."] } : {}),
  };
  return classifyBuildRun(await runSpec(options, spec), "Python");
}

function runSpec(options: S4Options, spec: SandboxRunSpec): Promise<SandboxRunResult> {
  if (options.run !== undefined) return options.run(spec);
  const runner = new SandboxRunner({
    capabilities: options.capabilities,
    ...(options.container === undefined ? {} : { container: options.container }),
  });
  return runner.run(spec).catch((error: unknown) => {
    if (error instanceof SandboxIsolationError) {
      return {
        outcome: "spawn-failed" as const,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: error.message,
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 0,
        workspacePath: "",
      };
    }
    throw error;
  });
}

function classifyBuildRun(result: SandboxRunResult, label: string): StageResult {
  if (result.outcome === "timeout") {
    return {
      stage: "S4-build",
      status: "skipped",
      reason: `${label} build timed out (infrastructure)`,
      details: [],
    };
  }
  if (result.outcome === "output-limit") {
    return {
      stage: "S4-build",
      status: "skipped",
      reason: `${label} build output exceeded the sandbox cap (infrastructure)`,
      details: [],
    };
  }
  if (result.outcome === "spawn-failed") {
    return {
      stage: "S4-build",
      status: "skipped",
      reason: `${label} build tool failed to spawn: ${result.stderr.slice(0, 300)}`,
      details: [],
    };
  }
  if (result.outcome === "container-error") {
    return {
      stage: "S4-build",
      status: "skipped",
      reason: `${label} build container failed to start: ${result.stderr.slice(0, 300)}`,
      details: [],
    };
  }
  if (result.exitCode === 0) {
    return { stage: "S4-build", status: "pass", reason: null, details: [] };
  }
  const diagnostics = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    // tsc prints `file(line,col): error ...`; normalize the path prefix so repair
    // attribution can match the emitted target exactly.
    .map((line) => line.replace(/^([^():\s]+)\(\d+,\d+\):/, "$1:"))
    .slice(0, 10);
  return {
    stage: "S4-build",
    status: "fail",
    reason: `${label} build failed (exit ${String(result.exitCode)})`,
    details: diagnostics,
  };
}
