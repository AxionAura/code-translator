// Project runner (roadmap M6 WS A/F/G): the wiring layer that turns a source
// project directory into a translated target project with .ctrans/ artifacts —
// discovery, translation (source modules through the pipeline, test modules
// through the pytest mapper), S1-S3 from the pipeline, S5/S6 through the sandbox,
// and the extended claim ladder. core stays sandbox-agnostic; this module (CLI
// layer) may compose core, codegen-js, parser-*, registry, sandbox, validator.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createPyToJsTranslator, PytestToVitestMapper } from "@ctrans/codegen-js";
import {
  DEFAULT_INTAKE_CAPS,
  buildModuleGraph,
  computeClaimLevel,
  discoverProjectFiles,
  isTestModulePath,
  analyzeModule,
  readProjectFile,
  runPipeline,
  validateTranslationReport,
  type IntMode,
  type LedgerEntry,
  type ModuleGraphModel,
  type PipelineResult,
  type StageResult,
  type TargetLanguage,
  type UnitTranslator,
  type ValidationStageName,
} from "@ctrans/core";
import { createPythonBridgeParser } from "@ctrans/parser-py";
import { createOxcSyntaxValidator, OracleTypeValidator } from "@ctrans/parser-js";
import { MODULE_MAPPINGS, createRegistryLookup } from "@ctrans/registry";
import { SandboxIsolationError, type SandboxCapabilities } from "@ctrans/sandbox";
import {
  runS5,
  runS6,
  sourceRunnerScript,
  type S5Result,
  type S6Result,
  type TestOutcome,
} from "@ctrans/validator";

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
  // workspace) and the vitest CLI entry inside it.
  readonly nodeModulesPath: string;
  readonly vitestEntryPath: string;
  readonly timeoutMs?: number;
}

export interface ProjectRunReport {
  readonly pipeline: PipelineResult;
  // The full stage list as executed (S1-S3 + S4 skipped + S5/S6 or skips).
  readonly stages: readonly StageResult[];
  readonly testOutcomes: readonly TestOutcome[];
  readonly s5: S5Result | null;
  readonly s6: S6Result | null;
  readonly translatedTestFiles: readonly string[];
  readonly unsupportedTestConstructs: readonly {
    readonly file: string;
    readonly kind: string;
    readonly reason: string;
  }[];
  readonly skipped: readonly { readonly what: string; readonly reason: string }[];
}

