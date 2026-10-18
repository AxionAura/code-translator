// Pipeline wiring for the CLI (docs/roadmap.md M4): owns the bridge spawn lifecycle
// and validator construction, then delegates to the core pipeline. `check` runs the
// full pipeline in memory; `translate` additionally writes the target files and the
// `.ctrans/` artifacts (ledger + report).
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { MODULE_MAPPINGS, createRegistryLookup } from "@ctrans/registry";
import {
  runPipeline,
  type PipelineInput,
  type PipelineResult,
  type TargetLanguage,
} from "@ctrans/core";
import { createPyToJsTranslator } from "@ctrans/codegen-js";
import { createPythonBridgeParser } from "@ctrans/parser-py";
import { createOxcSyntaxValidator, OracleTypeValidator } from "@ctrans/parser-js";

export interface CheckOutcome {
  readonly report: PipelineResult["report"];
  readonly files: ReadonlyMap<string, string>; // target path -> content (in memory for check)
}

export async function checkPath(
  inputPath: string,
  target: TargetLanguage,
  intMode: "number" | "bigint" = "number",
): Promise<CheckOutcome> {
  const result = await runOnPath(inputPath, target, intMode);
  const files = new Map<string, string>();
  for (const file of result.emittedFiles) files.set(file.targetPath, file.content);
  return { report: result.report, files };
}

export async function translatePath(
  inputPath: string,
  target: TargetLanguage,
  outputDir: string,
  intMode: "number" | "bigint" = "number",
): Promise<CheckOutcome> {
  const result = await runOnPath(inputPath, target, intMode);
  for (const file of result.emittedFiles) {
    const destination = join(outputDir, file.targetPath);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, file.content);
  }
  const ctransDir = join(outputDir, ".ctrans");
  mkdirSync(ctransDir, { recursive: true });
  writeFileSync(join(ctransDir, "ledger.json"), JSON.stringify(result.ledger, null, 2) + "\n");
  writeFileSync(join(ctransDir, "report.json"), JSON.stringify(result.report, null, 2) + "\n");
  return {
    report: result.report,
    files: new Map(result.emittedFiles.map((f) => [f.targetPath, f.content])),
  };
}

async function runOnPath(
  inputPath: string,
  target: TargetLanguage,
  intMode: "number" | "bigint",
): Promise<PipelineResult> {
  const pyFiles = collectPythonFiles(inputPath);
  if (pyFiles.length === 0) {
    throw new Error(`no .py files found under "${inputPath}"`);
  }
  const parser = await createPythonBridgeParser();
  const inputs = [];
  for (const file of pyFiles) {
    inputs.push({
      filename: file.moduleId,
      parseResult: await parser.parse(readFileSync(file.path, "utf8"), { filename: file.moduleId }),
    });
  }
  return runPipeline(
    inputs,
    {
      target,
      intMode,
      translateUnit: await createPyToJsTranslator(target, {
        intMode,
        registry: createRegistryLookup(),
      }),
      validateSyntax: await createOxcSyntaxValidator(),
      validateTypes: new OracleTypeValidator(),
      asyncBoundaryModules: ["requests"],
    },
    {
      // S3 (WS G): the graph-derived import map feeds dependency validation.
      sourceImports: collectSourceImports(inputs),
      mappedModules: new Set(
        MODULE_MAPPINGS.filter((m) => m.syncAsync !== undefined || m.emit.kind === "rewrite").map(
          (m) => m.module,
        ),
      ),
      unsupportedModules: new Set(["ctypes", "curses", "tkinter"]),
    },
  );
}

// The ModuleGraph already resolved imports per unit; S3 re-derives the specifier
// list from the same parse data (cheap, deterministic, one source of truth).
function collectSourceImports(inputs: readonly PipelineInput[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const input of inputs) {
    const specifiers = (input.parseResult.module?.imports ?? []).map(
      (entry) => entry.moduleSpecifier,
    );
    map.set(input.filename, specifiers);
  }
  return map;
}

function collectPythonFiles(inputPath: string): Array<{ path: string; moduleId: string }> {
  if (!statSync(inputPath).isDirectory()) {
    // Single-file mode: the module id is the file's basename.
    const base = inputPath.replaceAll("\\", "/").split("/").pop()!;
    return [{ path: inputPath, moduleId: base }];
  }
  const files: Array<{ path: string; moduleId: string }> = [];
  const walk = (absolute: string, moduleId: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const childAbsolute = join(absolute, entry.name);
      const childModuleId = moduleId === "" ? entry.name : `${moduleId}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(childAbsolute, childModuleId);
      } else if (entry.name.endsWith(".py")) {
        files.push({ path: childAbsolute, moduleId: childModuleId });
      }
    }
  };
  walk(inputPath, "");
  return files.sort((left, right) => (left.moduleId < right.moduleId ? -1 : 1));
}

export function summarize(outcome: CheckOutcome): string {
  const report = outcome.report;
  const lines = [
    `claim level ${String(report.claimLevel)} (${report.validationStages
      .map((stage) => `${stage.stage}:${stage.status}`)
      .join(", ")})`,
    `files: ${String(report.files.length)}`,
    `decisions: ${String(report.decisionTotals.deterministic)} deterministic, ${String(
      report.decisionTotals.semantic,
    )} semantic, ${String(report.decisionTotals.ambiguous)} ambiguous, ${String(
      report.decisionTotals.unsupported,
    )} unsupported`,
  ];
  if (report.warnings.length > 0) {
    lines.push(`warnings: ${report.warnings.join(", ")}`);
  }
  for (const file of report.files) {
    lines.push(`  ${file.source} -> ${file.target ?? "(failed)"} [${file.status}]`);
  }
  return lines.join("\n");
}

export function joinRelative(base: string, target: string): string {
  return relative(base, target);
}
