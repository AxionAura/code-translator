// Pipeline orchestration (docs/translation-pipeline.md): parse → analyze → graph →
// translate → format → validate → report. Core owns the stages and the claim ladder;
// language-specific translation and validation are injected through these interfaces
// (D-017: the CLI wires @ctrans/codegen-js and @ctrans/parser-js implementations).
import type { LedgerEntry } from "./ledger.js";
import { validateLedgerEntries } from "./ledger.js";
import { analyzeModule, type SemanticModel } from "./semantic.js";
import { buildModuleGraph, normalizeModuleId, type ModuleGraphModel } from "./module-graph.js";
import type { ParseResult, SourceLanguage } from "./parse-result.js";
import { validateTranslationReport, type ClaimLevel, type TranslationReport } from "./report.js";

export type TargetLanguage = "javascript" | "typescript";

export interface PipelineInput {
  readonly filename: string;
  // Inputs arrive pre-parsed: the wiring layer (CLI/tests) owns the bridge spawn
  // lifecycle; the pipeline stages stay pure data transformations.
  readonly parseResult: ParseResult;
  readonly isEntry?: boolean;
}

export interface TranslateOptions {
  readonly target: TargetLanguage;
  // Per-unit translator (implemented by @ctrans/codegen-js for M4's directions).
  readonly translateUnit: UnitTranslator;
  // S1: target syntax validation (implemented with @ctrans/parser-js at the wiring
  // layer — codegen cannot import parser-js under the layer rules).
  readonly validateSyntax?: SyntaxValidator;
  // S2: type validation for TypeScript targets (oracle-backed); JS targets skip.
  readonly validateTypes?: TypeValidator;
}

export interface AnalyzedUnit {
  readonly filename: string;
  readonly parseResult: ParseResult;
  readonly model: SemanticModel;
}

// Shared per-run context handed to unit translators: the analyzed model of every
// unit in the graph (used for cross-module import typing, e.g. class imports).
export interface UnitTranslationContext {
  readonly analyzed: ReadonlyMap<string, AnalyzedUnit>;
}

export interface UnitTranslator {
  readonly target: TargetLanguage;
  translateUnit(
    unit: AnalyzedUnit,
    graph: ModuleGraphModel,
    context?: UnitTranslationContext,
  ): Promise<UnitEmission>;
  // Optional post-pass run once after every unit has been translated: shared files
  // whose contents depend on the union of all units' requirements (e.g. the runtime
  // helper module, which must cover helpers requested by ANY unit).
  finalizeUnits?(): Promise<UnitEmission>;
}

export interface EmittedFile {
  // Target-relative output path (module policy applied, e.g. pkg/mod.py -> pkg/mod.ts).
  readonly targetPath: string;
  readonly sourcePath: string;
  readonly content: string;
}

export interface UnitEmission {
  readonly targetExtension: ".js" | ".ts";
  // Map of source module id -> emitted target path (for import rewriting across units).
  readonly pathFor: (sourceModuleId: string) => string;
  readonly files: readonly EmittedFile[];
  readonly ledger: readonly LedgerEntry[];
}

export interface StageResult {
  readonly stage: "S1-syntax" | "S2-types";
  readonly status: "pass" | "fail" | "warn" | "skipped";
  readonly reason: string | null;
  readonly details: readonly string[];
}

export interface SyntaxValidator {
  validate(
    files: readonly { path: string; content: string; language: SourceLanguage }[],
  ): Promise<StageResult>;
}

export interface TypeValidator {
  validate(files: readonly { path: string; content: string }[]): Promise<StageResult>;
}

export interface PipelineResult {
  readonly report: TranslationReport;
  readonly emittedFiles: readonly EmittedFile[];
  readonly ledger: readonly LedgerEntry[];
}

// Claim ladder (docs/validation.md §2): 0 generated, 1 syntax-valid, 2 type-valid.
// Later stages extend the ladder; M4 executes S1/S2 only.
export function computeClaimLevel(stages: readonly StageResult[]): ClaimLevel {
  const s1 = stages.find((stage) => stage.stage === "S1-syntax");
  const s2 = stages.find((stage) => stage.stage === "S2-types");
  if (s1?.status === "fail") return 0;
  if (s1?.status !== "pass") return 0;
  if (s2?.status === "pass") return 2;
  return 1;
}

// Deterministic target module path policy (roadmap M4 §8): pkg/mod.py -> pkg/mod.<ext>,
// pkg/__init__.py -> pkg/index.<ext>. Single source of truth for emitter and importer.
export function targetModulePath(sourceModuleId: string, extension: ".js" | ".ts"): string {
  const id = normalizeModuleId(sourceModuleId);
  if (id.endsWith("__init__.py")) {
    return id.slice(0, -"__init__.py".length) + `index${extension}`;
  }
  if (id.endsWith(".py")) return id.slice(0, -3) + extension;
  return id + extension;
}

