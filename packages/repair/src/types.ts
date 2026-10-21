// Shared repair types (roadmap M9). Patches are untrusted model output: the
// scope is explicit (one emitted unit), and every consumer re-validates it.
import type { LedgerEscalation, StageResult, ValidationStageName } from "@ctrans/core";

import type { ClassifiedFailure, FailureCategory } from "./categories.js";

export interface RepairPatchScope {
  // Source module id (e.g. "calc.py").
  readonly unit: string;
  // Emitted target path the patch applies to (e.g. "calc.ts").
  readonly targetPath: string;
}

export interface RepairRequest extends RepairPatchScope {
  readonly sourceText: string;
  readonly emittedText: string;
  readonly failure: ClassifiedFailure;
  readonly diagnostics: readonly string[];
  readonly ledgerSummary: readonly string[];
  // 1-based attempt number within the unit.
  readonly attempt: number;
  // Prior attempts for loop awareness (hash-only, never content).
  readonly priorAttempts: readonly {
    readonly patchHash: string;
    readonly outcome: string;
  }[];
}

export interface RepairPatch extends RepairPatchScope {
  // Unified diff (unit-scoped; see repair/src/diff.ts for the accepted grammar).
  readonly diff: string;
  readonly rationale: string;
  readonly promptHash: string;
  readonly escalation: LedgerEscalation;
  readonly diffHash: string;
}

export type ProposalOutcome =
  | "patch"
  | "declined"
  | "ai-disabled"
  | "blocked-secret"
  | "cap-exhausted"
  | "invalid-output"
  | "provider-error"
  | "packet-too-large";

export interface RepairProposal {
  readonly outcome: ProposalOutcome;
  // Present only for outcome "patch" — after structural validation.
  readonly patch: RepairPatch | null;
  readonly reason: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly secretRuleIds: readonly string[];
}

// The port the orchestrator talks to (AI-backed in production, scripted in tests,
// absent when AI is disabled).
export interface RepairProposer {
  propose(request: RepairRequest, signal?: AbortSignal): Promise<RepairProposal>;
}

export interface RepairAttemptRecord {
  readonly unit: string;
  readonly targetPath: string;
  readonly attempt: number; // 1-based within the unit
  readonly failureCode: string;
  readonly failureCategory: FailureCategory;
  readonly baselineStateHash: string;
  readonly candidateStateHash: string | null;
  readonly patchHash: string | null;
  readonly proposalOutcome: ProposalOutcome | "diff-rejected";
  readonly decision: "accepted" | "rejected" | "no-repair";
  readonly reason: string | null;
  readonly stages: readonly {
    readonly stage: ValidationStageName;
    readonly status: StageResult["status"];
  }[];
  readonly provider: string | null;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly secretRuleIds: readonly string[];
  readonly timestamp: string;
}

export type RepairStopReason =
  | "no-failures"
  | "success"
  | "no-eligible-failures"
  | "repair-unavailable"
  | "declined"
  | "attempts-exhausted"
  | "run-cap"
  | "loop-detected"
  | "validation-error";

export interface RepairRunResult {
  // Final emitted files (accepted repairs applied; rejected ones never persisted).
  readonly files: ReadonlyMap<string, string>;
  // Final validation stages (the pre-repair baseline when nothing was accepted).
  readonly stages: readonly StageResult[];
  readonly attempts: readonly RepairAttemptRecord[];
  readonly stopReason: RepairStopReason;
  readonly acceptedUnits: readonly string[];
  readonly baselineStateHash: string;
  readonly finalStateHash: string;
}
