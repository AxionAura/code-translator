// CLI (M0 foundation + M4 translation commands). Unsupported constructs and
// validation gaps are reported honestly; exit codes follow the claim ladder:
// 0 = translated, 3 = partially translated (unsupported constructs), 1 = failure.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CTransError } from "@ctrans/core";
import {
  detectCapabilities,
  detectContainerCapabilities,
  validateContainerOptions,
  type ContainerRunOptions,
} from "@ctrans/sandbox";
import { DisabledRepairProposer } from "@ctrans/repair";
import type { SmokeHarness } from "@ctrans/validator";

import { buildAiWiring, summarizeAiJournal } from "./ai-wiring.ts";
import { runDoctor } from "./doctor.ts";

import { runProject } from "./project-run.ts";
import { summarizeRepair, translateWithRepair } from "./repair-run.ts";
import { runnerToolchain } from "./toolchain.ts";
import { checkPath, summarize, translatePath } from "./translate.ts";

export { runnerToolchain } from "./toolchain.ts";

const HELP_TEXT = `ctrans - translate code between Python, JavaScript, and TypeScript

Usage: ctrans <command> [options]

Commands:
  check <path> --to <ts|js>       Analyze and validate without writing output
  translate <path> --to <ts|js> [-o <dir>]
                                  Translate a file or directory of Python sources
  project <src-dir> --to ts -o <out-dir>
                                  Translate a whole project (sources + pytest
                                  modules) and validate S1-S7 in the sandbox
  doctor                          Report observed environment capabilities
                                  (runtimes, validators, bwrap, docker/podman,
                                  gVisor) and exit 1 if a required one is missing
  --no-tests                      Skip S5/S6 execution (translation only)

Options:
  --int-mode <number|bigint>      Integer policy (D-006): number = default with
                                  precision warnings; bigint = exact Python ints
  --repair                        Run the bounded repair loop (3 attempts/unit,
                                  8/run). translate re-validates S1-S3; project
                                  re-validates the real S1-S6 path and refuses
                                  when behavioral validation cannot run. Needs
                                  --ai-provider; without AI the run reports
                                  repair-unavailable. History: .ctrans/repairs/
  --smoke <harness.json>          Project mode: opt-in S7 smoke harness executed
                                  in the sandbox (project --smoke)
  --strict                        Project mode: run executed stages in a Docker/
                                  Podman container (gVisor optional); refuses to
                                  fall back to the host
  --sandbox-image <image>         Container image for --strict (or env
                                  CTRANS_SANDBOX_IMAGE). Pulling is disabled.
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
  repair: boolean;
  strict: boolean;
  sandboxImage: string | undefined;
  smoke: string | undefined;
  aiProvider: string | undefined;
  aiModel: string | undefined;
  aiBaseUrl: string | undefined;
} {
  const positional: string[] = [];
  let to: string | undefined;
  let out: string | undefined;
  let intMode: "number" | "bigint" = "number";
  let noTests = false;
  let repair = false;
  let strict = false;
  let sandboxImage: string | undefined;
  let smoke: string | undefined;
  let aiProvider: string | undefined;
  let aiModel: string | undefined;
  let aiBaseUrl: string | undefined;
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
    } else if (arg === "--repair") {
      repair = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--sandbox-image") {
      sandboxImage = argv[i + 1];
      i += 1;
    } else if (arg === "--smoke") {
      smoke = argv[i + 1];
      i += 1;
    } else if (arg === "--ai-provider") {
      aiProvider = argv[i + 1];
      i += 1;
    } else if (arg === "--ai-model") {
      aiModel = argv[i + 1];
      i += 1;
    } else if (arg === "--ai-base-url") {
      aiBaseUrl = argv[i + 1];
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return {
    positional,
    to,
    out,
    intMode,
    noTests,
    repair,
    strict,
    sandboxImage,
    smoke,
    aiProvider,
    aiModel,
    aiBaseUrl,
  };
}

async function runTranslation(
  command: "check" | "translate",
  rest: readonly string[],
): Promise<CliResult> {
  const {
    positional,
    to,
    out,
    intMode,
    repair,
    strict,
    sandboxImage,
    smoke,
    aiProvider,
    aiModel,
    aiBaseUrl,
  } = parseOptions(rest);
  const sourcePath = positional[0];
  if (sourcePath === undefined || (to !== "ts" && to !== "js" && to !== "py")) {
    return {
      code: 2,
      stdout: "",
      stderr: `ctrans: ${command} requires a path and --to <ts|js> (run \`ctrans --help\`)\n`,
    };
  }
  if (repair && command === "check") {
    return {
      code: 2,
      stdout: "",
      stderr: "ctrans: --repair is only available for `translate` (it writes the accepted state)\n",
    };
  }
  if (strict || sandboxImage !== undefined || smoke !== undefined) {
    return {
      code: 2,
      stdout: "",
      stderr: "ctrans: --strict, --sandbox-image, and --smoke are only available for `project`\n",
    };
  }
  const target = to === "ts" ? "typescript" : to === "py" ? "python" : "javascript";
  try {
    const ai = buildAiWiring({
      ...(aiProvider === undefined ? {} : { provider: aiProvider }),
      ...(aiModel === undefined ? {} : { model: aiModel }),
      ...(aiBaseUrl === undefined ? {} : { baseUrl: aiBaseUrl }),
    });
    if (command === "translate" && repair) {
      const outcome = await translateWithRepair({
        sourcePath,
        target,
        outputDir: out ?? "out",
        intMode,
        proposer: ai?.repairProposer ?? new DisabledRepairProposer(),
        ...(ai === null ? {} : { resolver: ai.resolver }),
      });
      if (ai !== null) {
        const journalDir = join(out ?? "out", ".ctrans");
        mkdirSync(journalDir, { recursive: true });
        writeFileSync(join(journalDir, "ai-journal.json"), ai.journal.toJson());
      }
      const partiallyTranslated = outcome.report.files.some(
        (file) => file.status === "partially-translated",
      );
      const failed = outcome.report.files.some((file) => file.status === "failed");
      const aiSummary = ai !== null ? `${summarizeAiJournal(ai.journal)}\n` : "";
      return {
        // A repair infrastructure error is a real failure even though the
        // deterministic output stays byte-identical.
        code:
          failed || outcome.repair.stopReason === "validation-error"
            ? 1
            : partiallyTranslated
              ? 3
              : 0,
        stdout: `${summarize({ report: outcome.report, files: new Map() })}\n${aiSummary}${outcome.summary}\n`,
        stderr: "",
      };
    }
    const outcome =
      command === "check"
        ? await checkPath(sourcePath, target, intMode, ai?.resolver)
        : await translatePath(sourcePath, target, out ?? "out", intMode, ai?.resolver);
    if (ai !== null && command === "translate") {
      const journalDir = join(out ?? "out", ".ctrans");
      mkdirSync(journalDir, { recursive: true });
      writeFileSync(join(journalDir, "ai-journal.json"), ai.journal.toJson());
    }
    const partiallyTranslated = outcome.report.files.some(
      (file) => file.status === "partially-translated",
    );
    const failed = outcome.report.files.some((file) => file.status === "failed");
    const aiSummary = ai !== null ? `${summarizeAiJournal(ai.journal)}\n` : "";
    return {
      code: failed ? 1 : partiallyTranslated ? 3 : 0,
      stdout: `${summarize(outcome)}\n${aiSummary}`,
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

// The runner toolchain is defined in toolchain.ts and re-exported above for the
// project-runner tests and external wiring.

async function runProjectCommand(rest: readonly string[]): Promise<CliResult> {
  const {
    positional,
    to,
    out,
    intMode,
    noTests,
    repair,
    strict,
    sandboxImage,
    smoke,
    aiProvider,
    aiModel,
    aiBaseUrl,
  } = parseOptions(rest);
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
  if (sandboxImage !== undefined && !strict) {
    return {
      code: 2,
      stdout: "",
      stderr: "ctrans: --sandbox-image requires --strict\n",
    };
  }
  const target = to === "ts" ? "typescript" : to === "py" ? "python" : "javascript";
  try {
    const sandbox = await detectCapabilities();
    const toolchain = runnerToolchain();
    const ai = buildAiWiring({
      ...(aiProvider === undefined ? {} : { provider: aiProvider }),
      ...(aiModel === undefined ? {} : { model: aiModel }),
      ...(aiBaseUrl === undefined ? {} : { baseUrl: aiBaseUrl }),
    });
    const container = strict ? await resolveStrictContainer(sandboxImage) : undefined;
    const smokeHarness = smoke === undefined ? undefined : loadSmokeHarness(smoke);
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
      typescriptEntryPath: toolchain.typescriptEntryPath,
      ...(strict ? { strict: true } : {}),
      ...(container === undefined ? {} : { container }),
      ...(smokeHarness === undefined ? {} : { smoke: smokeHarness }),
      ...(repair
        ? { repair: { proposer: ai?.repairProposer ?? new DisabledRepairProposer() } }
        : {}),
      ...(ai === null ? {} : { resolveAmbiguity: ai.resolver }),
    });
    if (ai !== null) {
      const journalDir = join(out, ".ctrans");
      mkdirSync(journalDir, { recursive: true });
      writeFileSync(join(journalDir, "ai-journal.json"), ai.journal.toJson());
    }
    const lines: string[] = [summarize({ report: result.pipeline.report, files: new Map() })];
    for (const skip of result.skipped) lines.push(`skipped: ${skip.what} (${skip.reason})`);
    for (const unsupported of result.unsupportedTestConstructs) {
      lines.push(`unsupported test construct: ${unsupported.file}: ${unsupported.reason}`);
    }
    if (result.s5 !== null) {
      lines.push(
        `S5 tests: ${result.s5.status} (${String(result.s5.outcomes.length)} outcome(s)${
          result.s5.flaky.length > 0 ? `, ${String(result.s5.flaky.length)} flaky` : ""
        })`,
      );
    }
    if (result.s6 !== null) {
      lines.push(`differential: ${result.s6.matched.length} matched (claim level 5 evidence)`);
    }
    if (result.s7 !== null) {
      lines.push(
        `smoke: ${result.s7.status}${result.s7.reason === null ? "" : ` (${result.s7.reason})`}`,
      );
    }
    if (ai !== null) lines.push(summarizeAiJournal(ai.journal));
    if (result.repair !== null && result.repairJournal !== null) {
      lines.push(
        summarizeRepair(
          result.repair,
          result.repairJournal,
          result.repairJournalRecovered,
          result.pipeline.report.claimLevel,
        ),
      );
    }
    const failed = result.pipeline.report.files.some((file) => file.status === "failed");
    const repairInfrastructureFailure =
      result.repair !== null &&
      (result.repair.stopReason === "validation-error" ||
        result.repair.stopReason === "validation-unavailable");
    return {
      code: failed || repairInfrastructureFailure ? 1 : 0,
      stdout: `${lines.join("\n")}\n`,
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

async function resolveStrictContainer(imageFlag: string | undefined): Promise<ContainerRunOptions> {
  const containers = await detectContainerCapabilities();
  const runtime = containers.usable;
  if (runtime === null) {
    throw new CTransError(
      "SANDBOX-STRICT-UNAVAILABLE",
      `--strict requires a usable Docker/Podman runtime; docker: ${containers.docker.unavailableReason ?? "unavailable"}; podman: ${containers.podman.unavailableReason ?? "unavailable"}`,
    );
  }
  const image = imageFlag ?? process.env["CTRANS_SANDBOX_IMAGE"];
  if (image === undefined || image === "") {
    throw new CTransError(
      "SANDBOX-STRICT-IMAGE-MISSING",
      "--strict requires a container image that provides the validation toolchain; pass --sandbox-image or set CTRANS_SANDBOX_IMAGE (image pulls are disabled)",
    );
  }
  const gvisorRequested = process.env["CTRANS_SANDBOX_GVISOR"] === "1";
  if (gvisorRequested && !containers.gvisor.available) {
    throw new CTransError(
      "SANDBOX-STRICT-GVISOR-UNAVAILABLE",
      "gVisor execution was requested (CTRANS_SANDBOX_GVISOR=1) but runsc is not available",
    );
  }
  const container: ContainerRunOptions = {
    runtime: runtime.kind,
    runtimePath: runtime.path,
    image,
    gvisor: {
      requested: gvisorRequested,
      available: containers.gvisor.available,
      runtimeName: containers.gvisor.runtimeName,
    },
  };
  try {
    validateContainerOptions(container);
  } catch (error) {
    throw new CTransError(
      "SANDBOX-STRICT-INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
  return container;
}

function loadSmokeHarness(path: string): SmokeHarness {
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
    throw new CTransError(
      "VALIDATION-SMOKE-INVALID",
      `smoke harness manifest exceeds 64 KiB: ${path}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new CTransError("VALIDATION-SMOKE-INVALID", `smoke harness is not valid JSON: ${path}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CTransError("VALIDATION-SMOKE-INVALID", "smoke harness must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const argv = record["argv"];
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv.every((entry): entry is string => typeof entry === "string" && entry !== "")
  ) {
    throw new CTransError(
      "VALIDATION-SMOKE-INVALID",
      "smoke harness argv must be a non-empty array of strings",
    );
  }
  const files = record["files"];
  if (files !== undefined) {
    if (!Array.isArray(files)) {
      throw new CTransError("VALIDATION-SMOKE-INVALID", "smoke harness files must be an array");
    }
    for (const file of files) {
      const entry = file as Record<string, unknown> | null;
      if (
        entry === null ||
        typeof entry !== "object" ||
        typeof entry["path"] !== "string" ||
        typeof entry["content"] !== "string"
      ) {
        throw new CTransError(
          "VALIDATION-SMOKE-INVALID",
          "smoke harness files need string path/content",
        );
      }
    }
  }
  return {
    argv: argv as string[],
    ...(typeof record["stdin"] === "string" ? { stdin: record["stdin"] } : {}),
    ...(typeof record["expectedExitCode"] === "number"
      ? { expectedExitCode: record["expectedExitCode"] }
      : {}),
    ...(typeof record["expectedStdout"] === "string"
      ? { expectedStdout: record["expectedStdout"] }
      : {}),
    ...(typeof record["stdoutIncludes"] === "string"
      ? { stdoutIncludes: record["stdoutIncludes"] }
      : {}),
    ...(typeof record["timeoutMs"] === "number" ? { timeoutMs: record["timeoutMs"] } : {}),
    ...(files === undefined ? {} : { files: files as NonNullable<SmokeHarness["files"]> }),
  };
}

export async function runCliCommand(argv: readonly string[]): Promise<CliResult> {
  const [command, ...rest] = argv;
  if (command === "check" || command === "translate") {
    return runTranslation(command, rest);
  }
  if (command === "project") {
    return runProjectCommand(rest);
  }
  if (command === "doctor") {
    return runDoctor();
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
