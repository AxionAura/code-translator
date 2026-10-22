// S7 smoke (docs/validation.md §1): an OPT-IN integration check that runs a
// user-provided harness against the translated project inside the sandbox and
// compares the exit code / stdout. It is outside the claim ladder: a skipped or
// failed smoke stage never raises or lowers the S1-S6 claim, but a failure is
// reported prominently and the run is not presented as integration-verified.
import { CTransError } from "@axion-ct/core";
import type { StageResult } from "@axion-ct/core";
import {
  SandboxIsolationError,
  SandboxRunner,
  type ContainerRunOptions,
  type SandboxCapabilities,
  type SandboxRunResult,
  type SandboxRunSpec,
} from "@axion-ct/sandbox";

import type { SandboxRun } from "./stages.js";

export interface SmokeHarnessFile {
  // Workspace-relative path (validated; no absolute paths or '..').
  readonly path: string;
  readonly content: string;
}

export interface SmokeHarness {
  // Executed inside the sandbox workspace (translated files are the cwd).
  readonly argv: readonly string[];
  readonly stdin?: string;
  // Default 0.
  readonly expectedExitCode?: number;
  // Exact stdout match when provided (normalized trailing newline is preserved).
  readonly expectedStdout?: string;
  // Substring match alternative to expectedStdout.
  readonly stdoutIncludes?: string;
  // Optional user-provided harness files materialized beside the project.
  readonly files?: readonly SmokeHarnessFile[];
  readonly timeoutMs?: number;
}

export interface S7Options {
  readonly capabilities: SandboxCapabilities;
  readonly timeoutMs?: number;
  readonly strict?: boolean;
  readonly container?: ContainerRunOptions;
  readonly run?: SandboxRun;
}

export interface S7Result extends StageResult {
  readonly exitCode: number | null;
  // Captured for the caller's diagnostics only; never written to .ctrans reports.
  readonly stdout: string;
  readonly stderr: string;
}

const MAX_HARNESS_FILES = 20;
const MAX_HARNESS_FILE_BYTES = 64 * 1024;
const MAX_STDIN_BYTES = 64 * 1024;

export async function runS7(
  input: { readonly files: ReadonlyMap<string, string>; readonly harness: SmokeHarness },
  options: S7Options,
): Promise<S7Result> {
  validateHarness(input.harness);
  const files = new Map(input.files);
  for (const file of input.harness.files ?? []) {
    if (files.has(file.path)) {
      throw new CTransError(
        "VALIDATION-SMOKE-CONFLICT",
        `smoke harness file collides with a translated file: ${file.path}`,
      );
    }
    files.set(file.path, file.content);
  }
  const strict = options.strict === true;
  const spec: SandboxRunSpec = {
    argv: input.harness.argv,
    files: [...files.entries()].map(([path, content]) => ({ path, content })),
    timeoutMs: Math.min(
      input.harness.timeoutMs ?? options.timeoutMs ?? 60000,
      options.timeoutMs ?? 60000,
    ),
    stdoutCapBytes: 1024 * 1024,
    stderrCapBytes: 1024 * 1024,
    // Smoke executes translated/user-harness code: enforced isolation is required.
    requireNetworkIsolation: true,
    ...(input.harness.stdin === undefined ? {} : { stdin: input.harness.stdin }),
    ...(strict
      ? {
          strict: true,
          containerArgv: input.harness.argv,
        }
      : {}),
  };
  let result: SandboxRunResult;
  try {
    result =
      options.run !== undefined
        ? await options.run(spec)
        : await new SandboxRunner({
            capabilities: options.capabilities,
            ...(options.container === undefined ? {} : { container: options.container }),
          }).run(spec);
  } catch (error) {
    if (error instanceof SandboxIsolationError) {
      return {
        stage: "S7-smoke",
        status: "skipped",
        reason: `smoke execution refused: ${error.message}`,
        details: [],
        exitCode: null,
        stdout: "",
        stderr: "",
      };
    }
    throw error;
  }
  if (
    result.outcome === "timeout" ||
    result.outcome === "output-limit" ||
    result.outcome === "spawn-failed" ||
    result.outcome === "container-error"
  ) {
    return {
      stage: "S7-smoke",
      status: "skipped",
      reason:
        result.outcome === "timeout"
          ? "smoke harness timed out (infrastructure)"
          : `smoke harness could not run (${result.outcome}): ${result.stderr.slice(0, 300)}`,
      details: [],
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  const expectedExit = input.harness.expectedExitCode ?? 0;
  const exitMatches = result.exitCode === expectedExit;
  const stdoutMatches =
    input.harness.expectedStdout === undefined || result.stdout === input.harness.expectedStdout;
  const includesMatches =
    input.harness.stdoutIncludes === undefined ||
    result.stdout.includes(input.harness.stdoutIncludes);
  const details: string[] = [];
  if (!exitMatches)
    details.push(`expected exit ${String(expectedExit)}, got ${String(result.exitCode)}`);
  if (!stdoutMatches) details.push("stdout did not match the expected exact output");
  if (!includesMatches) details.push("stdout did not include the required text");
  return {
    stage: "S7-smoke",
    status: exitMatches && stdoutMatches && includesMatches ? "pass" : "fail",
    reason:
      exitMatches && stdoutMatches && includesMatches
        ? null
        : "smoke harness behavior did not match the expected result",
    details,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function validateHarness(harness: SmokeHarness): void {
  if (harness.argv.length === 0) {
    throw new CTransError("VALIDATION-SMOKE-INVALID", "smoke argv must not be empty");
  }
  for (const element of harness.argv) {
    if (typeof element !== "string" || element === "") {
      throw new CTransError(
        "VALIDATION-SMOKE-INVALID",
        "smoke argv elements must be non-empty strings",
      );
    }
  }
  const files = harness.files ?? [];
  if (files.length > MAX_HARNESS_FILES) {
    throw new CTransError(
      "VALIDATION-SMOKE-INVALID",
      `smoke harness exceeds ${String(MAX_HARNESS_FILES)} files`,
    );
  }
  for (const file of files) {
    if (file.path === "" || file.path.startsWith("/") || file.path.includes("..")) {
      throw new CTransError(
        "VALIDATION-SMOKE-INVALID",
        `smoke harness path must be workspace-relative without '..': ${file.path}`,
      );
    }
    if (Buffer.byteLength(file.content, "utf8") > MAX_HARNESS_FILE_BYTES) {
      throw new CTransError(
        "VALIDATION-SMOKE-INVALID",
        `smoke harness file exceeds ${String(MAX_HARNESS_FILE_BYTES)} bytes: ${file.path}`,
      );
    }
  }
  if (harness.stdin !== undefined && Buffer.byteLength(harness.stdin, "utf8") > MAX_STDIN_BYTES) {
    throw new CTransError(
      "VALIDATION-SMOKE-INVALID",
      `smoke stdin exceeds ${String(MAX_STDIN_BYTES)} bytes`,
    );
  }
  if (harness.expectedStdout !== undefined && harness.stdoutIncludes !== undefined) {
    throw new CTransError(
      "VALIDATION-SMOKE-INVALID",
      "smoke harness may specify expectedStdout or stdoutIncludes, not both",
    );
  }
}
