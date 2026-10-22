// Pipeline wiring for the CLI (docs/roadmap.md M4/M7): owns the parser/codegen
// dispatch per translation direction and the bridge spawn lifecycle, then delegates
// to the core pipeline. `check` runs the full pipeline in memory; `translate`
// additionally writes the target files and the `.ctrans/` artifacts. The repair
// path (M9) reuses the SAME validators through `runTranslation` — never a second,
// weaker validation wiring.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { MODULE_MAPPINGS, createRegistryLookup } from "@axion-ct/registry";
import {
  directionFor,
  runPipeline,
  sourceLanguageOf,
  targetModulePath,
  validateDependencies,
  type AmbiguityResolver,
  type PipelineInput,
  type PipelineResult,
  type SourceLanguage,
  type StageResult,
  type SyntaxValidator,
  type TargetLanguage,
  type UnitTranslator,
} from "@axion-ct/core";
import { createPyToJsTranslator, JsToTsTranslator, TsToJsTranslator } from "@axion-ct/codegen-js";
import { createJsToPyTranslator } from "@axion-ct/codegen-py";
import { createPythonBridgeParser, type PythonBridgeParser } from "@axion-ct/parser-py";
import {
  createOxcJsParser,
  createOxcSyntaxValidator,
  OracleTypeValidator,
} from "@axion-ct/parser-js";
import { PyrightTypeValidator, pyrightEntryPath } from "@axion-ct/validator";

export interface CheckOutcome {
  readonly report: PipelineResult["report"];
  readonly files: ReadonlyMap<string, string>; // target path -> content (in memory for check)
}

// One translation run plus everything the repair loop needs to re-validate
// candidates with the same validators and the same S3 context.
export interface TranslationRun {
  readonly result: PipelineResult;
  // Source module id -> original source text (never persisted by repair).
  readonly sources: ReadonlyMap<string, string>;
  readonly validateEmitted: (files: ReadonlyMap<string, string>) => Promise<readonly StageResult[]>;
}

export async function checkPath(
  inputPath: string,
  target: TargetLanguage,
  intMode: "number" | "bigint" = "number",
  resolver?: AmbiguityResolver,
): Promise<CheckOutcome> {
  const { result } = await runTranslation(inputPath, target, intMode, resolver);
  const files = new Map<string, string>();
  for (const file of result.emittedFiles) files.set(file.targetPath, file.content);
  return { report: result.report, files };
}

export async function translatePath(
  inputPath: string,
  target: TargetLanguage,
  outputDir: string,
  intMode: "number" | "bigint" = "number",
  resolver?: AmbiguityResolver,
): Promise<CheckOutcome> {
  const { result } = await runTranslation(inputPath, target, intMode, resolver);
  writeTranslationArtifacts(result, outputDir);
  return {
    report: result.report,
    files: new Map(result.emittedFiles.map((f) => [f.targetPath, f.content])),
  };
}

// Writes the emitted files and the standard `.ctrans/` artifacts. Shared with the
// repair path so both modes produce identical layouts; `files` defaults to the
// pipeline's emitted content and, after repair, carries the accepted state.
export function writeTranslationArtifacts(
  result: PipelineResult,
  outputDir: string,
  files?: ReadonlyMap<string, string>,
): void {
  const contents =
    files ?? new Map(result.emittedFiles.map((file) => [file.targetPath, file.content]));
  for (const [targetPath, content] of contents) {
    const destination = join(outputDir, targetPath);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, content);
  }
  const ctransDir = join(outputDir, ".ctrans");
  mkdirSync(ctransDir, { recursive: true });
  writeFileSync(join(ctransDir, "ledger.json"), JSON.stringify(result.ledger, null, 2) + "\n");
  writeFileSync(join(ctransDir, "report.json"), JSON.stringify(result.report, null, 2) + "\n");
}

export async function runTranslation(
  inputPath: string,
  target: TargetLanguage,
  intMode: "number" | "bigint",
  resolver?: AmbiguityResolver,
): Promise<TranslationRun> {
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
  const sources = new Map<string, string>();
  const inputs: PipelineInput[] = [];
  for (const file of files) {
    const content = readFileSync(file.path, "utf8");
    sources.set(file.moduleId, content);
    const language = languageForFilename(file.moduleId);
    inputs.push({
      filename: file.moduleId,
      parseResult: await parseSource(language, content, file.moduleId),
    });
  }
  const validateSyntax = await syntaxValidatorFor(target);
  // S2: the oracle for TS output; the pinned pyright CLI for Python output.
  const validateTypes =
    target === "typescript"
      ? new OracleTypeValidator()
      : target === "python"
        ? new PyrightTypeValidator({
            pyrightPath: pyrightEntryPath(import.meta.url),
            nodePath: process.execPath,
          })
        : null;
  const s3 = {
    // S3 (WS G): the graph-derived import map feeds dependency validation.
    sourceImports: collectSourceImports(inputs),
    mappedModules: new Set(
      MODULE_MAPPINGS.filter((m) => m.syncAsync !== undefined || m.emit.kind === "rewrite").map(
        (m) => m.module,
      ),
    ),
    unsupportedModules: new Set(["ctypes", "curses", "tkinter"]),
  };
  const result = await runPipeline(
    inputs,
    {
      target,
      intMode,
      translateUnit: await translatorFor(direction, intMode),
      validateSyntax,
      ...(validateTypes === null ? {} : { validateTypes: validateTypes as never }),
      asyncBoundaryModules: ["requests"],
      ...(resolver === undefined ? {} : { resolveAmbiguity: resolver }),
    },
    s3,
  );
  const extension = target === "typescript" ? ".ts" : target === "python" ? ".py" : ".js";
  // Candidate re-validation for the repair loop: the same stages, in the same
  // order, with the same validators as the pipeline run above.
  const validateEmitted = async (
    emitted: ReadonlyMap<string, string>,
  ): Promise<readonly StageResult[]> => {
    const list = [...emitted.entries()].map(([path, content]) => ({ path, content }));
    const stages: StageResult[] = [
      await validateSyntax.validate(list.map((file) => ({ ...file, language: target }))),
    ];
    stages.push(
      validateTypes === null
        ? {
            stage: "S2-types",
            status: "skipped",
            reason:
              target === "javascript"
                ? "no JavaScript type checker exists (S2 is TypeScript-only)"
                : "no type validator wired",
            details: [],
          }
        : await validateTypes.validate(list),
    );
    if (emitted.size > 0) {
      stages.push(
        validateDependencies({
          files: emitted,
          mappedModules: s3.mappedModules,
          unsupportedModules: s3.unsupportedModules,
          sourceImports: s3.sourceImports,
          targetPathFor: (sourceModuleId: string) => targetModulePath(sourceModuleId, extension),
        }),
      );
    }
    return stages;
  };
  return { result, sources, validateEmitted };
}

function languageForFilename(filename: string): SourceLanguage {
  if (filename.endsWith(".py")) return "python";
  if (/\.(ts|tsx|mts|cts)$/.test(filename)) return "typescript";
  if (/\.(js|jsx|mjs|cjs)$/.test(filename)) return "javascript";
  throw new Error(`unsupported source extension: ${filename}`);
}

async function parseSource(
  language: SourceLanguage,
  content: string,
  moduleId: string,
): Promise<PipelineInput["parseResult"]> {
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
