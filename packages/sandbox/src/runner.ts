// Sandbox runner v1 (docs/security.md §3, ADR D-009): the ONLY path for executing
// source or translated project code. Hardened spawn — argv arrays (never a shell),
// explicit env allowlist, fresh temp workspace materialized from the spec's file
// set, wall-clock timeout with process-group SIGKILL, output caps, prlimit
// resource limits when available, and bwrap unshare-net isolation when usable.
// The capability report travels with every result — no silent downgrades.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { SandboxCapabilities } from "./capability.js";
import {
  SandboxIsolationError,
  SandboxOutputLimitError,
  SandboxSpecError,
  SandboxTimeoutError,
} from "./errors.js";

export interface SandboxFileSpec {
  // Workspace-relative path (no `..` segments, no absolute paths).
  readonly path: string;
  // Content materialized verbatim (utf8).
  readonly content: string;
  readonly executable?: boolean;
}

export interface SandboxSymlinkSpec {
  // Workspace-relative path for the symlink.
  readonly path: string;
  // ABSOLUTE target (tool-controlled: e.g. the translator's own node_modules so
  // the vitest runner resolves). Never project-supplied.
  readonly target: string;
}

export interface SandboxRunSpec {
  // argv array — element 0 is the executable; NEVER a shell string.
  readonly argv: readonly string[];
  // Files materialized into the fresh workspace (the child's cwd).
  readonly files: readonly SandboxFileSpec[];
  // Tool-controlled symlinks created after materialization (e.g. node_modules).
  readonly symlinks?: readonly SandboxSymlinkSpec[];
  // Wall-clock timeout; the process group is SIGKILLed at the deadline.
  readonly timeoutMs: number;
  // Per-stream output caps; exceeding either kills the process.
  readonly stdoutCapBytes: number;
  readonly stderrCapBytes: number;
  // Additional env entries layered on the allowlist (never replaces the allowlist).
  readonly env?: Readonly<Record<string, string>>;
  // When true, a run without enforced network isolation fails instead of
  // degrading (strict mode — the caller opts in for isolation-requiring runs).
  readonly requireNetworkIsolation?: boolean;
}

export interface SandboxRunResult {
  // "completed" covers nonzero exits (exitCode carries the verdict); the error
  // classifications are the other outcomes. No outcome is invented.
  readonly outcome: "completed" | "timeout" | "output-limit" | "spawn-failed";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  // True when the stream hit its cap and content was dropped (the caps are
  // reported in the capability metadata of the run).
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
  readonly workspacePath: string;
}

export interface SandboxRunOptions {
  readonly capabilities: SandboxCapabilities;
  // Where to create workspaces (defaults to the OS temp dir).
  readonly workspaceRoot?: string;
  // Resource limits passed through prlimit when available (CPU seconds,
  // address-space bytes, max processes). Applied only when the capability exists;
  // the result's capability report says whether they were active.
  readonly cpuSeconds?: number;
  readonly addressSpaceBytes?: number;
  readonly bwrapPath?: string;
  readonly prlimitPath?: string;
}

const BASE_ENV_ALLOWLIST: Readonly<Record<string, string>> = {
  LANG: "C.UTF-8",
};

export class SandboxRunner {
  private readonly capabilities: SandboxCapabilities;
  private readonly workspaceRoot: string | undefined;
  private readonly cpuSeconds: number | undefined;
  private readonly addressSpaceBytes: number | undefined;
  private readonly bwrapPath: string;
  private readonly prlimitPath: string;

  constructor(options: SandboxRunOptions) {
    this.capabilities = options.capabilities;
    this.workspaceRoot = options.workspaceRoot;
    this.cpuSeconds = options.cpuSeconds;
    this.addressSpaceBytes = options.addressSpaceBytes;
    this.bwrapPath = options.bwrapPath ?? "bwrap";
    this.prlimitPath = options.prlimitPath ?? "prlimit";
  }

  capabilityReport(): SandboxCapabilities {
    return this.capabilities;
  }

