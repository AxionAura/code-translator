// Stage evidence validation (M10; docs/validation.md §1-2): the validation
// engine refuses inconsistent evidence instead of reporting a claim it cannot
// support. Used by the project runner before writing reports, and directly by the
// validator-on-validator negative suite.
import {
  CTransError,
  computeClaimLevel,
  type ClaimLevel,
  type StageResult,
  type ValidationStageName,
} from "@ctrans/core";

export class ValidationEvidenceError extends CTransError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super("VALIDATION-EVIDENCE-INVALID", `invalid validation evidence: ${issues.join("; ")}`);
    this.issues = [...issues];
  }
}

// Canonical ordering of the seven documented stages.
export const STAGE_ORDER: readonly ValidationStageName[] = [
  "S1-syntax",
  "S2-types",
  "S3-dependencies",
  "S4-build",
  "S5-tests",
  "S6-differential",
  "S7-smoke",
];

export interface StageEvidenceOptions {
  // Stages that must be present (e.g. all seven for a project report).
  readonly required?: readonly ValidationStageName[];
  // When provided, must equal the claim computed from the stages.
  readonly claimedLevel?: number;
}

export function stageEvidenceIssues(
  stages: readonly StageResult[],
  options: StageEvidenceOptions = {},
): readonly string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  let lastIndex = -1;
  for (const stage of stages) {
    if (seen.has(stage.stage)) issues.push(`duplicate stage result: ${stage.stage}`);
    seen.add(stage.stage);
    const index = STAGE_ORDER.indexOf(stage.stage);
    if (index === -1) {
      issues.push(`unknown stage: ${stage.stage}`);
    } else if (index < lastIndex) {
      issues.push(`stage ${stage.stage} is out of order`);
    } else {
      lastIndex = index;
    }
    if (stage.status === "pass" && stage.reason !== null && stage.reason.trim() !== "") {
      // A pass may carry explanatory detail, but not a failure reason.
      issues.push(`stage ${stage.stage} reports pass with a failure reason`);
    }
    if (stage.status === "fail" && stage.reason === null) {
      issues.push(`stage ${stage.stage} failed without a reason`);
    }
  }
  for (const required of options.required ?? []) {
    if (!seen.has(required)) issues.push(`missing required stage: ${required}`);
  }
  if (options.claimedLevel !== undefined) {
    const computed = computeClaimLevel(stages);
    if (options.claimedLevel !== computed) {
      issues.push(
        `claimed level ${String(options.claimedLevel)} does not match computed level ${String(computed)}`,
      );
    }
  }
  return issues;
}

export function assertStageEvidence(
  stages: readonly StageResult[],
  options: StageEvidenceOptions = {},
): ClaimLevel {
  const issues = stageEvidenceIssues(stages, options);
  if (issues.length > 0) throw new ValidationEvidenceError(issues);
  return computeClaimLevel(stages);
}

// Assemble the canonical stage list: execute-time order is preserved, and
// required stages that were not executed are recorded as skipped (visible,
// never silently absent). Returns a new array; inputs are not mutated.
export function assembleStages(
  executed: readonly StageResult[],
  required: readonly ValidationStageName[],
  reasonForMissing: (stage: ValidationStageName) => string,
): StageResult[] {
  const byStage = new Map(executed.map((stage) => [stage.stage, stage]));
  return required.map(
    (stage) =>
      byStage.get(stage) ?? {
        stage,
        status: "skipped",
        reason: reasonForMissing(stage),
        details: [],
      },
  );
}
