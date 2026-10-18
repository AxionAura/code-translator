// CLI (M0 foundation + M4 translation commands). Unsupported constructs and
// validation gaps are reported honestly; exit codes follow the claim ladder:
// 0 = translated, 3 = partially translated (unsupported constructs), 1 = failure.
import { readFileSync } from "node:fs";

import { checkPath, summarize, translatePath } from "./translate.ts";

const HELP_TEXT = `ctrans - translate code between Python, JavaScript, and TypeScript

Usage: ctrans <command> [options]

Commands:
  check <path> --to <ts|js>       Analyze and validate without writing output
  translate <path> --to <ts|js> [-o <dir>]
                                  Translate a file or directory of Python sources

Options:
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
} {
  const positional: string[] = [];
  let to: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--to") {
      to = argv[i + 1];
      i += 1;
    } else if (arg === "-o" || arg === "--out") {
      out = argv[i + 1];
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { positional, to, out };
}

async function runTranslation(
  command: "check" | "translate",
  rest: readonly string[],
): Promise<CliResult> {
  const { positional, to, out } = parseOptions(rest);
  const sourcePath = positional[0];
  if (sourcePath === undefined || (to !== "ts" && to !== "js")) {
    return {
      code: 2,
      stdout: "",
      stderr: `ctrans: ${command} requires a path and --to <ts|js> (run \`ctrans --help\`)\n`,
    };
  }
  const target = to === "ts" ? "typescript" : "javascript";
  try {
    const outcome =
      command === "check"
        ? await checkPath(sourcePath, target)
        : await translatePath(sourcePath, target, out ?? "out");
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

export async function runCliCommand(argv: readonly string[]): Promise<CliResult> {
  const [command, ...rest] = argv;
  if (command === "check" || command === "translate") {
    return runTranslation(command, rest);
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
