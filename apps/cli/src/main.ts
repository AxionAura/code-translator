// CLI (M0 foundation + M4 translation commands). Unsupported constructs and
// validation gaps are reported honestly; exit codes follow the claim ladder:
// 0 = translated, 3 = partially translated (unsupported constructs), 1 = failure.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { detectCapabilities } from "@ctrans/sandbox";

import { runProject } from "./project-run.ts";
import { checkPath, summarize, translatePath } from "./translate.ts";

const HELP_TEXT = `ctrans - translate code between Python, JavaScript, and TypeScript

Usage: ctrans <command> [options]

Commands:
  check <path> --to <ts|js>       Analyze and validate without writing output
  translate <path> --to <ts|js> [-o <dir>]
                                  Translate a file or directory of Python sources
  project <src-dir> --to ts -o <out-dir>
                                  Translate a whole project (sources + pytest
                                  modules) and validate it in the sandbox:
                                  S5 translated tests + S6 differential run
  --no-tests                      Skip S5/S6 execution (translation only)

Options:
  --int-mode <number|bigint>      Integer policy (D-006): number = default with
                                  precision warnings; bigint = exact Python ints
  -v, --version                   Print the CLI version
  -h, --help                      Print this help text
`;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function cliVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    version: string;
  };
  return manifest.version;
}

function parseOptions(argv: readonly string[]): {
  positional: string[];
  to: string | undefined;
  out: string | undefined;
  intMode: "number" | "bigint";
  noTests: boolean;
} {
  const positional: string[] = [];
  let to: string | undefined;
  let out: string | undefined;
  let intMode: "number" | "bigint" = "number";
  let noTests = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--to") {
      to = argv[i + 1];
      i += 1;
    } else if (arg === "-o" || arg === "--out") {
      out = argv[i + 1];
      i += 1;
    } else if (arg === "--int-mode") {
      const value = argv[i + 1];
      if (value === "bigint" || value === "number") intMode = value;
      i += 1;
    } else if (arg === "--no-tests") {
      noTests = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, to, out, intMode, noTests };
}

async function runTranslation(
  command: "check" | "translate",
  rest: readonly string[],
): Promise<CliResult> {
  const { positional, to, out, intMode } = parseOptions(rest);
  const sourcePath = positional[0];
  if (sourcePath === undefined || (to !== "ts" && to !== "js" && to !== "py")) {
    return {
      code: 2,
      stdout: "",
      stderr: `ctrans: ${command} requires a path and --to <ts|js> (run \`ctrans --help\`)\n`,
    };
  }
  const target = to === "ts" ? "typescript" : to === "py" ? "python" : "javascript";
  try {
    const outcome =
      command === "check"
        ? await checkPath(sourcePath, target, intMode)
        : await translatePath(sourcePath, target, out ?? "out", intMode);
    const partiallyTranslated = outcome.report.files.some(
      (file) => file.status === "partially-translated",
    );
    const failed = outcome.report.files.some((file) => file.status === "failed");
    return {
      code: failed ? 1 : partiallyTranslated ? 3 : 0,
      stdout: `${summarize(outcome)}\n`,
      stderr: "",
    };
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: `ctrans: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

// The runner toolchain the sandbox reuses (nothing is installed at validation
// time): the repo's node_modules and the vitest CLI entry inside it. Exposed for
// the project-runner tests.
export function runnerToolchain(): { nodeModulesPath: string; vitestEntryPath: string } {
  const require = createRequire(import.meta.url);
  const vitestPackageJson = require.resolve("vitest/package.json");
  const nodeModulesPath = dirname(dirname(vitestPackageJson));
  return { nodeModulesPath, vitestEntryPath: join(nodeModulesPath, "vitest", "vitest.mjs") };
}

async function runProjectCommand(rest: readonly string[]): Promise<CliResult> {
  const { positional, to, out, intMode, noTests } = parseOptions(rest);
  const sourceRoot = positional[0];
  if (
    sourceRoot === undefined ||
    (to !== "ts" && to !== "js" && to !== "py") ||
    out === undefined
  ) {
    return {
      code: 2,
      stdout: "",
      stderr:
        "ctrans: project requires a source directory, --to <ts|js|py>, and -o <output-dir> (run `ctrans --help`)\n",
    };
  }
  const target = to === "ts" ? "typescript" : to === "py" ? "python" : "javascript";
  try {
    const sandbox = await detectCapabilities();
    const toolchain = runnerToolchain();
    const result = await runProject({
      sourceRoot,
      outputRoot: out,
      target,
      intMode,
      ...(noTests ? { runTests: false } : {}),
      sandbox,
      nodePath: process.execPath,
      pythonPath: "python3",
      nodeModulesPath: toolchain.nodeModulesPath,
      vitestEntryPath: toolchain.vitestEntryPath,
    });
    const lines: string[] = [summarize({ report: result.pipeline.report, files: new Map() })];
    for (const skip of result.skipped) lines.push(`skipped: ${skip.what} (${skip.reason})`);
    for (const unsupported of result.unsupportedTestConstructs) {
      lines.push(`unsupported test construct: ${unsupported.file}: ${unsupported.reason}`);
    }
    if (result.s6 !== null) {
      lines.push(`differential: ${result.s6.matched.length} matched (claim level 5 evidence)`);
    }
    const failed = result.pipeline.report.files.some((file) => file.status === "failed");
    return { code: failed ? 1 : 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: `ctrans: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

export async function runCliCommand(argv: readonly string[]): Promise<CliResult> {
  const [command, ...rest] = argv;
  if (command === "check" || command === "translate") {
    return runTranslation(command, rest);
  }
  if (command === "project") {
    return runProjectCommand(rest);
  }
  if (command === "-v" || command === "--version") {
    return { code: 0, stdout: `${cliVersion()}\n`, stderr: "" };
  }
  if (command === undefined || command === "-h" || command === "--help") {
    return { code: 0, stdout: HELP_TEXT, stderr: "" };
  }
  return { code: 2, stdout: "", stderr: `ctrans: unknown command "${String(command)}"\n` };
}

// Synchronous facade kept for the M0 contract (help/version only); translation
// commands are async and go through runCliCommand.
export function runCli(argv: readonly string[]): CliResult {
  const [command] = argv;
  if (command === undefined || command === "-h" || command === "--help") {
    return { code: 0, stdout: HELP_TEXT, stderr: "" };
  }
  if (command === "-v" || command === "--version") {
    return { code: 0, stdout: `${cliVersion()}\n`, stderr: "" };
  }
  return {
    code: 2,
    stdout: "",
    stderr: `ctrans: use the async runCliCommand for translation commands\n`,
  };
}
