// Project runner (roadmap M6/M10): the wiring layer that turns a source project
// directory into a translated target project with .ctrans/ artifacts. M10 owns
// the full S1-S7 orchestration: static stages from the pipeline (S1-S3), build
// (S4), sandboxed tests (S5), differential (S6), opt-in smoke (S7), truthful
// capability skips, flaky policy, and project-mode repair re-validated through the
// SAME S5/S6 path. core stays sandbox-agnostic; this module (CLI layer) composes.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createPyToJsTranslator, PytestToVitestMapper } from "@ctrans/codegen-js";
import {
  CTransError,
  DEFAULT_INTAKE_CAPS,
  analyzeModule,
  buildModuleGraph,
  computeClaimLevel,
  discoverProjectFiles,
  isTestModulePath,
  readProjectFile,
  runPipeline,
  targetModulePath,
  validateDependencies,
  validateTranslationReport,
  type AmbiguityResolver,
  type IntMode,
  type LedgerEntry,
  type ModuleGraphModel,
  type PipelineResult,
  type StageResult,
  type TargetLanguage,
  type UnitTranslator,
  type SyntaxValidator,
  type TypeValidator,
} from "@ctrans/core";
import { createPythonBridgeParser } from "@ctrans/parser-py";
import { createOxcSyntaxValidator, OracleTypeValidator } from "@ctrans/parser-js";
import { MODULE_MAPPINGS, createRegistryLookup } from "@ctrans/registry";
import {
  classifyFailures,
  runRepairLoop,
  RepairJournal,
  stateHash,
  JOURNAL_DIRECTORY,
  JOURNAL_FILE,
  type RepairProposer,
  type RepairRunResult,
} from "@ctrans/repair";
import {
  SandboxIsolationError,
  type ContainerRunOptions,
  type SandboxCapabilities,
} from "@ctrans/sandbox";
import {
  assembleStages,
  assertStageEvidence,
  runS4,
  runS5,
  runS6,
  runS7,
  sourceRunnerScript,
  STAGE_ORDER,
  type S5Result,
  type S6Result,
  type S7Result,
  type SmokeHarness,
  type TestOutcome,
} from "@ctrans/validator";

export interface ProjectRepairOptions {
  readonly proposer: RepairProposer;
  readonly maxAttemptsPerUnit?: number;
  readonly maxAttemptsPerRun?: number;
  readonly now?: () => Date;
}

export interface ProjectProgressEvent {
  readonly event: string;
  readonly message: string;
  readonly stage?: string;
  readonly status?: string;
}

export interface ProjectRunOptions {
  readonly sourceRoot: string;
  readonly outputRoot: string;
  readonly target: TargetLanguage;
  readonly intMode: IntMode;
  // S5/S6 execution (default true): sandboxed vitest run + differential comparison.
  readonly runTests?: boolean;
  readonly sandbox: SandboxCapabilities;
  readonly nodePath: string;
  readonly pythonPath: string;
  // Toolchain-provided runner materialization (nothing is installed at validation
  // time; security.md §5): the repo node_modules (symlinked into the sandbox
  // workspace), the vitest CLI entry, and the pinned TypeScript build entry.
  readonly nodeModulesPath: string;
  readonly vitestEntryPath: string;
  readonly typescriptEntryPath: string;
  readonly timeoutMs?: number;
  // Strict container execution (M10): when present, all executed stages run in
  // the container and refuse to fall back to the host.
  readonly container?: ContainerRunOptions;
  readonly strict?: boolean;
  // Opt-in S7 smoke harness (project mode only).
  readonly smoke?: SmokeHarness;
  // Project-mode repair (M10): candidates are re-validated through the real
  // S1-S6 stage path; S5/S6 must be executable for the baseline or repair refuses.
  readonly repair?: ProjectRepairOptions;
  // M8: optional AI escalation for engine-classified ambiguous constructs.
  readonly resolveAmbiguity?: AmbiguityResolver;
  // M11 progress events (stderr at the CLI; never mixed into JSON stdout).
  readonly onProgress?: (event: ProjectProgressEvent) => void;
}