export async function runProject(options: ProjectRunOptions): Promise<ProjectRunReport> {
  const sourceRoot = resolve(options.sourceRoot);
  const outputRoot = resolve(options.outputRoot);
  if (sourceRoot === outputRoot) {
    throw new Error("the output directory must differ from the source project root");
  }
  const skipped: { what: string; reason: string }[] = [];

  // 1. Discovery (deterministic walk, exclusion list, symlink policy, caps).
  const discovery = discoverProjectFiles(sourceRoot, DEFAULT_INTAKE_CAPS);
  if (discovery.capExceeded !== null) {
    throw new Error(
      `project exceeds the ${String(DEFAULT_INTAKE_CAPS.maxFiles)}-file intake cap (docs/security.md §6)`,
    );
  }
  for (const oversized of discovery.skippedOversized) {
    skipped.push({ what: oversized, reason: "file exceeds the per-file size cap" });
  }

  // 2. Parse every discovered unit (sources AND test modules — tests are Python
  // too). A module whose parse fails is a reported skip, never a silent drop.
  const parser = await createPythonBridgeParser();
  const units: {
    readonly moduleId: string;
    readonly parseResult: Awaited<ReturnType<typeof parser.parse>>;
    readonly isTest: boolean;
  }[] = [];
  for (const file of discovery.files) {
    try {
      const parseResult = await parser.parse(readProjectFile(sourceRoot, file), {
        filename: file.relativePath,
      });
      units.push({
        moduleId: file.relativePath,
        parseResult,
        isTest: isTestModulePath(file.relativePath),
      });
    } catch (error) {
      skipped.push({
        what: file.relativePath,
        reason: `parse failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const sourceUnits = units.filter((unit) => !unit.isTest);
  const testUnits = units.filter((unit) => unit.isTest);

  // 3. Translate test modules through the pytest→vitest mapper FIRST: their runtime
  // helper/exception requirements join the shared runtime's union (the translator
  // finalizes the runtime from the union of every unit's requirements — tests are
  // units of the project too). The graph spans all units so test imports of
  // sibling source modules resolve.
  const graph: ModuleGraphModel = buildModuleGraph(
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

  // 4. Translate the source modules through the pipeline. The wrapper registers the
  // test requirements right before the translator finalizes the shared runtime.
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
  const pipeline = await runPipeline(
    sourceUnits.map((unit) => ({ filename: unit.moduleId, parseResult: unit.parseResult })),
    {
      target: options.target,
      intMode: options.intMode,
      translateUnit: unitTranslator,
      validateSyntax: await createOxcSyntaxValidator(),
      // S2 is TypeScript-only (no JS type checker exists); the pipeline skips
      // honestly for JS targets, which caps the ladder at level 1 there.
      validateTypes: new OracleTypeValidator(),
      asyncBoundaryModules: ["requests"],
    },
    {
      sourceImports: new Map(
        sourceUnits.map((unit) => [
          unit.moduleId,
          (unit.parseResult.module?.imports ?? []).map((entry) => entry.moduleSpecifier),
        ]),
      ),
      mappedModules: new Set([
        // __future__ imports are compile-time directives: the emitter drops them
        // (no target emission), so S3 must not count them as unmapped externals.
        "__future__",
        ...MODULE_MAPPINGS.filter(
          (m) => m.syncAsync !== undefined || m.emit.kind === "rewrite",
        ).map((m) => m.module),
      ]),
      unsupportedModules: new Set(["ctypes", "curses", "tkinter"]),
    },
  );

  // 5. Materialize the output tree (source translation + tests + shared runtime).
  const emitted = new Map<string, string>();
  for (const file of pipeline.emittedFiles) emitted.set(file.targetPath, file.content);
  for (const [path, content] of translatedTestFiles) emitted.set(path, content);
  for (const [targetPath, content] of emitted) {
    const destination = join(outputRoot, targetPath);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, content);
  }

  // 6. Stages: S1-S3 came from the pipeline; S4 is skipped honestly (no build stage
  // wired in M6 — recorded, never silent); S5/S6 run through the sandbox.
  const stages: StageResult[] = pipeline.report.validationStages.map((stage) => ({
    stage: stage.stage as ValidationStageName,
    status: stage.status,
    reason: stage.reason,
    details: [],
  }));
  stages.push({
    stage: "S4-build",
    status: "skipped",
    reason: "no build stage wired in M6 (S2 covers type-level validation of the emitted project)",
    details: [],
  });
  let s5: S5Result | null = null;
  let s6: S6Result | null = null;
  let testOutcomes: readonly TestOutcome[] = [];
  const testsExecutable =
    translatedTestFiles.size > 0 && options.runTests !== false && options.target === "typescript";
  if (!testsExecutable) {
    skipped.push({
      what: "S5-tests",
      reason:
        options.runTests === false
          ? "test execution disabled"
          : options.target !== "typescript"
            ? "test execution requires the TypeScript target (the pytest mapper emits .test.ts)"
            : "no pytest test modules in the project",
    });
    skipped.push({ what: "S6-differential", reason: "S5 did not run" });
  } else {
    // Untrusted code executes only under enforced network isolation; when the
    // sandbox cannot guarantee it (bwrap missing), the stage is refused and
    // reported as a skip — never downgraded silently.
    try {
      s5 = await runS5(
        { files: emitted, testFiles: [...translatedTestFiles.keys()] },
        {
          capabilities: options.sandbox,
          nodeModulesPath: options.nodeModulesPath,
          vitestEntryPath: options.vitestEntryPath,
          nodePath: options.nodePath,
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        },
      );
    } catch (error) {
      if (!(error instanceof SandboxIsolationError)) throw error;
      skipped.push({
        what: "S5-tests",
        reason: "enforced network isolation is unavailable (bwrap) — sandboxed execution refused",
      });
      skipped.push({ what: "S6-differential", reason: "S5 did not run" });
      stages.push({
        stage: "S5-tests",
        status: "skipped",
        reason: "enforced network isolation unavailable; execution refused (no silent downgrade)",
        details: [],
      });
    }
    if (s5 !== null) {
      stages.push(s5);
      testOutcomes = s5.outcomes;
      if (s5.status === "pass" || s5.status === "fail") {
        const sourceFiles = new Map<string, string>();
        for (const file of discovery.files) {
          sourceFiles.set(file.relativePath, readProjectFile(sourceRoot, file));
        }
        try {
          s6 = await runS6(
            {
              capabilities: options.sandbox,
              nodePath: options.nodePath,
              pythonPath: options.pythonPath,
              ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            },
            {
              sourceFiles,
              sourceTestModules: testNamesByModule,
              targetOutcomes: s5.outcomes,
              sourceRunnerScript: sourceRunnerScript(),
            },
          );
        } catch (error) {
          if (!(error instanceof SandboxIsolationError)) throw error;
          skipped.push({
            what: "S6-differential",
            reason:
              "enforced network isolation is unavailable (bwrap) — sandboxed execution refused",
          });
          stages.push({
            stage: "S6-differential",
            status: "skipped",
            reason:
              "enforced network isolation unavailable; execution refused (no silent downgrade)",
            details: [],
          });
        }
        if (s6 !== null) stages.push(s6);
      } else {
        skipped.push({ what: "S6-differential", reason: "S5 did not produce usable outcomes" });
      }
    }
  }

  // 7. Final report: the pipeline report extended with one entry per test module
  // (their ledger comes from the mapper, not the pipeline) and the extended stage
  // list with the claim ladder recomputed over it (levels 0-5).
  const testModuleEntries = testNamesByModule.map((module) => {
    const counts = { deterministic: 0, semantic: 0, ambiguous: 0, unsupported: 0 };
    for (const entry of testLedger) {
      if (entry.unit === module.path) counts[entry.decision] += 1;
    }
    return {
      source: module.path,
      target: module.path.replace(/\.py$/, ".test.ts"),
      status: counts.unsupported > 0 ? ("partially-translated" as const) : ("translated" as const),
      decisionCounts: counts,
    };
  });
  const report = validateTranslationReport({
    ...pipeline.report,
    files: [...pipeline.report.files, ...testModuleEntries],
    decisionTotals: {
      deterministic:
        pipeline.report.decisionTotals.deterministic +
        testLedger.filter((entry) => entry.decision === "deterministic").length,
      semantic:
        pipeline.report.decisionTotals.semantic +
        testLedger.filter((entry) => entry.decision === "semantic").length,
      ambiguous:
        pipeline.report.decisionTotals.ambiguous +
        testLedger.filter((entry) => entry.decision === "ambiguous").length,
      unsupported:
        pipeline.report.decisionTotals.unsupported +
        testLedger.filter((entry) => entry.decision === "unsupported").length,
    },
    warnings: [
      ...new Set([...pipeline.report.warnings, ...testLedger.flatMap((entry) => entry.warnings)]),
    ],
    validationStages: stages.map((stage) => ({
      stage: stage.stage,
      status: stage.status,
      reason: stage.reason,
    })),
    claimLevel: computeClaimLevel(stages),
  });

  // 8. .ctrans/ artifacts: verdicts and provenance only (never source contents).
  const ctransDir = join(outputRoot, ".ctrans");
  mkdirSync(ctransDir, { recursive: true });
  writeFileSync(
    join(ctransDir, "ledger.json"),
    JSON.stringify([...pipeline.ledger, ...testLedger], null, 2) + "\n",
  );
  writeFileSync(join(ctransDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  if (s5 !== null) {
    writeFileSync(
      join(ctransDir, "test-results.json"),
      JSON.stringify({ stage: "S5-tests", status: s5.status, outcomes: s5.outcomes }, null, 2) +
        "\n",
    );
  }
  if (s6 !== null) {
    writeFileSync(
      join(ctransDir, "differential.json"),
      JSON.stringify(
        {
          stage: "S6-differential",
          status: s6.status,
          matched: s6.matched,
          mismatched: s6.mismatched,
          sourceOnly: s6.sourceOnly,
          targetOnly: s6.targetOnly,
        },
        null,
        2,
      ) + "\n",
    );
  }
  return {
    pipeline: { ...pipeline, report },
    stages,
    testOutcomes,
    s5,
    s6,
    translatedTestFiles: [...translatedTestFiles.keys()],
    unsupportedTestConstructs,
    skipped,
  };
}
