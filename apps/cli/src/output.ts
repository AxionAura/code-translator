// CLI output discipline (M11): machine-readable JSON stays on stdout and nothing
// else does. Human diagnostics and progress go to stderr, so `--json` output can be
// piped safely. Progress defaults to TTY-only and never waits for input.
export type ProgressMode = "auto" | "none" | "text" | "json";

export interface ProgressEvent {
  readonly event: string;
  readonly message: string;
  readonly stage?: string;
  readonly status?: string;
}

export interface OutputOptions {
  readonly json: boolean;
  readonly progress: ProgressMode;
  readonly stderrIsTty: boolean;
}

export function outputOptionsFrom(
  values: { json: boolean; progress: ProgressMode | undefined },
  stderrIsTty = process.stderr.isTTY === true,
): OutputOptions {
  return {
    json: values.json,
    progress: values.progress ?? "auto",
    stderrIsTty,
  };
}

export function jsonOutput(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

// Collects progress lines for CliResult.stderr (the CLI returns strings rather
// than writing directly, keeping stream behavior testable). `auto` only emits on
// a TTY; CI and piped runs stay quiet unless explicitly requested.
export function createProgressCollector(options: OutputOptions): {
  readonly emit: (event: ProgressEvent) => void;
  readonly text: () => string;
} {
  const lines: string[] = [];
  return {
    emit: (event) => {
      if (options.progress === "none" || (options.progress === "auto" && !options.stderrIsTty)) {
        return;
      }
      const stage = event.stage === undefined ? "" : `[${event.stage}] `;
      lines.push(options.progress === "json" ? JSON.stringify(event) : `${stage}${event.message}`);
    },
    text: () => (lines.length === 0 ? "" : lines.join("\n") + "\n"),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