export interface ProjectRunReport {
  readonly pipeline: PipelineResult;
  // The full final stage list S1-S7 (after any accepted repair).
  readonly stages: readonly StageResult[];
  readonly testOutcomes: readonly TestOutcome[];
  readonly s5: S5Result | null;
  readonly s6: S6Result | null;
  readonly s7: S7Result | null;
  readonly translatedTestFiles: readonly string[];
  readonly unsupportedTestConstructs: readonly {
    readonly file: string;
    readonly kind: string;
    readonly reason: string;
  }[];
  readonly skipped: readonly { readonly what: string; readonly reason: string }[];
  readonly repair: RepairRunResult | null;
  readonly repairJournal: string | null;
  readonly repairJournalRecovered: boolean;
}

interface PreparedProject {
  readonly options: ProjectRunOptions;
  readonly sourceRoot: string;
  readonly outputRoot: string;
  readonly discovery: ReturnType<typeof discoverProjectFiles>;
  readonly graph: ModuleGraphModel;
  readonly pipeline: PipelineResult;
  readonly emitted: ReadonlyMap<string, string>;
  readonly sourceTargetPaths: ReadonlySet<string>;
  readonly translatedTestFiles: ReadonlyMap<string, string>;
  readonly testNamesByModule: readonly {
    readonly path: string;
    readonly testNames: readonly string[];
  }[];
  readonly testTargetByModule: ReadonlyMap<string, string>;
  readonly testLedger: readonly LedgerEntry[];
  readonly unsupportedTestConstructs: ProjectRunReport["unsupportedTestConstructs"];
  readonly sourceContents: ReadonlyMap<string, string>;
  readonly initialSkipped: readonly { readonly what: string; readonly reason: string }[];
  readonly sourceImports: ReadonlyMap<string, readonly string[]>;
  readonly mappedModules: ReadonlySet<string>;
  readonly unsupportedModules: ReadonlySet<string>;
  readonly syntax: SyntaxValidator;
  readonly types: TypeValidator;
}

interface ProjectValidation {
  readonly stages: readonly StageResult[];
  readonly s5: S5Result | null;
  readonly s6: S6Result | null;
  readonly s7: S7Result | null;
  readonly testOutcomes: readonly TestOutcome[];
  readonly skipped: readonly { readonly what: string; readonly reason: string }[];
}

export async function runProject(options: ProjectRunOptions): Promise<ProjectRunReport> {
  options.onProgress?.({ event: "project:translate", message: "translating source project" });
  const prepared = await prepareProject(options);
  options.onProgress?.({
    event: "project:translated",
    message: `translated ${String(prepared.pipeline.emittedFiles.length)} file(s)`,
  });
  const baseline = await validateProjectFiles(prepared, prepared.emitted, {
    staticStages: prepared.pipeline.validationStages,
  });
  let files = prepared.emitted;
  let validation = baseline;
  let repair: RepairRunResult | null = null;
  let repairJournal: string | null = null;
  let repairJournalRecovered = false;

  if (options.repair !== undefined) {
    const repaired = await runProjectRepair(prepared, baseline, options.repair);
    files = repaired.files;
    validation = repaired.validation;
    repair = repaired.repair;
    repairJournal = repaired.journalPath;
    repairJournalRecovered = repaired.journalRecovered;
  }

  const report = buildReport(prepared, validation, repairJournal);
  writeProjectOutput(prepared, files, validation, report);
  return {
    pipeline: {
      ...prepared.pipeline,
      emittedFiles: prepared.pipeline.emittedFiles.map((file) => ({
        ...file,
        content: files.get(file.targetPath) ?? file.content,
      })),
      report,
    },
    stages: validation.stages,
    testOutcomes: validation.testOutcomes,
    s5: validation.s5,
    s6: validation.s6,
    s7: validation.s7,
    translatedTestFiles: [...prepared.translatedTestFiles.keys()],
    unsupportedTestConstructs: prepared.unsupportedTestConstructs,
    skipped: validation.skipped,
    repair,
    repairJournal,
    repairJournalRecovered,
  };
}

