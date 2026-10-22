// CLI (M0 foundation + M4 translation commands). Unsupported constructs and
// validation gaps are reported honestly; exit codes follow the claim ladder:
// 0 = translated, 3 = partially translated (unsupported constructs), 1 = failure.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { CTransError } from "@axion-ct/core";
import {
  detectCapabilities,
  detectContainerCapabilities,
  validateContainerOptions,
  type ContainerRunOptions,
} from "@axion-ct/sandbox";
import { DisabledRepairProposer } from "@axion-ct/repair";
import type { SmokeHarness } from "@axion-ct/validator";
import { assertStageEvidence, STAGE_ORDER } from "@axion-ct/validator";

import { buildAiWiring, summarizeAiJournal } from "./ai-wiring.js";
import {
  isBenchmarkSuiteName,
  parseBenchmarkResult,
  runBenchmark,
  summarizeBenchmark,
} from "./benchmark.js";
import { discoverConfig, type CliConfig, type LoadedConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import {
  createProgressCollector,
  errorMessage,
  jsonOutput,
  outputOptionsFrom,
  type ProgressMode,
} from "./output.js";

import { runProject } from "./project-run.js";
import { summarizeRepair, translateWithRepair } from "./repair-run.js";
import { runnerToolchain } from "./toolchain.js";
import { checkPath, summarize, translatePath } from "./translate.js";
import { runValidate, summarizeValidation } from "./validate.js";

export { runnerToolchain } from "./toolchain.js";

const HELP_TEXT = `ctrans - translate code between Python, JavaScript, and TypeScript

Usage: ctrans <command> [options]

Commands:
  check <path> [--to <ts|js|py>]  Analyze and validate without writing output
  translate <path> [--to <ts|js|py>] [-o <dir>]
                                  Translate a file or directory of sources
  project <src-dir> --to ts -o <out-dir>
                                  Translate a whole project (sources + pytest
                                  modules) and validate S1-S7 in the sandbox
  validate <target-dir>           Validate an existing target project (S1-S5/S7
                                  where the inputs exist); never executes untrusted
                                  code outside the sandbox
  doctor                          Report observed environment capabilities
                                  (runtimes, validators, bwrap, docker/podman,
                                  gVisor) and exit 1 if a required one is missing
  benchmark [--suite micro|mini-projects|corpus|perf] [--iterations N]
                                  Run reproducible benchmark suites; JSON output
                                  with --json or --results <file>

  --no-tests                      Project: skip S5/S6 execution (translation only)

Options:
  --config <file>                 Load ctrans.config.json (default: discovered
                                  beside the source/target path or in the cwd)
  --int-mode <number|bigint>      Integer policy (D-006): number = default with
                                  precision warnings; bigint = exact Python ints
  --repair                        Run the bounded repair loop (3 attempts/unit,
                                  8/run). translate re-validates S1-S3; project
                                  re-validates the real S1-S6 path and refuses
                                  when behavioral validation cannot run.
  --smoke <harness.json>          Project/validate: opt-in S7 smoke harness
  --strict                        Project/validate: run executed stages in a
                                  Docker/Podman container (no host fallback)
  --sandbox-image <image>         Container image for --strict (or env
                                  CTRANS_SANDBOX_IMAGE). Pulling is disabled.
  --ai-provider <openai|anthropic>
  --ai-model <name>               Provider model (default per provider)
  --ai-base-url <url>             OpenAI-compatible/local endpoint
  --ai-cache <memory|disk>        Response cache scope. "disk" is opt-in: cached
                                  model output may contain code-derived text.
  --json                          Machine-readable JSON on stdout; diagnostics and
                                  progress go to stderr
  --progress <auto|none|text|json>
                                  Progress events on stderr (auto = TTY only)
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
  ) as { version: string };
  return manifest.version;
}

interface ParsedOptions {
  readonly positional: string[];
  readonly error: string | null;
  readonly to: "ts" | "js" | "py" | undefined;
  readonly out: string | undefined;
  readonly intMode: "number" | "bigint" | undefined;
  readonly noTests: boolean;
  readonly repair: boolean;
  readonly strict: boolean;
  readonly sandboxImage: string | undefined;
  readonly smoke: string | undefined;
  readonly config: string | undefined;
  readonly json: boolean;
  readonly progress: ProgressMode | undefined;
  readonly aiProvider: string | undefined;
  readonly aiModel: string | undefined;
  readonly aiBaseUrl: string | undefined;
  readonly aiCache: "memory" | "disk" | undefined;
  readonly suite: string | undefined;
  readonly iterations: number | undefined;
  readonly results: string | undefined;
}

function parseOptions(argv: readonly string[]): ParsedOptions {
  const positional: string[] = [];
  let error: string | null = null;
  let to: "ts" | "js" | "py" | undefined;
  let out: string | undefined;
  let intMode: "number" | "bigint" | undefined;
  let noTests = false;
  let repair = false;
  let strict = false;
  let sandboxImage: string | undefined;
  let smoke: string | undefined;
  let config: string | undefined;
  let json = false;
  let progress: ProgressMode | undefined;
  let aiProvider: string | undefined;
  let aiModel: string | undefined;
  let aiBaseUrl: string | undefined;
  let aiCache: "memory" | "disk" | undefined;
  let suite: string | undefined;
  let iterations: number | undefined;
  let results: string | undefined;
  const value = (index: number, flag: string): string | undefined => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("-")) {
      error ??= `${flag} requires a value`;
      return undefined;
    }
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--to") {
      const next = value(i, "--to");
      i += 1;
      if (next === "ts" || next === "js" || next === "py") to = next;
      else if (next !== undefined) error ??= `--to must be ts, js, or py (got "${next}")`;
    } else if (arg === "-o" || arg === "--out") {
      out = value(i, arg);
      i += 1;
    } else if (arg === "--int-mode") {
      const next = value(i, arg);
      i += 1;
      if (next === "bigint" || next === "number") intMode = next;
      else if (next !== undefined) error ??= `--int-mode must be number or bigint`;
    } else if (arg === "--no-tests") {
      noTests = true;
    } else if (arg === "--repair") {
      repair = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--sandbox-image") {
      sandboxImage = value(i, arg);
      i += 1;
    } else if (arg === "--smoke") {
      smoke = value(i, arg);
      i += 1;
    } else if (arg === "--config") {
      config = value(i, arg);
      i += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--progress") {
      const next = value(i, arg);
      i += 1;
      if (next === "auto" || next === "none" || next === "text" || next === "json") {
        progress = next;
      } else if (next !== undefined) {
        error ??= "--progress must be auto, none, text, or json";
      }
    } else if (arg === "--ai-provider") {
      aiProvider = value(i, arg);
      i += 1;
    } else if (arg === "--ai-model") {
      aiModel = value(i, arg);
      i += 1;
    } else if (arg === "--ai-base-url") {
      aiBaseUrl = value(i, arg);
      i += 1;
    } else if (arg === "--ai-cache") {
      const next = value(i, arg);
      i += 1;
      if (next === "memory" || next === "disk") aiCache = next;
      else if (next !== undefined) error ??= "--ai-cache must be memory or disk";
    } else if (arg === "--suite") {
      suite = value(i, arg);
      i += 1;
    } else if (arg === "--iterations") {
      const next = value(i, arg);
      i += 1;
      const parsed = next === undefined ? Number.NaN : Number(next);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 1000) iterations = parsed;
      else if (next !== undefined) error ??= "--iterations must be an integer 1..1000";
    } else if (arg === "--results") {
      results = value(i, arg);
      i += 1;
    } else if (arg.startsWith("-")) {
      error ??= `unknown option "${arg}" (run \`ctrans --help\`)`;
    } else {
      positional.push(arg);
    }
  }
  return {
    positional,
    error,
    to,
    out,
    intMode,
    noTests,
    repair,
    strict,
    sandboxImage,
    smoke,
    config,
    json,
    progress,
    aiProvider,
    aiModel,
    aiBaseUrl,
    aiCache,
    suite,
    iterations,
    results,
  };
}

