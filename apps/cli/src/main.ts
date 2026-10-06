// CLI foundation (M0). Only --help/--version exist; translation commands arrive with
// milestone M4 and must never be stubbed with fake success (AGENTS.md section 11).
import { readFileSync } from "node:fs";

const HELP_TEXT = `ctrans - translate code between Python, JavaScript, and TypeScript

Usage: ctrans [options]

Status: repository foundation only (milestone M0). Translation commands are
implemented starting with milestone M4 (docs/roadmap.md).

Options:
  -v, --version  Print the CLI version
  -h, --help     Print this help text
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

export function runCli(argv: readonly string[]): CliResult {
  const flag = argv[0];
  if (flag === undefined || flag === "-h" || flag === "--help") {
    return { code: 0, stdout: HELP_TEXT, stderr: "" };
  }
  if (flag === "-v" || flag === "--version") {
    return { code: 0, stdout: `${cliVersion()}\n`, stderr: "" };
  }
  return {
    code: 2,
    stdout: "",
    stderr: `ctrans: unknown option "${flag}"; translation commands do not exist yet (run \`ctrans --help\`)\n`,
  };
}