async function prepareProject(options: ProjectRunOptions): Promise<PreparedProject> {
  const sourceRoot = resolve(options.sourceRoot);
  const outputRoot = resolve(options.outputRoot);
  if (sourceRoot === outputRoot) {
    throw new CTransError(
      "PROJECT-OUTPUT-EQUALS-SOURCE",
      "the output directory must differ from the source project root",
    );
  }
  const discovery = discoverProjectFiles(sourceRoot, DEFAULT_INTAKE_CAPS);
  if (discovery.capExceeded !== null) {
    throw new CTransError(
      "PROJECT-INTAKE-CAP",
      `project exceeds the ${String(DEFAULT_INTAKE_CAPS.maxFiles)}-file intake cap (docs/security.md §6)`,
    );
  }

  const parser = await createPythonBridgeParser();
  const units: {
    readonly moduleId: string;
    readonly parseResult: Awaited<ReturnType<typeof parser.parse>>;
    readonly isTest: boolean;
  }[] = [];
  const sourceContents = new Map<string, string>();
  for (const file of discovery.files) {
    try {
      const content = readProjectFile(sourceRoot, file);
      const parseResult = await parser.parse(content, { filename: file.relativePath });
      sourceContents.set(file.relativePath, content);
      units.push({
        moduleId: file.relativePath,
        parseResult,
        isTest: isTestModulePath(file.relativePath),
      });
    } catch {
      // A parse failure is a reported skip, never a silent drop (recorded below).
    }
  }
  const parsedIds = new Set(units.map((unit) => unit.moduleId));
  const skipped: { what: string; reason: string }[] = [];
  for (const oversized of discovery.skippedOversized) {
    skipped.push({ what: oversized, reason: "file exceeds the per-file size cap" });
  }
  for (const file of discovery.files) {
    if (!parsedIds.has(file.relativePath)) {
      skipped.push({ what: file.relativePath, reason: "parse failed (invalid UTF-8 or syntax)" });
    }
  }

  const sourceUnits = units.filter((unit) => !unit.isTest);
  const testUnits = units.filter((unit) => unit.isTest);
  const graph = buildModuleGraph(
    units.map((unit) => ({ filename: unit.moduleId, parseResult: unit.parseResult })),
  );
  const analyzed = new Map(
    units.map((unit) => [
      unit.moduleId,
      {
        filename: unit.moduleId,
        parseResult: unit.parseResult,
        model: analyzeModule(unit.parseResult),
      },
    ]),
  );
  const registry = createRegistryLookup();
  const translatedTestFiles = new Map<string, string>();
  const testTargetByModule = new Map<string, string>();
  const testNamesByModule: { path: string; testNames: string[] }[] = [];
  const unsupportedTestConstructs: { file: string; kind: string; reason: string }[] = [];
  const testLedger: LedgerEntry[] = [];
  const testHelpers = new Set<string>();
  const testExceptions = new Set<string>();
  for (const unit of testUnits) {
    const mapper = new PytestToVitestMapper(analyzed.get(unit.moduleId)!, {
      graph,
      conftestFixtures: new Map(),
      analyzed,
      registry,
    });
    const translated = await mapper.translateModule();
    translatedTestFiles.set(translated.targetPath, translated.content);
    testTargetByModule.set(unit.moduleId, translated.targetPath);
    testNamesByModule.push({ path: unit.moduleId, testNames: [...translated.testNames] });
    for (const entry of translated.unsupported) {
      unsupportedTestConstructs.push({
        file: unit.moduleId,
        kind: entry.kind,
        reason: entry.reason,
      });
    }
    testLedger.push(...translated.ledger);
    for (const helper of translated.helpers) testHelpers.add(helper);
    for (const className of translated.exceptions) testExceptions.add(className);
  }

  if (options.target !== "typescript" && options.target !== "javascript") {
    throw new CTransError(
      "PROJECT-TARGET-UNSUPPORTED",
      "project mode currently supports the python→typescript/javascript directions only (pytest→vitest mapping)",
    );
  }
  const translator = await createPyToJsTranslator(options.target, {
    intMode: options.intMode,
    registry,
  });
  const unitTranslator: UnitTranslator = {
    target: options.target,
    translateUnit: (unit, unitGraph, context) => translator.translateUnit(unit, unitGraph, context),
    finalizeUnits: async () => {
      translator.noteExternalHelpers([...testHelpers], [...testExceptions]);
      return translator.finalizeUnits();
    },
  };
  const sourceImports = new Map(
    sourceUnits.map((unit) => [
      unit.moduleId,
      (unit.parseResult.module?.imports ?? []).map((entry) => entry.moduleSpecifier),
    ]),
  );
  const mappedModules = new Set([
    // __future__ imports are compile-time directives: the emitter drops them
    // (no target emission), so S3 must not count them as unmapped externals.
    "__future__",
    ...MODULE_MAPPINGS.filter((m) => m.syncAsync !== undefined || m.emit.kind === "rewrite").map(
      (m) => m.module,
    ),
  ]);
  const unsupportedModules = new Set(["ctypes", "curses", "tkinter"]);
  const pipeline = await runPipeline(
    sourceUnits.map((unit) => ({ filename: unit.moduleId, parseResult: unit.parseResult })),
    {
      target: options.target,
      intMode: options.intMode,
      translateUnit: unitTranslator,
      validateSyntax: await createOxcSyntaxValidator(),
      // S2 is TypeScript-only (no JS type checker exists); the pipeline skips
      // honestly for JS targets, which caps the ladder at level 1 there.
      ...(options.target === "typescript" ? { validateTypes: new OracleTypeValidator() } : {}),
      asyncBoundaryModules: ["requests"],
      ...(options.resolveAmbiguity === undefined
        ? {}
        : { resolveAmbiguity: options.resolveAmbiguity }),
    },
    { sourceImports, mappedModules, unsupportedModules },
  );

  const emitted = new Map<string, string>();
  const sourceTargetPaths = new Set<string>();
  for (const file of pipeline.emittedFiles) {
    emitted.set(file.targetPath, file.content);
    sourceTargetPaths.add(file.targetPath);
  }
  for (const [path, content] of translatedTestFiles) emitted.set(path, content);

  return {
    options,
    sourceRoot,
    outputRoot,
    discovery,
    graph,
    pipeline,
    emitted,
    sourceTargetPaths,
    translatedTestFiles,
    testNamesByModule,
    testTargetByModule,
    testLedger,
    unsupportedTestConstructs,
    sourceContents,
    initialSkipped: skipped,
    sourceImports,
    mappedModules,
    unsupportedModules,
    syntax: await createOxcSyntaxValidator(),
    types: new OracleTypeValidator(),
  };
}

