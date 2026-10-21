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
import {
  collectFunctionCalls,
  collectImportedFunctions,
  propagateAsync,
} from "./async-propagation.js";
import { validateDependencies } from "./s3-dependencies.js";
import {
  ambiguityKey,
  validateAmbiguityDecision,
  type AmbiguityDecision,
  type AmbiguityRequest,
  type AmbiguityResolver,
} from "./escalation.js";
import { sourceLanguageOf } from "./direction.js";
import { extractModuleContract } from "./module-contract.js";

// M7: "python" is a full target (codegen-py) — its S1 re-parses with the Python
// parser and its S2 is the injected pyright adapter; JS targets skip S2 honestly.
export type TargetLanguage = "javascript" | "typescript" | "python";

// D-006: Python int is arbitrary precision. `number` (default) maps int to float64
// with precision-risk diagnostics; `bigint` is the exact opt-in mode (Python ints
// become JS bigint; int/float mixing converts across a documented Number boundary).
export type IntMode = "number" | "bigint";

export interface PipelineInput {
  readonly filename: string;
  // Inputs arrive pre-parsed: the wiring layer (CLI/tests) owns the bridge spawn
  // lifecycle; the pipeline stages stay pure data transformations.
  readonly parseResult: ParseResult;
  readonly isEntry?: boolean;
}

export interface TranslateOptions {
  readonly target: TargetLanguage;
  // D-006 integer policy; default "number" (precision diagnostics), "bigint" exact.
  readonly intMode?: IntMode;
  // Per-unit translator (implemented by @ctrans/codegen-js for M4's directions).
  readonly translateUnit: UnitTranslator;
  // S1: target syntax validation (implemented with @ctrans/parser-js at the wiring
  // layer — codegen cannot import parser-js under the layer rules).
  readonly validateSyntax?: SyntaxValidator;
  // S2: type validation for TypeScript targets (oracle-backed); JS targets skip.
  readonly validateTypes?: TypeValidator;
  // S3: dependency validation (M5) — import resolution of the emitted project
  // against the ModuleGraph and the dependency registry.
  readonly validateDependencies?: DependencyValidator;
  // WS F: registry modules whose target API is async-only (e.g. requests -> fetch).
  // Non-empty triggers the deterministic async-propagation fixpoint.
  readonly asyncBoundaryModules?: readonly string[];
  // M8: optional AI escalation port for engine-classified AMBIGUOUS constructs
  // (docs/ai-architecture.md §1). Absent = AI disabled = deterministic heuristic
  // defaults (the default posture; the pipeline never requires a provider).
  readonly resolveAmbiguity?: AmbiguityResolver;
  // Bounded wall-clock waited for a single escalation before falling back.
  readonly escalationTimeoutMs?: number;
}

// S3 stage inputs supplied by the wiring layer (the registry data lives outside
// core per D-017; core only sees plain sets).
export interface S3StageInput {
  readonly sourceImports: ReadonlyMap<string, readonly string[]>;
  readonly mappedModules: ReadonlySet<string>;
  readonly unsupportedModules: ReadonlySet<string>;
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
  // WS F: functions that must be emitted as async (sync-to-async registry boundary
  // propagation). Units consult this for their own functions and for cross-module
  // callees; absent = no boundary in the project.
  readonly asyncFunctions?: ReadonlyMap<string, ReadonlySet<string>>;
  // M8: chosen option per `ambiguityKey(request)` — either the AI-resolved choice
  // (with escalation provenance) or the deterministic heuristic. Absent = the
  // translator applies its own heuristic default (AI disabled).
  readonly ambiguity?: ReadonlyMap<string, AmbiguityDecision>;
}

export interface UnitTranslator {
  readonly target: TargetLanguage;
  translateUnit(
    unit: AnalyzedUnit,
    graph: ModuleGraphModel,
    context?: UnitTranslationContext,
  ): Promise<UnitEmission>;
  // M8: the engine-classified ambiguous constructs of a unit (enumerated
  // candidate options + heuristic default). The pipeline resolves them through
  // the optional AI port BEFORE translation and passes the chosen options down;
  // lowering itself stays synchronous and deterministic.
  collectAmbiguities?(unit: AnalyzedUnit, graph: ModuleGraphModel): readonly AmbiguityRequest[];
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
  readonly targetExtension: ".js" | ".ts" | ".py";
  // Map of source module id -> emitted target path (for import rewriting across units).
  readonly pathFor: (sourceModuleId: string) => string;
  readonly files: readonly EmittedFile[];
  readonly ledger: readonly LedgerEntry[];
}

export type ValidationStageName =
  "S1-syntax" | "S2-types" | "S3-dependencies" | "S4-build" | "S5-tests" | "S6-differential";

