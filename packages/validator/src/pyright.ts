// Pyright S2 adapter (roadmap M7 WS E): type validation for generated PYTHON
// output through the pinned pyright CLI (`--outputjson`, D-005/D-024). The adapter
// maps structured diagnostics onto the StageResult contract with honest
// skipped(reason) when the checker cannot run — a successful verdict is NEVER
// reported without executing pyright.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { StageResult } from "@ctrans/core";

const exec = promisify(execFile);

export interface PyrightValidatorOptions {
  // Absolute path to the pyright CLI entry (node_modules/pyright/pyright); the
  // CLI wiring resolves it from the pinned dependency.
  readonly pyrightPath: string;
  // Node executable to spawn it with (pyright's CLI is a JS shim).
  readonly nodePath: string;
  readonly timeoutMs?: number;
}

export class PyrightTypeValidator {
  private readonly options: PyrightValidatorOptions;

  // Explicit field (not a parameter property): the unbuilt CLI runs sources
  // through Node strip-only mode, which rejects transform-only syntax.
  constructor(options: PyrightValidatorOptions) {
    this.options = options;
  }

  async validate(files: readonly { path: string; content: string }[]): Promise<StageResult> {
    const pyFiles = files.filter((file) => file.path.endsWith(".py"));
    if (pyFiles.length === 0) {
      return {
        stage: "S2-types",
        status: "skipped",
        reason: "no Python output files to validate",
        details: [],
      };
    }
    // Pyright analyzes FILES: materialize the emitted project into a fresh temp
    // workspace (owned; removed after the run) preserving the relative layout so
    // intra-project imports resolve.
    const workspace = mkdtempSync(join(tmpdir(), "ctrans-pyright-"));
    try {
      for (const file of pyFiles) {
        const destination = join(workspace, file.path);
        mkdirSync(join(destination, ".."), { recursive: true });
        writeFileSync(destination, file.content);
      }
      const result = await this.runPyright(workspace, ["--outputjson", "--level", "error", "."]);
      if (result.kind === "skipped") {
        return { stage: "S2-types", status: "skipped", reason: result.reason, details: [] };
      }
      const diagnostics = parsePyrightJson(result.stdout);
      if (diagnostics === null) {
        return {
          stage: "S2-types",
          status: "skipped",
          reason: "pyright produced no parseable JSON report",
          details: [result.stdout.slice(0, 500), result.stderr.slice(0, 500)],
        };
      }
      const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      if (errors.length > 0) {
        return {
          stage: "S2-types",
          status: "fail",
          reason: `${String(errors.length)} pyright error(s)`,
          details: errors.slice(0, 20).map((error) => `${error.file}: ${error.message}`),
        };
      }
      return { stage: "S2-types", status: "pass", reason: null, details: [] };
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  private async runPyright(
    cwd: string,
    args: readonly string[],
  ): Promise<
    { kind: "completed"; stdout: string; stderr: string } | { kind: "skipped"; reason: string }
  > {
    const timeoutMs = this.options.timeoutMs ?? 120000;
    try {
      // pyright exits nonzero when it FINDS errors — that's data, not
      // infrastructure failure. The rejected error carries stdout/stderr.
      const { stdout, stderr } = await exec(
        this.options.nodePath,
        [this.options.pyrightPath, ...args],
        {
          cwd,
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: 16 * 1024 * 1024,
          env: {
            PATH: process.env["PATH"] ?? "/usr/bin:/bin",
            HOME: cwd,
            LANG: "C.UTF-8",
            // No telemetry, no network: pyright runs offline on the materialized
            // project (no config file is provided).
          },
        },
      );
      return { kind: "completed", stdout, stderr };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      if (err.code === "ENOENT") {
        return {
          kind: "skipped",
          reason: `pyright failed to spawn (${String(err.message).slice(0, 200)})`,
        };
      }
      if (err.killed === true) {
        return { kind: "skipped", reason: `pyright exceeded ${String(timeoutMs)}ms` };
      }
      if ((err.stdout ?? "") === "" && (err.stderr ?? "") !== "") {
        return { kind: "skipped", reason: `pyright crashed: ${String(err.stderr).slice(0, 300)}` };
      }
      // Diagnostics found (nonzero exit WITH output) — completed data.
      return { kind: "completed", stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  }
}

export interface PyrightDiagnostic {
  readonly file: string;
  readonly severity: string;
  readonly message: string;
  readonly rule: string | null;
  readonly line: number;
}

// Tolerant parse of pyright's --outputjson envelope (semi-stable shape, D-005).
export function parsePyrightJson(stdout: string): PyrightDiagnostic[] | null {
  try {
    const report = JSON.parse(stdout) as {
      generalDiagnostics?: {
        file?: string;
        severity?: string;
        message?: string;
        rule?: string | null;
        range?: { start?: { start?: { line?: number; character?: number } } };
      }[];
    };
    const diagnostics = report.generalDiagnostics ?? [];
    return diagnostics.map((diagnostic) => ({
      file: (diagnostic.file ?? "").replace(/^.*\//, ""),
      severity: diagnostic.severity ?? "error",
      message: diagnostic.message ?? "",
      rule: diagnostic.rule ?? null,
      line: (diagnostic.range?.start?.start?.line ?? -1) + 1,
    }));
  } catch {
    return null;
  }
}

// Resolve the pinned pyright CLI entry (bin "pyright" → index.js) from the
// toolchain's node_modules.
export function pyrightEntryPath(from: string): string {
  const require = createRequire(from);
  const packageJson = require.resolve("pyright/package.json");
  return join(packageJson.replace(/package\.json$/, ""), "index.js");
}