async function runStaticStages(
  prepared: PreparedProject,
  files: ReadonlyMap<string, string>,
): Promise<readonly StageResult[]> {
  const subset = new Map([...files].filter(([path]) => prepared.sourceTargetPaths.has(path)));
  const list = [...subset.entries()].map(([path, content]) => ({ path, content }));
  const s1 = await prepared.syntax.validate(
    list.map((file) => ({ ...file, language: prepared.options.target })),
  );
  const s2: StageResult =
    prepared.options.target === "typescript"
      ? await prepared.types.validate(list)
      : {
          stage: "S2-types",
          status: "skipped",
          reason: "no JavaScript type checker exists (S2 is TypeScript-only)",
          details: [],
        };
  const s3: StageResult =
    subset.size === 0
      ? {
          stage: "S3-dependencies",
          status: "skipped",
          reason: "no emitted source files",
          details: [],
        }
      : validateDependencies({
          files: subset,
          mappedModules: prepared.mappedModules,
          unsupportedModules: prepared.unsupportedModules,
          sourceImports: prepared.sourceImports,
          targetPathFor: (sourceModuleId: string) =>
            targetModulePath(
              sourceModuleId,
              prepared.options.target === "typescript" ? ".ts" : ".js",
            ),
        });
  return [s1, s2, s3];
}