interface ResolvedSettings {
  readonly config: LoadedConfig | null;
  readonly to: "ts" | "js" | "py";
  readonly intMode: "number" | "bigint";
  readonly strict: boolean;
  readonly sandboxImage: string | undefined;
  readonly smoke: string | undefined;
  readonly aiProvider: string | undefined;
  readonly aiModel: string | undefined;
  readonly aiBaseUrl: string | undefined;
  readonly aiCache: "memory" | "disk";
}

function resolveSettings(parsed: ParsedOptions, sourcePath: string): ResolvedSettings {
  const config = discoverConfig(sourcePath, parsed.config);
  const file: CliConfig | null = config?.config ?? null;
  const to = parsed.to ?? file?.to;
  if (to === undefined) {
    throw new CTransError(
      "CLI-USAGE",
      "a target is required: pass --to <ts|js|py> or set `to` in ctrans.config.json",
    );
  }
  const configAi = file?.ai;
  const aiProvider =
    parsed.aiProvider ?? (configAi?.enabled === true ? configAi.provider : undefined);
  return {
    config,
    to,
    intMode: parsed.intMode ?? file?.intMode ?? "number",
    strict: parsed.strict || file?.sandbox === "strict",
    sandboxImage: parsed.sandboxImage ?? file?.sandboxImage,
    smoke: parsed.smoke ?? file?.smoke,
    aiProvider,
    aiModel:
      parsed.aiModel ??
      (configAi?.enabled === true && parsed.aiProvider === undefined ? configAi.model : undefined),
    aiBaseUrl:
      parsed.aiBaseUrl ??
      (configAi?.enabled === true && parsed.aiProvider === undefined
        ? configAi.baseUrl
        : undefined),
    aiCache: parsed.aiCache ?? configAi?.cache ?? "memory",
  };
}

