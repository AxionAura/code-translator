// `ctrans validate <target-dir>` (M11): validate an EXISTING target project without
// any source project. It uses the same validators as project mode and never
// executes code outside the sandbox. S3/S6 are reported skipped because a
// standalone target project has no source ModuleGraph/test mapping; S5/S7 run only
// when their inputs exist.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { CTransError, type StageResult, type ValidationStageName } from "@axion-ct/core";
import { createOxcSyntaxValidator, OracleTypeValidator } from "@axion-ct/parser-js";
import { createPythonBridgeParser } from "@axion-ct/parser-py";
import {
  SandboxIsolationError,
  type ContainerRunOptions,
  type SandboxCapabilities,
} from "@axion-ct/sandbox";
import {
  assembleStages,
  assertStageEvidence,
  PyrightTypeValidator,
  pyrightEntryPath,
  runS4,
  runS5,
  runS7,
  STAGE_ORDER,
  type S5Result,
  type S7Result,
  type SmokeHarness,
  type TestOutcome,
} from "@axion-ct/validator";

import { runnerToolchain } from "./toolchain.js";

export type ValidateTarget = "typescript" | "javascript" | "python";

export interface ValidateOptions {
  readonly capabilities: SandboxCapabilities;
  readonly strict?: boolean;
  readonly container?: ContainerRunOptions;
  readonly smoke?: SmokeHarness;
  readonly timeoutMs?: number;
}

export interface ValidateResult {
  readonly target: ValidateTarget;
  readonly files: readonly string[];
  readonly stages: readonly StageResult[];
  readonly s5: S5Result | null;
  readonly s7: S7Result | null;
  readonly testOutcomes: readonly TestOutcome[];
  readonly skipped: readonly { readonly what: string; readonly reason: string }[];
}

const TARGET_EXTENSIONS: Readonly<Record<ValidateTarget, readonly string[]>> = {
  typescript: [".ts", ".tsx", ".mts", ".cts"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  python: [".py"],
};
const TEST_PATTERN = /\.test\.ts$/;
const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".ctrans", ".git", "__pycache__"]);

function collectTargetFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort(
      (left, right) => (left.name < right.name ? -1 : 1),
    )) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) walk(child);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.size >= 5000) {
        throw new CTransError("VALIDATE-CAP", "validate file cap (5000) exceeded");
      }
      files.set(child, readFileSync(join(root, child), "utf8"));
    }
  };
  walk("");
  return files;
}

function detectTarget(files: ReadonlyMap<string, string>): ValidateTarget {
  const counts: Record<ValidateTarget, number> = { typescript: 0, javascript: 0, python: 0 };
  for (const path of files.keys()) {
    for (const [target, extensions] of Object.entries(TARGET_EXTENSIONS) as [
      ValidateTarget,
      readonly string[],
    ][]) {
      if (extensions.some((extension) => path.endsWith(extension))) counts[target] += 1;
    }
  }
  const detected = (Object.entries(counts) as [ValidateTarget, number][])
    .filter(([, count]) => count > 0)
    .map(([target]) => target);
  if (detected.length === 0) {
    throw new CTransError("VALIDATE-NO-FILES", "no target source files found");
  }
  if (detected.length > 1) {
    throw new CTransError(
      "VALIDATE-MIXED",
      `mixed target languages are not supported by validate: ${detected.join(", ")}`,
    );
  }
  return detected[0]!;
}