// The authoritative candidate path for project repair: exactly the same stage
// implementations, toolchain, sandbox/container configuration, and evidence
// rules as the baseline. Nothing is cached across candidates except the prepared
// translation inputs.
async function validateProjectFiles(
  prepared: PreparedProject,
  files: ReadonlyMap<string, string>,
  options: { readonly staticStages?: readonly StageResult[] } = {},
): Promise<ProjectValidation> {
  const optionsForRun = prepared.options;
  const staticStages = options.staticStages ?? (await runStaticStages(prepared, files));
  const s1 = staticStages.find((stage) => stage.stage === "S1-syntax");
  const skipped: { what: string; reason: string }[] = [...prepared.initialSkipped];
  const s4 =
    s1?.status === "fail"
      ? ({
          stage: "S4-build",
          status: "skipped",
          reason: "S1 syntax validation failed; build not attempted",
          details: [],
        } satisfies StageResult)
      : await runS4(
          { files, target: optionsForRun.target === "typescript" ? "typescript" : "javascript" },
          {
            capabilities: optionsForRun.sandbox,
            nodePath: optionsForRun.nodePath,
            pythonPath: optionsForRun.pythonPath,
            nodeModulesPath: optionsForRun.nodeModulesPath,
            typescriptEntryPath: optionsForRun.typescriptEntryPath,
            ...(optionsForRun.timeoutMs === undefined
              ? {}
              : { timeoutMs: optionsForRun.timeoutMs }),
            ...(optionsForRun.strict === true ? { strict: true } : {}),
            ...(optionsForRun.container === undefined
              ? {}
              : { container: optionsForRun.container }),
          },
        );
  optionsForRun.onProgress?.({
    event: "stage:done",
    stage: "S4-build",
    status: s4.status,
    message: `S4-build ${s4.status}`,
  });

  const testsExecutable =
    prepared.translatedTestFiles.size > 0 &&
    optionsForRun.runTests !== false &&
    optionsForRun.target === "typescript";
  let s5: S5Result | null = null;
  let s6: S6Result | null = null;
  let s7: S7Result | null = null;
  let testOutcomes: readonly TestOutcome[] = [];
  let s5Stage: StageResult;
  let s6Stage: StageResult;
  if (!testsExecutable) {
    const reason =
      optionsForRun.runTests === false
        ? "test execution disabled"
        : optionsForRun.target !== "typescript"
          ? "test execution requires the TypeScript target (the pytest mapper emits .test.ts)"
          : "no pytest test modules in the project";
    s5Stage = { stage: "S5-tests", status: "skipped", reason, details: [] };
    s6Stage = {
      stage: "S6-differential",
      status: "skipped",
      reason: "S5 did not run",
      details: [],
    };
    skipped.push({ what: "S5-tests", reason });
    skipped.push({ what: "S6-differential", reason: "S5 did not run" });
  } else {
    try {
      s5 = await runS5(
        { files, testFiles: [...prepared.translatedTestFiles.keys()] },
        {
          capabilities: optionsForRun.sandbox,
          nodeModulesPath: optionsForRun.nodeModulesPath,
          vitestEntryPath: optionsForRun.vitestEntryPath,
          nodePath: optionsForRun.nodePath,
          ...(optionsForRun.timeoutMs === undefined ? {} : { timeoutMs: optionsForRun.timeoutMs }),
          ...(optionsForRun.strict === true ? { strict: true } : {}),
          ...(optionsForRun.container === undefined ? {} : { container: optionsForRun.container }),
        },
      );
    } catch (error) {
      if (!(error instanceof SandboxIsolationError)) throw error;
      const reason = `enforced network isolation is unavailable (bwrap) — sandboxed execution refused: ${error.message}`;
      s5Stage = { stage: "S5-tests", status: "skipped", reason, details: [] };
      s6Stage = {
        stage: "S6-differential",
        status: "skipped",
        reason: "S5 did not run (isolation unavailable)",
        details: [],
      };
      skipped.push({ what: "S5-tests", reason });
      skipped.push({ what: "S6-differential", reason: "S5 did not run" });
    }
    if (s5 !== null) {
      s5Stage = s5;
      testOutcomes = s5.outcomes;
      if (s5.status === "skipped") {
        skipped.push({ what: "S5-tests", reason: s5.reason ?? "S5 skipped" });
        s6Stage = {
          stage: "S6-differential",
          status: "skipped",
          reason: "S5 did not produce usable outcomes",
          details: [],
        };
        skipped.push({ what: "S6-differential", reason: "S5 did not produce usable outcomes" });
      } else {
        const sourceFiles = new Map<string, string>();
        for (const [moduleId, content] of prepared.sourceContents) {
          sourceFiles.set(moduleId, content);
        }
        try {
          s6 = await runS6(
            {
              capabilities: optionsForRun.sandbox,
              nodePath: optionsForRun.nodePath,
              pythonPath: optionsForRun.pythonPath,
              ...(optionsForRun.timeoutMs === undefined
                ? {}
                : { timeoutMs: optionsForRun.timeoutMs }),
              ...(optionsForRun.strict === true ? { strict: true } : {}),
              ...(optionsForRun.container === undefined
                ? {}
                : { container: optionsForRun.container }),
            },
            {
              sourceFiles,
              sourceTestModules: prepared.testNamesByModule,
              targetOutcomes: s5.outcomes,
              sourceRunnerScript: sourceRunnerScript(),
            },
          );
        } catch (error) {
          if (!(error instanceof SandboxIsolationError)) throw error;
          skipped.push({
            what: "S6-differential",
            reason: `enforced network isolation is unavailable (bwrap) — execution refused: ${error.message}`,
          });
        }
        s6Stage =
          s6 ??
          ({
            stage: "S6-differential",
            status: "skipped",
            reason:
              "enforced network isolation unavailable; execution refused (no silent downgrade)",
            details: [],
          } satisfies StageResult);
        if (s6?.status === "skipped") {
          skipped.push({ what: "S6-differential", reason: s6.reason ?? "S6 skipped" });
        }
      }
    } else {
      s5Stage ??= {
        stage: "S5-tests",
        status: "skipped",
        reason: "S5 did not run",
        details: [],
      };
      s6Stage ??= {
        stage: "S6-differential",
        status: "skipped",
        reason: "S5 did not run",
        details: [],
      };
    }
  }

  if (optionsForRun.smoke === undefined) {
    s7 = null;
    skipped.push({ what: "S7-smoke", reason: "no smoke harness provided (opt-in)" });
  } else if (s4.status === "fail") {
    s7 = null;
    skipped.push({ what: "S7-smoke", reason: "S4 build failed; smoke not attempted" });
  } else {
    s7 = await runS7(
      { files, harness: optionsForRun.smoke },
      {
        capabilities: optionsForRun.sandbox,
        ...(optionsForRun.timeoutMs === undefined ? {} : { timeoutMs: optionsForRun.timeoutMs }),
        ...(optionsForRun.strict === true ? { strict: true } : {}),
        ...(optionsForRun.container === undefined ? {} : { container: optionsForRun.container }),
      },
    );
    if (s7.status === "skipped") {
      skipped.push({ what: "S7-smoke", reason: s7.reason ?? "S7 skipped" });
    }
  }

  optionsForRun.onProgress?.({
    event: "stage:done",
    stage: "S5-tests",
    status: s5Stage.status,
    message: `S5-tests ${s5Stage.status}`,
  });
  optionsForRun.onProgress?.({
    event: "stage:done",
    stage: "S6-differential",
    status: s6Stage.status,
    message: `S6-differential ${s6Stage.status}`,
  });
  if (s7 !== null) {
    optionsForRun.onProgress?.({
      event: "stage:done",
      stage: "S7-smoke",
      status: s7.status,
      message: `S7-smoke ${s7.status}`,
    });
  }
  const executed: StageResult[] = [...staticStages, s4, s5Stage, s6Stage];
  if (s7 !== null) executed.push(s7);
  const stages = assembleStages(executed, STAGE_ORDER, (name) =>
    name === "S7-smoke"
      ? optionsForRun.smoke === undefined
        ? "no smoke harness provided (opt-in)"
        : "smoke not attempted"
      : `stage ${name} was not executed`,
  );
  assertStageEvidence(stages, { required: STAGE_ORDER });
  if (optionsForRun.strict === true) {
    // Strict mode promises that every executed stage ran under the container
    // boundary. An infrastructure skip means that promise was not kept, so this is
    // a hard failure — never a report that silently looks successful.
    const infrastructureSkips = stages.filter(
      (stage) =>
        stage.status === "skipped" &&
        /infrastructure|container|failed to spawn|timed out|timed out|unavailable|refused|runner failed/i.test(
          stage.reason ?? "",
        ),
    );
    if (infrastructureSkips.length > 0) {
      throw new CTransError(
        "SANDBOX-STRICT-VALIDATION-FAILED",
        `strict validation could not run: ${infrastructureSkips
          .map((stage) => `${stage.stage}: ${stage.reason ?? "skipped"}`)
          .join("; ")}`,
      );
    }
  }
  return {
    stages,
    s5,
    s6,
    s7,
    testOutcomes,
    skipped,
  };
}