function usageResult(message: string, json: boolean): CliResult {
  return {
    code: 2,
    stdout: "",
    stderr: json ? jsonOutput({ error: { code: "CLI-USAGE", message } }) : `ctrans: ${message}\n`,
  };
}

function failureResult(error: unknown, json: boolean, progressText = ""): CliResult {
  const message = errorMessage(error);
  const code = error instanceof CTransError ? error.code : "CLI-ERROR";
  return {
    code: 1,
    stdout: "",
    stderr:
      progressText + (json ? jsonOutput({ error: { code, message } }) : `ctrans: ${message}\n`),
  };
}

async function runTranslation(
  command: "check" | "translate",
  rest: readonly string[],
): Promise<CliResult> {
  const parsed = parseOptions(rest);
  if (parsed.error !== null) return usageResult(parsed.error, parsed.json);
  const sourcePath = parsed.positional[0];
  if (sourcePath === undefined) {
    return usageResult(`${command} requires a source path (run \`ctrans --help\`)`, parsed.json);
  }
  if (parsed.repair && command === "check") {
    return usageResult(
      "--repair is only available for `translate` (it writes the accepted state)",
      parsed.json,
    );
  }
  if (parsed.strict || parsed.sandboxImage !== undefined || parsed.smoke !== undefined) {
    return usageResult(
      "--strict, --sandbox-image, and --smoke are only available for `project` and `validate`",
      parsed.json,
    );
  }
  const output = outputOptionsFrom({ json: parsed.json, progress: parsed.progress });
  const progress = createProgressCollector(output);
  progress.emit({ event: "run:start", message: `${command} started`, status: "running" });
  try {
    const settings = resolveSettings(parsed, sourcePath);
    const target =
      settings.to === "ts" ? "typescript" : settings.to === "py" ? "python" : "javascript";
    const ai = buildAiWiring({
      ...(settings.aiProvider === undefined ? {} : { provider: settings.aiProvider }),
      ...(settings.aiModel === undefined ? {} : { model: settings.aiModel }),
      ...(settings.aiBaseUrl === undefined ? {} : { baseUrl: settings.aiBaseUrl }),
      cache: settings.aiCache,
    });
    const warnings = ai === null ? [] : ai.warnings;
    if (command === "translate" && parsed.repair) {
      progress.emit({ event: "repair:start", message: "bounded repair loop started" });
      const outcome = await translateWithRepair({
        sourcePath,
        target,
        outputDir: parsed.out ?? "out",
        intMode: settings.intMode,
        proposer: ai?.repairProposer ?? new DisabledRepairProposer(),
        ...(ai === null ? {} : { resolver: ai.resolver }),
      });
      if (ai !== null) {
        const journalDir = join(parsed.out ?? "out", ".ctrans");
        mkdirSync(journalDir, { recursive: true });
        writeFileSync(join(journalDir, "ai-journal.json"), ai.journal.toJson());
      }
      const partiallyTranslated = outcome.report.files.some(
        (file) => file.status === "partially-translated",
      );
      const failed = outcome.report.files.some((file) => file.status === "failed");
      const aiSummary = ai !== null ? `${summarizeAiJournal(ai.journal)}\n` : "";
      progress.emit({ event: "run:done", message: "translation finished", status: "done" });
      const stderr = progress.text() + warnings.map((warning) => `warning: ${warning}\n`).join("");
      const code =
        failed || outcome.repair.stopReason === "validation-error"
          ? 1
          : partiallyTranslated
            ? 3
            : 0;
      if (parsed.json) {
        return {
          code,
          stdout: jsonOutput({
            command: "translate",
            target,
            outputDir: parsed.out ?? "out",
            report: outcome.report,
            files: outcome.report.files
              .map((file) => file.target)
              .filter((targetPath): targetPath is string => targetPath !== null),
            repair: {
              stopReason: outcome.repair.stopReason,
              acceptedUnits: outcome.repair.acceptedUnits,
              attempts: outcome.repair.attempts.length,
              journal: outcome.journalPath,
            },
            ai:
              ai === null ? null : { provider: ai.provider, model: ai.model, cache: ai.cacheMode },
            warnings,
          }),
          stderr,
        };
      }
      return {
        code,
        stdout: `${summarize({ report: outcome.report, files: new Map() })}\n${aiSummary}${outcome.summary}\n`,
        stderr,
      };
    }
    const outcome =
      command === "check"
        ? await checkPath(sourcePath, target, settings.intMode, ai?.resolver)
        : await translatePath(
            sourcePath,
            target,
            parsed.out ?? "out",
            settings.intMode,
            ai?.resolver,
          );
    if (ai !== null && command === "translate") {
      const journalDir = join(parsed.out ?? "out", ".ctrans");
      mkdirSync(journalDir, { recursive: true });
      writeFileSync(join(journalDir, "ai-journal.json"), ai.journal.toJson());
    }
    const partiallyTranslated = outcome.report.files.some(
      (file) => file.status === "partially-translated",
    );
    const failed = outcome.report.files.some((file) => file.status === "failed");
    const aiSummary = ai !== null ? `${summarizeAiJournal(ai.journal)}\n` : "";
    progress.emit({ event: "run:done", message: "validation finished", status: "done" });
    const stderr = progress.text() + warnings.map((warning) => `warning: ${warning}\n`).join("");
    const code = failed ? 1 : partiallyTranslated ? 3 : 0;
    if (parsed.json) {
      return {
        code,
        stdout: jsonOutput({
          command,
          target,
          ...(command === "translate" ? { outputDir: parsed.out ?? "out" } : {}),
          report: outcome.report,
          files: [...outcome.files.keys()],
          ai: ai === null ? null : { provider: ai.provider, model: ai.model, cache: ai.cacheMode },
          warnings,
        }),
        stderr,
      };
    }
    return { code, stdout: `${summarize(outcome)}\n${aiSummary}`, stderr };
  } catch (error) {
    if (error instanceof CTransError && error.code === "CLI-USAGE") {
      return usageResult(error.message, parsed.json);
    }
    return failureResult(error, parsed.json, progress.text());
  }
}

