// Failure classification (roadmap M9 WS A; docs/validation.md §8): maps the
// validation stages the engine ACTUALLY executed into typed failure categories.
// Rules are evidence-based — a skipped stage is never a failure, and
// infrastructure problems (timeout/spawn/isolation) are never classified as
// source defects (they are reported as non-repairable infrastructure failures).
import type { LedgerEntry, StageResult, ValidationStageName } from "@axion-ct/core";

export type FailureCategory =
  | "syntax"
  | "type"
  | "dependencies"
  | "build"
  | "tests"
  | "differential"
  | "smoke"
  | "unsupported"
  | "infrastructure"
  | "unknown";

export interface ClassifiedFailure {
  // Validation.md §8 machine code (V-S1-PARSE, V-S2-TYPE, …). Infrastructure
  // failures use V-<STAGE>-INFRA; unsupported ledger evidence uses V-UNSUPPORTED.
  readonly code: string;
  readonly category: FailureCategory;
  readonly stage: ValidationStageName | null;
  // Only source-defect categories are eligible for AI repair; infrastructure and
  // unsupported construct classes never are (AGENTS.md §9/§11).
  readonly repairable: boolean;
  readonly details: readonly string[];
  readonly reason: string | null;
}

const STAGE_CLASSIFICATION: Readonly<
  Record<ValidationStageName, { readonly code: string; readonly category: FailureCategory }>
> = {
  "S1-syntax": { code: "V-S1-PARSE", category: "syntax" },
  "S2-types": { code: "V-S2-TYPE", category: "type" },
  "S3-dependencies": { code: "V-S3-IMPORT", category: "dependencies" },
  "S4-build": { code: "V-S4-BUILD", category: "build" },
  "S5-tests": { code: "V-S5-TEST", category: "tests" },
  "S6-differential": { code: "V-S6-DIVERGE", category: "differential" },
  "S7-smoke": { code: "V-S7-SMOKE", category: "smoke" },
};

// Evidence patterns that mark an infrastructure problem rather than a source
// defect. Matched against reason + details of FAILED stages only.
const INFRASTRUCTURE_PATTERN =
  /timeout|timed out|spawn|isolation|unavailable|crashed|out of memory|ENOENT|sandbox/i;

export function isInfrastructureEvidence(text: string | null | undefined): boolean {
  return text !== null && text !== undefined && INFRASTRUCTURE_PATTERN.test(text);
}

// Classify executed stage results into failures. `pass`/`warn` are not failures;
// `skipped` is inconclusive, not a failure (never converted into a pass either).
export function classifyFailures(
  stages: readonly StageResult[],
  ledger: readonly LedgerEntry[] = [],
): readonly ClassifiedFailure[] {
  const failures: ClassifiedFailure[] = [];
  for (const stage of stages) {
    if (stage.status !== "fail") continue;
    const classification = STAGE_CLASSIFICATION[stage.stage];
    const evidence = [stage.reason, ...stage.details].filter(
      (entry): entry is string => typeof entry === "string",
    );
    const infrastructure = evidence.some((entry) => isInfrastructureEvidence(entry));
    failures.push(
      infrastructure
        ? {
            code: `V-${stage.stage.replace(/-.*$/, "")}-INFRA`,
            category: "infrastructure",
            stage: stage.stage,
            repairable: false,
            details: stage.details,
            reason: stage.reason,
          }
        : {
            code: classification.code,
            category: classification.category,
            stage: stage.stage,
            repairable: true,
            details: stage.details,
            reason: stage.reason,
          },
    );
  }
  // Unsupported constructs are a translation-surface limitation, never an AI
  // repair target: the engine cannot emit behavior it does not support.
  const unsupported = ledger.filter((entry) => entry.decision === "unsupported");
  if (unsupported.length > 0) {
    failures.push({
      code: "V-UNSUPPORTED",
      category: "unsupported",
      stage: null,
      repairable: false,
      details: unsupported.map((entry) => `${entry.unit}: ${entry.rule}`).slice(0, 20),
      reason: `${String(unsupported.length)} unsupported construct(s) — the engine does not emit these deterministically`,
    });
  }
  return failures;
}

// Stages that could not run: reported for the record; never counted as pass.
export function inconclusiveStages(stages: readonly StageResult[]): readonly StageResult[] {
  return stages.filter((stage) => stage.status === "skipped");
}

// Attribution: a failure detail like "calc.ts: message" belongs to the unit whose
// emitted target path prefixes it. Unattributable failures are never guessed onto
// a unit.
export function failureDetailsForTarget(
  failure: ClassifiedFailure,
  targetPath: string,
): readonly string[] {
  return failure.details.filter(
    (detail) => detail.startsWith(`${targetPath}:`) || detail.startsWith(`${targetPath} `),
  );
}

export function admittedForRepair(failure: ClassifiedFailure): boolean {
  return failure.repairable && failure.stage !== null && failure.category !== "unsupported";
}