export async function runPipeline(
  inputs: readonly PipelineInput[],
  options: TranslateOptions,
): Promise<PipelineResult> {
  // Stage: parse (inputs arrive pre-parsed by the wiring layer to keep the bridge
  // spawn lifecycle at the app boundary) — the parseResults travel with the input.
  // Stage: analyze + graph.
  const analyzed: AnalyzedUnit[] = inputs.map((input) => ({
    filename: normalizeModuleId(input.filename),
    parseResult: input.parseResult,
    model: analyzeModule(input.parseResult),
  }));
  const graph = buildModuleGraph(
    analyzed.map((unit) => {
      const input = inputs.find(
        (candidate) => normalizeModuleId(candidate.filename) === unit.filename,
      );
      return input?.isEntry === true
        ? { filename: unit.filename, parseResult: unit.parseResult, isEntry: true }
        : { filename: unit.filename, parseResult: unit.parseResult };
    }),
  );

  // Stage: translate units in dependency order (deterministic; graph.order).
  const analyzedById = new Map(analyzed.map((unit) => [unit.filename, unit]));
  const emittedFiles: EmittedFile[] = [];
  const ledger: LedgerEntry[] = [];
  for (const moduleId of graph.order) {
    const unit = analyzed.find((candidate) => candidate.filename === moduleId);
    if (unit === undefined) continue;
    const emission = await options.translateUnit.translateUnit(unit, graph, {
      analyzed: analyzedById,
    });
    emittedFiles.push(...emission.files);
    ledger.push(...emission.ledger);
  }
  // Stage: finalize — shared artifacts (runtime helpers) from the union of units.
  if (options.translateUnit.finalizeUnits !== undefined) {
    const shared = await options.translateUnit.finalizeUnits();
    emittedFiles.push(...shared.files);
    ledger.push(...shared.ledger);
  }

  // Stage: format is the translator's responsibility (prettier inside codegen-js);
  // Stage: validate.
  const stages: StageResult[] = [];
  if (options.validateSyntax !== undefined && emittedFiles.length > 0) {
    stages.push(
      await options.validateSyntax.validate(
        emittedFiles.map((file) => ({
          path: file.targetPath,
          content: file.content,
          language: options.target,
        })),
      ),
    );
  } else {
    stages.push({
      stage: "S1-syntax",
      status: "skipped",
      reason: "no syntax validator wired",
      details: [],
    });
  }
  if (
    options.target === "typescript" &&
    options.validateTypes !== undefined &&
    emittedFiles.length > 0
  ) {
    stages.push(
      await options.validateTypes.validate(
        emittedFiles.map((file) => ({ path: file.targetPath, content: file.content })),
      ),
    );
  } else {
    stages.push({
      stage: "S2-types",
      status: "skipped",
      reason:
        options.target === "javascript"
          ? "no JavaScript type checker exists (S2 is TypeScript-only)"
          : "no type validator wired",
      details: [],
    });
  }

  // Stage: report.
  const decisionTotals = { deterministic: 0, semantic: 0, ambiguous: 0, unsupported: 0 };
  for (const entry of ledger) decisionTotals[entry.decision] += 1;
  const unsupported = ledger
    .filter((entry) => entry.decision === "unsupported")
    .map((entry) => ({ unit: entry.unit, span: entry.span, rule: entry.rule }));
  const ambiguous = ledger
    .filter((entry) => entry.decision === "ambiguous")
    .map((entry) => ({
      unit: entry.unit,
      span: entry.span,
      rule: entry.rule,
      chosen: entry.targetSummary ?? "",
    }));
  const warnings = [...new Set(ledger.flatMap((entry) => entry.warnings))];
  const report = validateTranslationReport({
    generator: { name: "code-translator", version: "0.0.0" },
    sourceLanguage: "python",
    targetLanguage: options.target,
    files: analyzed.map((unit) => {
      const unitLedger = ledger.filter((entry) => entry.unit === unit.filename);
      const counts = { deterministic: 0, semantic: 0, ambiguous: 0, unsupported: 0 };
      for (const entry of unitLedger) counts[entry.decision] += 1;
      const target = emittedFiles.find((file) => file.sourcePath === unit.filename);
      const hasUnsupported = counts.unsupported > 0;
      return {
        source: unit.filename,
        target: target?.targetPath ?? null,
        status:
          target === undefined ? "failed" : hasUnsupported ? "partially-translated" : "translated",
        decisionCounts: counts,
      };
    }),
    decisionTotals,
    warnings,
    unsupported,
    ambiguous,
    validationStages: stages.map((stage) => ({
      stage: stage.stage,
      status: stage.status,
      reason: stage.reason,
    })),
    claimLevel: computeClaimLevel(stages),
    repairJournal: null,
  });

  return {
    report,
    emittedFiles,
    ledger: validateLedgerEntries(ledger),
  };
}