// The runner toolchain is defined in toolchain.ts and re-exported above for the
// project-runner tests and external wiring.

async function runProjectCommand(rest: readonly string[]): Promise<CliResult> {
  const parsed = parseOptions(rest);
  if (parsed.error !== null) return usageResult(parsed.error, parsed.json);
  const sourceRoot = parsed.positional[0];
  if (sourceRoot === undefined || parsed.out === undefined) {
    return usageResult(
      "project requires a source directory, --to <ts|js|py>, and -o <output-dir>",
      parsed.json,
    );
  }
  if (parsed.sandboxImage !== undefined && !parsed.strict) {
    return usageResult("--sandbox-image requires --strict", parsed.json);
  }
  if (
    parsed.suite !== undefined ||
    parsed.iterations !== undefined ||
    parsed.results !== undefined
  ) {
    return usageResult("benchmark options are only available for `benchmark`", parsed.json);
  }
  const output = outputOptionsFrom({ json: parsed.json, progress: parsed.progress });
  const progress = createProgressCollector(output);
  progress.emit({ event: "run:start", message: "project translation started", status: "running" });
  try {
    const settings = resolveSettings(parsed, sourceRoot);
    if (settings.sandboxImage !== undefined && !settings.strict) {
      return usageResult('sandboxImage requires sandbox: "strict"', parsed.json);
    }
    const target =
      settings.to === "ts" ? "typescript" : settings.to === "py" ? "python" : "javascript";
    const sandbox = await detectCapabilities();
    const toolchain = runnerToolchain();
    const ai = buildAiWiring({
      ...(settings.aiProvider === undefined ? {} : { provider: settings.aiProvider }),
      ...(settings.aiModel === undefined ? {} : { model: settings.aiModel }),
      ...(settings.aiBaseUrl === undefined ? {} : { baseUrl: settings.aiBaseUrl }),
      cache: settings.aiCache,
    });
    const warnings = ai === null ? [] : ai.warnings;
    const container = settings.strict
      ? await resolveStrictContainer(settings.sandboxImage)
      : undefined;
    const smokeHarness =
      settings.smoke === undefined ? undefined : loadSmokeHarness(settings.smoke);
    const result = await runProject({
      sourceRoot,
      outputRoot: parsed.out,
      target,
      intMode: settings.intMode,
      ...(parsed.noTests ? { runTests: false } : {}),
      sandbox,
      nodePath: process.execPath,
      pythonPath: "python3",
      nodeModulesPath: toolchain.nodeModulesPath,
      vitestEntryPath: toolchain.vitestEntryPath,
      typescriptEntryPath: toolchain.typescriptEntryPath,
      ...(settings.strict ? { strict: true } : {}),
      ...(container === undefined ? {} : { container }),
      ...(smokeHarness === undefined ? {} : { smoke: smokeHarness }),
      ...(parsed.repair
        ? { repair: { proposer: ai?.repairProposer ?? new DisabledRepairProposer() } }
        : {}),
      ...(ai === null ? {} : { resolveAmbiguity: ai.resolver }),
      onProgress: (event) => progress.emit(event),
    });
    if (ai !== null) {
      const journalDir = join(parsed.out, ".ctrans");
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
    const code = failed || repairInfrastructureFailure ? 1 : 0;
    progress.emit({ event: "run:done", message: "project validation finished", status: "done" });
    const stderr = progress.text() + warnings.map((warning) => `warning: ${warning}\n`).join("");
    if (parsed.json) {
      return {
        code,
        stdout: jsonOutput({
          command: "project",
          target,
          outputDir: parsed.out,
          report: result.pipeline.report,
          stages: result.stages,
          skipped: result.skipped,
          testOutcomes: result.testOutcomes,
          s5:
            result.s5 === null
              ? null
              : {
                  status: result.s5.status,
                  outcomes: result.s5.outcomes.length,
                  flaky: result.s5.flaky,
                  rerunPerformed: result.s5.rerunPerformed,
                },
          s6:
            result.s6 === null
              ? null
              : {
                  status: result.s6.status,
                  matched: result.s6.matched.length,
                  mismatched: result.s6.mismatched,
                  sourceOnly: result.s6.sourceOnly,
                  targetOnly: result.s6.targetOnly,
                  flaky: result.s6.flaky,
                },
          s7:
            result.s7 === null
              ? null
              : {
                  status: result.s7.status,
                  reason: result.s7.reason,
                  exitCode: result.s7.exitCode,
                },
          repair:
            result.repair === null
              ? null
              : {
                  stopReason: result.repair.stopReason,
                  acceptedUnits: result.repair.acceptedUnits,
                  attempts: result.repair.attempts.length,
                  journal: result.repairJournal,
                },
          ai: ai === null ? null : { provider: ai.provider, model: ai.model, cache: ai.cacheMode },
          warnings,
        }),
        stderr,
      };
    }
    return { code, stdout: `${lines.join("\n")}\n`, stderr };
  } catch (error) {
    return failureResult(error, parsed.json, progress.text());
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

async function runValidateCommand(rest: readonly string[]): Promise<CliResult> {
  const parsed = parseOptions(rest);
  if (parsed.error !== null) return usageResult(parsed.error, parsed.json);
  const targetDirectory = parsed.positional[0];
  if (targetDirectory === undefined || parsed.positional.length > 1) {
    return usageResult("validate requires exactly one target directory", parsed.json);
  }
  if (
    parsed.out !== undefined ||
    parsed.noTests ||
    parsed.repair ||
    parsed.to !== undefined ||
    parsed.aiProvider !== undefined ||
    parsed.suite !== undefined
  ) {
    return usageResult(
      "validate accepts --config, --strict/--sandbox-image, --smoke, --json, and --progress only",
      parsed.json,
    );
  }
  const output = outputOptionsFrom({ json: parsed.json, progress: parsed.progress });
  const progress = createProgressCollector(output);
  progress.emit({ event: "run:start", message: "target validation started", status: "running" });
  try {
    const loaded = discoverConfig(targetDirectory, parsed.config);
    const strict = parsed.strict || loaded?.config.sandbox === "strict";
    const image = parsed.sandboxImage ?? loaded?.config.sandboxImage;
    if (image !== undefined && !strict) {
      return usageResult("--sandbox-image requires --strict", parsed.json);
    }
    const smokePath = parsed.smoke ?? loaded?.config.smoke;
    const smokeHarness = smokePath === undefined ? undefined : loadSmokeHarness(smokePath);
    const capabilities = await detectCapabilities();
    const container = strict ? await resolveStrictContainer(image) : undefined;
    const result = await runValidate(targetDirectory, {
      capabilities,
      ...(strict ? { strict: true } : {}),
      ...(container === undefined ? {} : { container }),
      ...(smokeHarness === undefined ? {} : { smoke: smokeHarness }),
    });
    progress.emit({ event: "run:done", message: "target validation finished", status: "done" });
    const failed = result.stages.some((stage) => stage.status === "fail");
    const code = failed ? 1 : 0;
    if (parsed.json) {
      return {
        code,
        stdout: jsonOutput({
          command: "validate",
          target: result.target,
          files: result.files,
          stages: result.stages,
          claimLevel: assertStageEvidence(result.stages, { required: STAGE_ORDER }),
          s5:
            result.s5 === null
              ? null
              : {
                  status: result.s5.status,
                  outcomes: result.s5.outcomes.length,
                  flaky: result.s5.flaky,
                },
          s7:
            result.s7 === null
              ? null
              : {
                  status: result.s7.status,
                  reason: result.s7.reason,
                  exitCode: result.s7.exitCode,
                },
          skipped: result.skipped,
        }),
        stderr: progress.text(),
      };
    }
    const lines = [summarizeValidation(result)];
    for (const skip of result.skipped) lines.push(`skipped: ${skip.what} (${skip.reason})`);
    return { code, stdout: `${lines.join("\n")}\n`, stderr: progress.text() };
  } catch (error) {
    return failureResult(error, parsed.json, progress.text());
  }
}

async function runBenchmarkCommand(rest: readonly string[]): Promise<CliResult> {
  const parsed = parseOptions(rest);
  if (parsed.error !== null) return usageResult(parsed.error, parsed.json);
  if (parsed.positional.length > 0) {
    return usageResult("benchmark does not accept positional arguments", parsed.json);
  }
  if (
    parsed.to !== undefined ||
    parsed.out !== undefined ||
    parsed.noTests ||
    parsed.repair ||
    parsed.strict ||
    parsed.smoke !== undefined ||
    parsed.aiProvider !== undefined
  ) {
    return usageResult(
      "benchmark accepts --suite, --iterations, --results, --json, and --progress only",
      parsed.json,
    );
  }
  const suiteName = parsed.suite ?? "micro";
  if (!isBenchmarkSuiteName(suiteName)) {
    return usageResult(
      `unknown suite "${suiteName}" (expected micro, corpus, mini-projects, or perf)`,
      parsed.json,
    );
  }
  const output = outputOptionsFrom({ json: parsed.json, progress: parsed.progress });
  const progress = createProgressCollector(output);
  progress.emit({
    event: "benchmark:start",
    message: `benchmark suite ${suiteName} started`,
    status: "running",
  });
  try {
    const result = await runBenchmark(suiteName, {
      ...(parsed.iterations === undefined ? {} : { iterations: parsed.iterations }),
    });
    // Self-check before presenting anything: malformed results are an error.
    const checked = parseBenchmarkResult(result);
    const suite = checked.suites[0]!;
    if (parsed.results !== undefined) {
      const target = resolve(parsed.results);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, jsonOutput(checked));
    }
    progress.emit({
      event: "benchmark:done",
      message: `benchmark suite ${suiteName} finished`,
      status: suite.status,
    });
    const code = suite.status === "ok" ? 0 : 1;
    if (parsed.json) {
      return { code, stdout: jsonOutput(checked), stderr: progress.text() };
    }
    const lines = [summarizeBenchmark(checked)];
    if (parsed.results !== undefined) lines.push(`results: ${resolve(parsed.results)}`);
    if (suite.status === "skipped") {
      lines.push(
        "suite skipped: benchmark assets are missing (run from the repository root or set CTRANS_BENCHMARKS_DIR)",
      );
    }
    return { code, stdout: `${lines.join("\n")}\n`, stderr: progress.text() };
  } catch (error) {
    return failureResult(error, parsed.json, progress.text());
  }
}

async function runDoctorCommand(rest: readonly string[]): Promise<CliResult> {
  const parsed = parseOptions(rest);
  if (parsed.error !== null) return usageResult(parsed.error, parsed.json);
  if (
    parsed.positional.length > 0 ||
    parsed.to !== undefined ||
    parsed.out !== undefined ||
    parsed.repair ||
    parsed.strict ||
    parsed.smoke !== undefined ||
    parsed.suite !== undefined ||
    parsed.iterations !== undefined ||
    parsed.results !== undefined ||
    parsed.aiProvider !== undefined
  ) {
    return usageResult("doctor accepts --json and --progress only", parsed.json);
  }
  try {
    return await runDoctor(undefined, { json: parsed.json });
  } catch (error) {
    return failureResult(error, parsed.json);
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
  if (command === "validate") {
    return runValidateCommand(rest);
  }
  if (command === "benchmark") {
    return runBenchmarkCommand(rest);
  }
  if (command === "doctor") {
    return runDoctorCommand(rest);
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