interface ProjectRepairResult {
  readonly files: ReadonlyMap<string, string>;
  readonly validation: ProjectValidation;
  readonly repair: RepairRunResult;
  readonly journalPath: string;
  readonly journalRecovered: boolean;
}

async function runProjectRepair(
  prepared: PreparedProject,
  baseline: ProjectValidation,
  options: ProjectRepairOptions,
): Promise<ProjectRepairResult> {
  const now = options.now ?? (() => new Date());
  const validations = new Map<string, ProjectValidation>();
  validations.set(stateHash(prepared.emitted), baseline);

  // Test failures name the translated TEST file. Attribute them to the source
  // units that module statically imports — direct graph evidence, never a guess.
  const testSources = new Map<string, ReadonlySet<string>>();
  for (const [moduleId, testTarget] of prepared.testTargetByModule) {
    const node = prepared.graph.modules[moduleId];
    const targets = new Set<string>();
    for (const edge of node?.imports ?? []) {
      const imported = edge.resolvedModuleId;
      if (imported === null || imported === undefined) continue;
      if (isTestModulePath(imported)) continue;
      const target = prepared.pipeline.emittedFiles.find(
        (file) => file.sourcePath === imported,
      )?.targetPath;
      if (target !== undefined) targets.add(target);
    }
    testSources.set(testTarget, targets);
  }
  const expandAttribution = (
    failures: ReturnType<typeof classifyFailures>,
  ): ReturnType<typeof classifyFailures> =>
    failures.map((failure) => {
      const details = [...failure.details];
      for (const detail of failure.details) {
        for (const [testTarget, sources] of testSources) {
          if (detail.startsWith(`${testTarget}:`) || detail.startsWith(`${testTarget} /`)) {
            for (const sourceTarget of sources) {
              details.push(`${sourceTarget}: ${detail}`);
            }
          }
        }
      }
      return { ...failure, details: [...new Set(details)] };
    });
  const failures = expandAttribution(
    classifyFailures(baseline.stages, [...prepared.pipeline.ledger, ...prepared.testLedger]),
  );

  const sourceUnits = prepared.pipeline.emittedFiles
    .map((file) => ({
      unit: file.sourcePath,
      targetPath: file.targetPath,
      sourceText: prepared.sourceContents.get(file.sourcePath) ?? "",
    }))
    .filter((unit) => unit.sourceText.trim() !== "");

  const repair = await runRepairLoop(
    {
      files: prepared.emitted,
      units: sourceUnits,
      stages: baseline.stages,
      ledger: [...prepared.pipeline.ledger, ...prepared.testLedger],
      failures,
    },
    {
      proposer: options.proposer,
      validate: async (candidate) => {
        const validation = await validateProjectFiles(prepared, candidate);
        validations.set(stateHash(candidate), validation);
        return validation.stages;
      },
      // Project mode REQUIRES executable behavioral evidence on every accepted
      // candidate; S1-S3-only acceptance is not available here.
      requirePassing: ["S5-tests", "S6-differential"],
      ...(options.maxAttemptsPerUnit === undefined
        ? {}
        : { maxAttemptsPerUnit: options.maxAttemptsPerUnit }),
      ...(options.maxAttemptsPerRun === undefined
        ? {}
        : { maxAttemptsPerRun: options.maxAttemptsPerRun }),
      now,
    },
  );
  const validation = validations.get(repair.finalStateHash) ?? baseline;
  const timestamp = now().toISOString();
  const filesChanged = [
    ...new Set(
      repair.acceptedUnits
        .map(
          (unitId) =>
            prepared.pipeline.emittedFiles.find((file) => file.sourcePath === unitId)?.targetPath,
        )
        .filter((path): path is string => path !== undefined),
    ),
  ].sort();
  const loaded = RepairJournal.load(prepared.outputRoot);
  const journal = new RepairJournal();
  for (const previous of loaded.runs) journal.append(previous);
  journal.append({
    runId: `repair-${timestamp.replaceAll(/[:.]/g, "-")}-${repair.baselineStateHash.slice(0, 8)}`,
    timestamp,
    stopReason: repair.stopReason,
    baselineStateHash: repair.baselineStateHash,
    finalStateHash: repair.finalStateHash,
    acceptedUnits: repair.acceptedUnits,
    filesChanged,
    attempts: repair.attempts,
  });
  RepairJournal.write(prepared.outputRoot, journal);
  return {
    files: repair.files,
    validation,
    repair,
    journalPath: `${JOURNAL_DIRECTORY}/${JOURNAL_FILE}`,
    journalRecovered: loaded.recovered,
  };
}