export interface StageResult {
  readonly stage: ValidationStageName;
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

// S3 (docs/validation.md §1): the emitted project's imports resolve against the
// ModuleGraph and the dependency registry. Implemented at the wiring layer (the
// registry lookup is injected; codegen/pipeline stay registry-agnostic).
export interface DependencyValidator {
  validate(files: readonly { path: string; content: string }[]): Promise<StageResult>;
}

export interface PipelineResult {
  readonly report: TranslationReport;
  readonly emittedFiles: readonly EmittedFile[];
  readonly ledger: readonly LedgerEntry[];
  // Full executed-stage evidence (details included). The report carries the
  // summary for humans; repair classification needs the details.
  readonly validationStages: readonly StageResult[];
}

// Claim ladder (docs/validation.md §2): 0 generated, 1 syntax-valid, 2 type-valid,
// 3 dependency-resolved, 4 translated tests pass (S5), 5 source-vs-target
// equivalence on the translated suite (S6). Each level requires EVERY lower level
// to genuinely pass — a failed/skipped required stage caps the claim.
export function computeClaimLevel(stages: readonly StageResult[]): ClaimLevel {
  const stage = (name: ValidationStageName): StageResult | undefined =>
    stages.find((candidate) => candidate.stage === name);
  const s1 = stage("S1-syntax");
  if (s1?.status !== "pass") return 0;
  const s2 = stage("S2-types");
  if (s2?.status !== "pass") return 1;
  const s3 = stage("S3-dependencies");
  if (s3?.status !== "pass") return 2;
  // S4 (build) is not wired in M6 (no bundler target yet) — its absence does not
  // block the ladder; S5/S6 carry levels 4/5.
  const s5 = stage("S5-tests");
  if (s5?.status !== "pass") return 3;
  const s6 = stage("S6-differential");
  if (s6?.status !== "pass") return 4;
  return 5;
}

// M8 escalation orchestration: collect each unit's ambiguous constructs, ask the
// optional resolver (bounded by a wall-clock timeout), validate the answer
// against the offered options, and fall back to the heuristic default on any
// failure. AI can never change WHAT is offered — only which offered option wins.
async function resolveAmbiguities(
  options: TranslateOptions,
  analyzed: readonly AnalyzedUnit[],
  graph: ModuleGraphModel,
): Promise<Map<string, Map<string, AmbiguityDecision>>> {
  const byUnit = new Map<string, Map<string, AmbiguityDecision>>();
  const resolver = options.resolveAmbiguity;
  const collect = options.translateUnit.collectAmbiguities;
  if (resolver === undefined || collect === undefined) {
    // AI disabled: translators apply their own heuristic defaults.
    return byUnit;
  }
  const timeoutMs = options.escalationTimeoutMs ?? 30000;
  const analyzedById = new Map(analyzed.map((unit) => [unit.filename, unit]));
  for (const unit of analyzed) {
    const requests = collect.call(options.translateUnit, unit, graph).map((request) => ({
      ...request,
      contracts: directDependencyContracts(unit, graph, analyzedById),
      diagnostics: unit.parseResult.diagnostics
        .filter((diagnostic) => diagnostic.severity !== "info")
        .slice(0, 8)
        .map((diagnostic) => `${String(diagnostic.code)}: ${diagnostic.message}`),
    }));
    if (requests.length === 0) continue;
    const decisions = new Map<string, AmbiguityDecision>();
    for (const request of requests) {
      let decision: AmbiguityDecision | null = null;
      try {
        decision = await resolveWithTimeout(resolver, request, timeoutMs);
      } catch {
        // Any resolver failure degrades to the deterministic default.
        decision = null;
      }
      const validated = validateAmbiguityDecision(request, decision);
      decisions.set(
        ambiguityKey(request),
        validated ?? { optionId: request.heuristic, escalation: null },
      );
    }
    byUnit.set(unit.filename, decisions);
  }
  return byUnit;
}

// Export-signature summaries of a unit's DIRECT dependencies (adr §3: the only
// cross-unit context an escalation may carry — never the whole project).
function directDependencyContracts(
  unit: AnalyzedUnit,
  graph: ModuleGraphModel,
  analyzed: ReadonlyMap<string, AnalyzedUnit>,
): readonly { readonly module: string; readonly exports: readonly string[] }[] {
  const node = graph.modules[unit.filename];
  if (node === undefined) return [];
  const contracts: { module: string; exports: readonly string[] }[] = [];
  const seen = new Set<string>();
  for (const graphImport of node.imports) {
    if (graphImport.importKind !== "static" || graphImport.resolvedModuleId === null) continue;
    if (seen.has(graphImport.resolvedModuleId)) continue;
    seen.add(graphImport.resolvedModuleId);
    const dep = analyzed.get(graphImport.resolvedModuleId);
    if (dep === undefined) continue;
    const contract = extractModuleContract({
      filename: dep.filename,
      source: "",
      parseResult: dep.parseResult,
      model: dep.model,
    });
    contracts.push({
      module: dep.filename,
      exports: contract.exports.map((entry) => `${entry.name}: ${entry.kind}`).slice(0, 24),
    });
  }
  return contracts;
}

async function resolveWithTimeout(
  resolver: AmbiguityResolver,
  request: AmbiguityRequest,
  timeoutMs: number,
): Promise<AmbiguityDecision | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
    // Do not keep the process alive for an escalation timer.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  });
  try {
    return await Promise.race([resolver.resolve(request, controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Deterministic target module path policy (roadmap M4 §8): pkg/mod.py -> pkg/mod.<ext>,
// pkg/__init__.py -> pkg/index.<ext>. Single source of truth for emitter and importer.
function extensionFor(target: TargetLanguage): ".js" | ".ts" | ".py" {
  return target === "typescript" ? ".ts" : target === "python" ? ".py" : ".js";
}

export function targetModulePath(sourceModuleId: string, extension: ".js" | ".ts" | ".py"): string {
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
  s3?: S3StageInput,
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

  // WS F: async boundary propagation when a sync-to-async module is in play. The
  // wiring layer passes `asyncBoundaryModules` (from the registry); without it no
  // propagation runs and every signature stays synchronous.
  let asyncFunctions: Map<string, Set<string>> | undefined;
  if (options.asyncBoundaryModules !== undefined && options.asyncBoundaryModules.length > 0) {
    const unitFunctions = new Map<string, ReturnType<typeof collectFunctionCalls>>();
    const unitImports = new Map<string, Map<string, { unit: string; function: string }>>();
    const moduleIds = new Set(analyzed.map((unit) => unit.filename));
    for (const unit of analyzed) {
      unitFunctions.set(unit.filename, collectFunctionCalls(unit.filename, unit.parseResult.ast));
      unitImports.set(
        unit.filename,
        collectImportedFunctions(unit.filename, unit.parseResult.ast, graph, moduleIds),
      );
    }
    const boundary = options.asyncBoundaryModules.find((module) =>
      analyzed.some((unit) =>
        (unit.parseResult.module?.imports ?? []).some(
          (entry) =>
            entry.moduleSpecifier === module || entry.moduleSpecifier.startsWith(`${module}.`),
        ),
      ),
    );
    if (boundary !== undefined) {
      asyncFunctions = propagateAsync(unitFunctions, unitImports, boundary);
    }
  }

  // M8: resolve engine-classified ambiguous constructs BEFORE lowering. Lowering
  // stays synchronous and deterministic; the pipeline only forwards the chosen
  // option (validated against the engine-offered set) with its provenance.
  const ambiguityByUnit = await resolveAmbiguities(options, analyzed, graph);

  // Stage: translate units in dependency order (deterministic; graph.order).
  const analyzedById = new Map(analyzed.map((unit) => [unit.filename, unit]));
  const emittedFiles: EmittedFile[] = [];
  const ledger: LedgerEntry[] = [];
  for (const moduleId of graph.order) {
    const unit = analyzed.find((candidate) => candidate.filename === moduleId);
    if (unit === undefined) continue;
    const ambiguity = ambiguityByUnit.get(unit.filename);
    const emission = await options.translateUnit.translateUnit(unit, graph, {
      analyzed: analyzedById,
      ...(asyncFunctions === undefined ? {} : { asyncFunctions }),
      ...(ambiguity === undefined ? {} : { ambiguity }),
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
    (options.target === "typescript" || options.target === "python") &&
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
  // Stage: S3 dependencies (WS G) — runs on the emitted files with the graph- and
  // registry-derived verdicts; skipped honestly when no wiring data exists (the
  // claim ladder caps at level 2 without it).
  if (s3 !== undefined && emittedFiles.length > 0) {
    const filesByName = new Map(emittedFiles.map((file) => [file.targetPath, file.content]));
    stages.push(
      validateDependencies({
        files: filesByName,
        mappedModules: s3.mappedModules,
        unsupportedModules: s3.unsupportedModules,
        sourceImports: s3.sourceImports,
        targetPathFor: (sourceModuleId: string) =>
          targetModulePath(sourceModuleId, extensionFor(options.target)),
      }),
    );
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
    sourceLanguage: sourceLanguageOf(inputs.map((input) => input.parseResult)),
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
    validationStages: stages,
  };
}
