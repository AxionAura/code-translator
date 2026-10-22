// Sandbox error taxonomy (docs/security.md §3): every failure mode is a distinct,
// typed classification so validation stages can report honest verdicts instead of
// string-matching stderr. All errors extend CTransError for machine-readable codes.
// Explicit field assignment (not parameter properties): the unbuilt CLI runs
// sources through Node strip-only mode, which rejects transform-only syntax.
import { CTransError } from "@axion-ct/core";

// The sandbox refused/failed to establish its execution boundary.
export class SandboxIsolationError extends CTransError {
  constructor(message: string) {
    super("SB-ISOLATION-UNAVAILABLE", message);
  }
}

// The command exceeded its wall-clock timeout and was killed.
export class SandboxTimeoutError extends CTransError {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super("SB-TIMEOUT", message);
    this.timeoutMs = timeoutMs;
  }
}

// stdout or stderr exceeded its configured cap; the process was killed.
export class SandboxOutputLimitError extends CTransError {
  readonly stream: "stdout" | "stderr";
  readonly capBytes: number;

  constructor(message: string, stream: "stdout" | "stderr", capBytes: number) {
    super("SB-OUTPUT-LIMIT", message);
    this.stream = stream;
    this.capBytes = capBytes;
  }
}

// spawn itself failed (binary missing, cwd missing, permission denied).
export class SandboxSpawnError extends CTransError {
  readonly causeCode: string | undefined;

  constructor(message: string, causeCode: string | undefined) {
    super("SB-SPAWN-FAILED", message, { cause: causeCode });
    this.causeCode = causeCode;
  }
}

// Malformed spec: argv empty, path escapes the workspace, non-object file content.
export class SandboxSpecError extends CTransError {
  constructor(message: string) {
    super("SB-SPEC-INVALID", message);
  }
}