function buildReport(
  prepared: PreparedProject,
  validation: ProjectValidation,
  repairJournal: string | null,
): ReturnType<typeof validateTranslationReport> {
  const testModuleEntries = prepared.testNamesByModule.map((module) => {
    const counts = { deterministic: 0, semantic: 0, ambiguous: 0, unsupported: 0 };
    for (const entry of prepared.testLedger) {
      if (entry.unit === module.path) counts[entry.decision] += 1;
    }
    return {
      source: module.path,
      target:
        prepared.testTargetByModule.get(module.path) ?? module.path.replace(/\.py$/, ".test.ts"),
      status: counts.unsupported > 0 ? ("partially-translated" as const) : ("translated" as const),
      decisionCounts: counts,
    };
  });
  return validateTranslationReport({
    ...prepared.pipeline.report,
    files: [...prepared.pipeline.report.files, ...testModuleEntries],
    decisionTotals: {
      deterministic:
        prepared.pipeline.report.decisionTotals.deterministic +
        prepared.testLedger.filter((entry) => entry.decision === "deterministic").length,
      semantic:
        prepared.pipeline.report.decisionTotals.semantic +
        prepared.testLedger.filter((entry) => entry.decision === "semantic").length,
      ambiguous:
        prepared.pipeline.report.decisionTotals.ambiguous +
        prepared.testLedger.filter((entry) => entry.decision === "ambiguous").length,
      unsupported:
        prepared.pipeline.report.decisionTotals.unsupported +
        prepared.testLedger.filter((entry) => entry.decision === "unsupported").length,
    },
    warnings: [
      ...new Set([
        ...prepared.pipeline.report.warnings,
        ...prepared.testLedger.flatMap((entry) => entry.warnings),
      ]),
    ],
    validationStages: validation.stages.map((stage) => ({
      stage: stage.stage,
      status: stage.status,
      reason: stage.reason,
    })),
    claimLevel: computeClaimLevel(validation.stages),
    repairJournal,
  });
}