function pythonSyntaxValidator(): {
  validate: (files: readonly { path: string; content: string }[]) => Promise<StageResult>;
} {
  return {
    async validate(files) {
      const parser = await createPythonBridgeParser();
      const failures: string[] = [];
      for (const file of files) {
        try {
          await parser.parse(file.content, { filename: file.path });
        } catch (error) {
          failures.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return {
        stage: "S1-syntax",
        status: failures.length === 0 ? "pass" : "fail",
        reason: failures.length === 0 ? null : `${String(failures.length)} file(s) failed to parse`,
        details: failures.slice(0, 10),
      };
    },
  };
}

export async function runValidate(
  targetDirectory: string,
  options: ValidateOptions,
): Promise<ValidateResult> {
  const root = resolve(targetDirectory);
  if (!statSync(root).isDirectory()) {
    throw new CTransError("VALIDATE-NOT-DIRECTORY", `validate expects a directory: ${root}`);
  }
  const files = collectTargetFiles(root);
  const target = detectTarget(files);
  const sourceExtensions = TARGET_EXTENSIONS[target];
  const list = [...files.entries()]
    .filter(([path]) => sourceExtensions.some((extension) => path.endsWith(extension)))
    .map(([path, content]) => ({ path, content }));
  const skipped: { what: string; reason: string }[] = [];
  const output: StageResult[] = [];

  const sourceList = list.filter((file) => !TEST_PATTERN.test(file.path));
  if (target === "python") {
    output.push(await pythonSyntaxValidator().validate(list));
  } else {
    const syntax = await createOxcSyntaxValidator();
    output.push(await syntax.validate(list.map((file) => ({ ...file, language: target }))));
  }
  if (target === "typescript") {
    // S2 checks the SOURCE surface (project mode does the same); test modules are
    // validated by S1/S4 and executed by S5.
    output.push(await new OracleTypeValidator().validate(sourceList));
  } else if (target === "python") {
    output.push(
      await new PyrightTypeValidator({
        pyrightPath: pyrightEntryPath(import.meta.url),
        nodePath: process.execPath,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      }).validate(sourceList),
    );
  } else {
    output.push({
      stage: "S2-types",
      status: "skipped",
      reason: "no JavaScript type checker exists (S2 is TypeScript-only)",
      details: [],
    });
  }
  output.push({
    stage: "S3-dependencies",
    status: "skipped",
    reason: "standalone target validation has no source ModuleGraph/registry context",
    details: [],
  });

  const toolchain = runnerToolchain();
  const s4 = await runS4(
    {
      files,
      target:
        target === "typescript" ? "typescript" : target === "python" ? "python" : "javascript",
    },
    {
      capabilities: options.capabilities,
      nodePath: process.execPath,
      pythonPath: "python3",
      nodeModulesPath: toolchain.nodeModulesPath,
      typescriptEntryPath: toolchain.typescriptEntryPath,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.strict === true ? { strict: true } : {}),
      ...(options.container === undefined ? {} : { container: options.container }),
    },
  );
  output.push(s4);

  const testFiles = list.map((file) => file.path).filter((path) => TEST_PATTERN.test(path));
  let s5: S5Result | null = null;
  let testOutcomes: readonly TestOutcome[] = [];
  if (target !== "typescript") {
    skipped.push({ what: "S5-tests", reason: "test execution requires a TypeScript target" });
    output.push({
      stage: "S5-tests",
      status: "skipped",
      reason: "test execution requires a TypeScript target",
      details: [],
    });
  } else if (testFiles.length === 0) {
    skipped.push({ what: "S5-tests", reason: "no target test modules found" });
    output.push({
      stage: "S5-tests",
      status: "skipped",
      reason: "no target test modules found",
      details: [],
    });
  } else {
    try {
      s5 = await runS5(
        { files, testFiles },
        {
          capabilities: options.capabilities,
          nodeModulesPath: toolchain.nodeModulesPath,
          vitestEntryPath: toolchain.vitestEntryPath,
          nodePath: process.execPath,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.strict === true ? { strict: true } : {}),
          ...(options.container === undefined ? {} : { container: options.container }),
        },
      );
      output.push(s5);
      testOutcomes = s5.outcomes;
    } catch (error) {
      if (!(error instanceof SandboxIsolationError)) throw error;
      const reason = `enforced network isolation unavailable: ${error.message}`;
      skipped.push({ what: "S5-tests", reason });
      output.push({ stage: "S5-tests", status: "skipped", reason, details: [] });
    }
  }
  output.push({
    stage: "S6-differential",
    status: "skipped",
    reason: "no source project/test mapping for a standalone target project",
    details: [],
  });

  let s7: S7Result | null = null;
  if (options.smoke === undefined) {
    skipped.push({ what: "S7-smoke", reason: "no smoke harness provided (opt-in)" });
  } else if (s4.status === "fail") {
    const reason = "S4 build failed; smoke not attempted";
    skipped.push({ what: "S7-smoke", reason });
    output.push({ stage: "S7-smoke", status: "skipped", reason, details: [] });
  } else {
    s7 = await runS7(
      { files, harness: options.smoke },
      {
        capabilities: options.capabilities,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.strict === true ? { strict: true } : {}),
        ...(options.container === undefined ? {} : { container: options.container }),
      },
    );
  }
  if (s7 !== null) output.push(s7);
  const stages = assembleStages(output, STAGE_ORDER, (name) =>
    name === "S7-smoke" && options.smoke === undefined
      ? "no smoke harness provided (opt-in)"
      : `stage ${name} was not executed`,
  );
  assertStageEvidence(stages, { required: STAGE_ORDER });
  if (options.strict === true) {
    const infrastructure = stages.filter(
      (stage) =>
        stage.status === "skipped" &&
        /infrastructure|container|failed to spawn|timed out|unavailable|refused/i.test(
          stage.reason ?? "",
        ),
    );
    if (infrastructure.length > 0) {
      throw new CTransError(
        "SANDBOX-STRICT-VALIDATION-FAILED",
        `strict validation could not run: ${infrastructure
          .map((stage) => `${stage.stage}: ${stage.reason ?? "skipped"}`)
          .join("; ")}`,
      );
    }
  }
  return {
    target,
    files: [...files.keys()].sort(),
    stages,
    s5,
    s7,
    testOutcomes,
    skipped,
  };
}

export function summarizeValidation(result: ValidateResult): string {
  const claim = assertStageEvidence(result.stages, { required: STAGE_ORDER });
  const lines = [
    `validated ${String(result.files.length)} ${result.target} file(s): claim level ${String(claim)}`,
  ];
  for (const stage of result.stages) {
    lines.push(
      `  ${stage.stage}: ${stage.status}${stage.reason === null ? "" : ` (${stage.reason})`}`,
    );
  }
  return lines.join("\n");
}

// Re-exported for the CLI's stage-name typing without importing core there.
export type { ValidationStageName };