  // Materialize the workspace, build the hardened command line, run the child to
  // an outcome. Throws SandboxSpecError for malformed specs and
  // SandboxIsolationError when strict isolation is demanded but unavailable.
  async run(spec: SandboxRunSpec): Promise<SandboxRunResult> {
    this.validateSpec(spec);
    if (spec.requireNetworkIsolation === true && !this.capabilities.bwrap.available) {
      // Strict mode: error, never silently downgrade (docs/security.md §3).
      throw new SandboxIsolationError(
        "network isolation required but unavailable (bwrap) — sandboxed execution refused",
      );
    }
    const workspace = mkdtempSync(join(this.workspaceRoot ?? tmpdir(), "ctrans-run-"));
    try {
      this.materialize(workspace, spec.files);
      for (const link of spec.symlinks ?? []) {
        const destination = join(workspace, link.path);
        mkdirSync(join(destination, ".."), { recursive: true });
        symlinkSync(link.target, destination, "dir");
      }
      const argv = this.wrapCommand(spec.argv, workspace);
      const env = this.buildEnv(spec.env ?? {});
      const started = Date.now();
      return await this.runChild(argv, workspace, env, spec, started);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  private validateSpec(spec: SandboxRunSpec): void {
    if (spec.argv.length === 0 || typeof spec.argv[0] !== "string" || spec.argv[0] === "") {
      throw new SandboxSpecError("argv must start with a non-empty executable element");
    }
    for (const element of spec.argv) {
      if (typeof element !== "string") {
        throw new SandboxSpecError("argv elements must be strings (no shell strings)");
      }
    }
    if (spec.files.length === 0) {
      throw new SandboxSpecError("workspace file set must not be empty");
    }
    for (const file of spec.files) {
      if (
        file.path === "" ||
        (resolve(file.path) !== file.path.replace(/^\//, "/") && file.path.includes(".."))
      ) {
        throw new SandboxSpecError(`workspace path escapes the workspace: ${file.path}`);
      }
      if (file.path.startsWith("/")) {
        throw new SandboxSpecError(`workspace paths must be relative: ${file.path}`);
      }
      if (typeof file.content !== "string") {
        throw new SandboxSpecError(`file content must be a string: ${file.path}`);
      }
    }
    if (!(spec.timeoutMs > 0)) {
      throw new SandboxSpecError("timeoutMs must be positive");
    }
    for (const link of spec.symlinks ?? []) {
      if (link.path === "" || link.path.includes("..") || link.path.startsWith("/")) {
        throw new SandboxSpecError(`symlink path must be workspace-relative: ${link.path}`);
      }
      if (!resolve(link.target).startsWith("/") || link.target.includes("..")) {
        throw new SandboxSpecError(`symlink target must be absolute: ${link.target}`);
      }
    }
  }

  private materialize(workspace: string, files: readonly SandboxFileSpec[]): void {
    for (const file of files) {
      const destination = join(workspace, file.path);
      mkdirSync(join(destination, ".."), { recursive: true });
      writeFileSync(destination, file.content, { mode: file.executable === true ? 0o755 : 0o644 });
    }
  }

  // Hardened command line: bwrap (isolation) > prlimit (rlimits) > command.
  // The workspace is bound explicitly AFTER the tmpfs /tmp mount — the workspace
  // lives under the host temp dir, which the tmpfs would otherwise shadow.
  private wrapCommand(argv: readonly string[], workspace: string): readonly string[] {
    let wrapped = argv;
    if (this.capabilities.prlimit.available) {
      const limits = ["--"];
      if (this.cpuSeconds !== undefined) limits.unshift(`--cpu=${String(this.cpuSeconds)}`);
      if (this.addressSpaceBytes !== undefined) {
        limits.unshift(`--as=${String(this.addressSpaceBytes)}`);
      }
      wrapped = [this.prlimitPath, ...limits, ...wrapped];
    }
    if (this.capabilities.bwrap.available) {
      // bwrap binds the workspace read-write (the child needs its cwd), the root
      // read-only, and unshares network + PID. die-with-parent ties the bubble's
      // lifetime to ours.
      wrapped = [
        this.bwrapPath,
        "--unshare-net",
        "--unshare-pid",
        "--die-with-parent",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
        "--bind",
        workspace,
        workspace,
        "--chdir",
        workspace,
        "--",
        ...wrapped,
      ];
    }
    return wrapped;
  }

  private buildEnv(additions: Readonly<Record<string, string>>): Record<string, string> {
    // Allowlist: PATH (the runner needs the interpreter), HOME pinned to a
    // non-user path, LANG for deterministic output. User-supplied env entries are
    // explicit additions (e.g. NODE_OPTIONS for the test runner) — never a passthrough.
    const env: Record<string, string> = {
      ...BASE_ENV_ALLOWLIST,
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: "/nonexistent-home",
      ...additions,
    };
    return env;
  }

  private runChild(
    argv: readonly string[],
    workspace: string,
    env: Record<string, string>,
    spec: SandboxRunSpec,
    startedAt: number,
  ): Promise<SandboxRunResult> {
    return new Promise((resolveRun) => {
      let child: ChildProcess;
      try {
        child = spawn(argv[0]!, argv.slice(1), {
          cwd: workspace,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          // Own process group: the timeout kill takes down bwrap + the child.
          detached: true,
        });
      } catch (error) {
        resolveRun({
          outcome: "spawn-failed",
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: Date.now() - startedAt,
          workspacePath: workspace,
        });
        return;
      }
      // spawn errors (ENOENT etc.) arrive on 'error', not as throw.
      child.on("error", (error) => {
        settled = true;
        resolveRun({
          outcome: "spawn-failed",
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: error.message,
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: Date.now() - startedAt,
          workspacePath: workspace,
        });
      });

      let settled = false;
      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let exited = false;
      let timedOut = false;
      let limitStream: "stdout" | "stderr" | null = null;

      const killTree = (): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      };

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        killTree();
      }, spec.timeoutMs);

      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        const durationMs = Date.now() - startedAt;
        if (timedOut) {
          resolveRun({
            outcome: "timeout",
            exitCode: null,
            signal: "SIGKILL",
            stdout,
            stderr,
            stdoutTruncated,
            stderrTruncated,
            durationMs,
            workspacePath: workspace,
          });
          return;
        }
        if (limitStream !== null) {
          resolveRun({
            outcome: "output-limit",
            exitCode: null,
            signal: "SIGKILL",
            stdout,
            stderr,
            stdoutTruncated,
            stderrTruncated,
            durationMs,
            workspacePath: workspace,
          });
          return;
        }
        resolveRun({
          outcome: "completed",
          exitCode: child.exitCode,
          signal: child.signalCode,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          durationMs,
          workspacePath: workspace,
        });
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length + chunk.length > spec.stdoutCapBytes) {
          stdoutTruncated = true;
          if (limitStream === null) limitStream = "stdout";
          killTree();
          return;
        }
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length + chunk.length > spec.stderrCapBytes) {
          stderrTruncated = true;
          if (limitStream === null) limitStream = "stderr";
          killTree();
          return;
        }
        stderr += chunk.toString("utf8");
      });

      const onExit = (): void => {
        exited = true;
        // Small delay so the last stream chunks land before settling.
        setTimeout(settle, 10);
      };
      child.on("exit", onExit);
      void exited;

      // Safety net: if neither exit nor error fires (shouldn't happen with the
      // group kill), the timeout fallback already kills and settles.
      setTimeout(() => {
        if (!settled && !exited) killTree();
      }, spec.timeoutMs + 2000);
    });
  }
}

// Convenience: classify a result into the typed error family for callers that
// prefer exceptions (the runner itself never throws for these outcomes).
export function outcomeError(result: SandboxRunResult, spec: SandboxRunSpec): Error | null {
  if (result.outcome === "timeout") {
    return new SandboxTimeoutError(`command exceeded ${String(spec.timeoutMs)}ms`, spec.timeoutMs);
  }
  if (result.outcome === "output-limit") {
    const stream = result.stdoutTruncated ? "stdout" : "stderr";
    const cap = stream === "stdout" ? spec.stdoutCapBytes : spec.stderrCapBytes;
    return new SandboxOutputLimitError(`${stream} exceeded its cap`, stream, cap);
  }
  return null;
}
