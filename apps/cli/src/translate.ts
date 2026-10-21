// Pipeline wiring for the CLI (docs/roadmap.md M4/M7): owns the parser/codegen
// dispatch per translation direction and the bridge spawn lifecycle, then delegates
// to the core pipeline. `check` runs the full pipeline in memory; `translate`
// additionally writes the target files and the `.ctrans/` artifacts.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { MODULE_MAPPINGS, createRegistryLookup } from "@ctrans/registry";
import {
  directionFor,
  runPipeline,
  sourceLanguageOf,
  type PipelineInput,
  type PipelineResult,
  type SourceLanguage,
  type SyntaxValidator,
  type TargetLanguage,
  type UnitTranslator,
} from "@ctrans/core";
import { createPyToJsTranslator, JsToTsTranslator, TsToJsTranslator } from "@ctrans/codegen-js";
import { createJsToPyTranslator } from "@ctrans/codegen-py";
import { createPythonBridgeParser, type PythonBridgeParser } from "@ctrans/parser-py";
import {
  createOxcJsParser,
  createOxcSyntaxValidator,
  OracleTypeValidator,
} from "@ctrans/parser-js";
import { PyrightTypeValidator, pyrightEntryPath } from "@ctrans/validator";

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
  const files = collectSourceFiles(inputPath);
  if (files.length === 0) {
    throw new Error(`no translatable source files found under "${inputPath}"`);
  }
  const sourceLanguage = sourceLanguageOf(
    files.map((file) => ({ language: languageForFilename(file.moduleId) })),
  );
  const direction = directionFor(sourceLanguage, target);
  if (direction === null) {
    throw new Error(`no translation direction from ${sourceLanguage} to ${target}`);
  }
  const inputs: PipelineInput[] = [];
  for (const file of files) {
    const language = languageForFilename(file.moduleId);
    inputs.push({
      filename: file.moduleId,
      parseResult: await parseSource(language, file.path, file.moduleId),
    });
  }
  return runPipeline(
    inputs,
    {
      target,
      intMode,
      translateUnit: await translatorFor(direction, intMode),
      validateSyntax: await syntaxValidatorFor(target),
      // S2: the oracle for TS output; the pinned pyright CLI for Python output
      // (it materializes the emitted project into its own workspace, so it runs
      // for both check and translate modes).
      ...(target === "typescript"
        ? { validateTypes: new OracleTypeValidator() as never }
        : target === "python"
          ? {
              validateTypes: new PyrightTypeValidator({
                pyrightPath: pyrightEntryPath(import.meta.url),
                nodePath: process.execPath,
              }) as never,
            }
          : {}),
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

function languageForFilename(filename: string): SourceLanguage {
  if (filename.endsWith(".py")) return "python";
  if (/\.(ts|tsx|mts|cts)$/.test(filename)) return "typescript";
  if (/\.(js|jsx|mjs|cjs)$/.test(filename)) return "javascript";
  throw new Error(`unsupported source extension: ${filename}`);
}

async function parseSource(
  language: SourceLanguage,
  path: string,
  moduleId: string,
): Promise<PipelineInput["parseResult"]> {
  const content = readFileSync(path, "utf8");
  if (language === "python") {
    const parser = await createPythonBridgeParser();
    return parser.parse(content, { filename: moduleId });
  }
  const parser = await createOxcJsParser();
  return parser.parse(content, { filename: moduleId, language });
}

// Direction-aware translator dispatch (docs/roadmap.md M7 WS A).
async function translatorFor(
  direction: NonNullable<ReturnType<typeof directionFor>>,
  intMode: "number" | "bigint",
): Promise<UnitTranslator> {
  switch (direction) {
    case "python→typescript":
    case "python→javascript":
      return createPyToJsTranslator(
        direction === "python→typescript" ? "typescript" : "javascript",
        {
          intMode,
          registry: createRegistryLookup(),
        },
      );
    case "typescript→javascript":
      return new TsToJsTranslator(createRegistryLookup());
    case "javascript→typescript":
      return new JsToTsTranslator(createRegistryLookup());
    case "javascript→python":
    case "typescript→python":
      return createJsToPyTranslator();
  }
}

// S1 wiring per TARGET language: oxc re-parses JS/TS output; Python output
// re-parses through the bridge (the reference grammar).
async function syntaxValidatorFor(target: TargetLanguage): Promise<SyntaxValidator> {
  if (target === "python") {
    return createPythonSyntaxValidator(await createPythonBridgeParser());
  }
  return createOxcSyntaxValidator();
}

function createPythonSyntaxValidator(parser: PythonBridgeParser): SyntaxValidator {
  return {
    async validate(files) {
      const details: string[] = [];
      let failures = 0;
      for (const file of files) {
        if (!file.path.endsWith(".py")) continue;
        try {
          await parser.parse(file.content, { filename: file.path });
        } catch (error) {
          failures += 1;
          details.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (failures > 0) {
        return {
          stage: "S1-syntax",
          status: "fail",
          reason: `${String(failures)} file(s) failed to re-parse as Python`,
          details,
        };
      }
      return { stage: "S1-syntax", status: "pass", reason: null, details: [] };
    },
  };
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

function collectSourceFiles(inputPath: string): Array<{ path: string; moduleId: string }> {
  const translatable = (name: string): boolean =>
    /\.(py|ts|tsx|js|jsx|mjs|cjs)$/.test(name) && !name.endsWith(".d.ts");
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
      } else if (translatable(entry.name)) {
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