function writeProjectOutput(
  prepared: PreparedProject,
  files: ReadonlyMap<string, string>,
  validation: ProjectValidation,
  report: ReturnType<typeof validateTranslationReport>,
): void {
  const { outputRoot } = prepared;
  for (const [targetPath, content] of files) {
    const destination = join(outputRoot, targetPath);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, content);
  }
  const ctransDir = join(outputRoot, ".ctrans");
  mkdirSync(ctransDir, { recursive: true });
  writeFileSync(
    join(ctransDir, "ledger.json"),
    JSON.stringify([...prepared.pipeline.ledger, ...prepared.testLedger], null, 2) + "\n",
  );
  writeFileSync(join(ctransDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  writeRunArtifact(ctransDir, "test-results.json", validation.s5);
  writeRunArtifact(ctransDir, "differential.json", validation.s6);
  // Smoke evidence: verdicts only, never captured source/output content.
  const smokePath = join(ctransDir, "smoke.json");
  if (validation.s7 === null) {
    rmSync(smokePath, { force: true });
  } else {
    writeFileSync(
      smokePath,
      JSON.stringify(
        {
          stage: "S7-smoke",
          status: validation.s7.status,
          reason: validation.s7.reason,
          exitCode: validation.s7.exitCode,
        },
        null,
        2,
      ) + "\n",
    );
  }
}

function writeRunArtifact(
  ctransDir: string,
  name: string,
  value: S5Result | S6Result | null,
): void {
  const path = join(ctransDir, name);
  if (value === null || value.status === "skipped") {
    rmSync(path, { force: true });
    return;
  }
  if (name === "test-results.json") {
    const s5 = value as S5Result;
    writeFileSync(
      path,
      JSON.stringify(
        {
          stage: "S5-tests",
          status: s5.status,
          outcomes: s5.outcomes,
          flaky: s5.flaky,
          rerunPerformed: s5.rerunPerformed,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  const s6 = value as S6Result;
  writeFileSync(
    path,
    JSON.stringify(
      {
        stage: "S6-differential",
        status: s6.status,
        matched: s6.matched,
        mismatched: s6.mismatched,
        sourceOnly: s6.sourceOnly,
        targetOnly: s6.targetOnly,
        flaky: s6.flaky,
      },
      null,
      2,
    ) + "\n",
  );
}
