// Bounded repair loop (roadmap M9 WS C/D): classify → propose → apply a validated
// unit-scoped diff → re-run the caller's validators → accept only a monotone
// improvement → otherwise discard the candidate (the baseline map is never
// mutated, so rollback is exact). Caps are enforced HERE, centrally: callers may
// tighten them but never raise them.
import {
  computeClaimLevel,
  isTestModulePath,
  type LedgerEntry,
  type StageResult,
  type ValidationStageName,
} from "@ctrans/core";
import { hashText } from "@ctrans/ai";

import {
  admittedForRepair,
  classifyFailures,
  failureDetailsForTarget,
  type ClassifiedFailure,
} from "./categories.js";
import { applyUnifiedDiff, validatePatchPolicy } from "./diff.js";
import type {
  RepairAttemptRecord,
  RepairProposer,
  RepairRunResult,
  RepairStopReason,
} from "./types.js";

export const MAX_ATTEMPTS_PER_UNIT = 3;
export const MAX_ATTEMPTS_PER_RUN = 8;

export interface RepairUnit {
  readonly unit: string; // source module id
  readonly targetPath: string; // emitted target path
  readonly sourceText: string;
}

export interface RepairLoopInput {
  // The emitted project (baseline). Never mutated.
  readonly files: ReadonlyMap<string, string>;
  readonly units: readonly RepairUnit[];
  // The stages that produced the failure evidence (baseline verdicts).
  readonly stages: readonly StageResult[];
  readonly ledger?: readonly LedgerEntry[];
  // Optional: pre-classified failures (defaults to classifying `stages`).
  readonly failures?: readonly ClassifiedFailure[];
}

export interface RepairLoopOptions {
  readonly proposer: RepairProposer;
  // Re-runs the applicable validation stages over a candidate file map. Must use
  // the real validators (or a scripted equivalent in tests) — never fresh
  // "pass" defaults.
  readonly validate: (files: ReadonlyMap<string, string>) => Promise<readonly StageResult[]>;
  // May TIGHTEN the documented caps; values above are clamped to the defaults.
  readonly maxAttemptsPerUnit?: number;
  readonly maxAttemptsPerRun?: number;
  // Stages that must be PASS in the BASELINE (not skipped) and in every accepted
  // candidate. Project mode uses this to demand executable behavioral evidence
  // (S5/S6); a candidate that leaves one inconclusive/failing is rejected.
  readonly requirePassing?: readonly ValidationStageName[];
  readonly now?: () => Date;
}

// Deterministic content hash of a project state (sorted paths + contents).
export function stateHash(files: ReadonlyMap<string, string>): string {
  const canonical = [...files.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([path, content]) => `${path}\u0000${content}`)
    .join("\u0000\u0000");
  return hashText(canonical);
}

interface AttemptTarget {
  readonly unit: RepairUnit;
  readonly failures: readonly ClassifiedFailure[];
}

export async function runRepairLoop(
  input: RepairLoopInput,
  options: RepairLoopOptions,
): Promise<RepairRunResult> {
  const maxPerUnit = clamp(
    options.maxAttemptsPerUnit ?? MAX_ATTEMPTS_PER_UNIT,
    MAX_ATTEMPTS_PER_UNIT,
  );
  const maxPerRun = clamp(options.maxAttemptsPerRun ?? MAX_ATTEMPTS_PER_RUN, MAX_ATTEMPTS_PER_RUN);
  const now = options.now ?? (() => new Date());
  const failures = input.failures ?? classifyFailures(input.stages, input.ledger ?? []);

  const baselineHash = stateHash(input.files);
  const attempts: RepairAttemptRecord[] = [];
  const acceptedUnits: string[] = [];
  // Candidate state is built alongside; only accepted candidates replace `current`.
  let current = new Map(input.files);
  let currentStages: readonly StageResult[] = input.stages;
  const requiredPassing = options.requirePassing ?? [];

  const unavailableRequired = requiredPassing.filter(
    (stage) =>
      !input.stages.some((result) => result.stage === stage && result.status !== "skipped"),
  );
  if (unavailableRequired.length > 0) {
    // Mandatory behavioral validation could not be performed for the baseline:
    // refuse repair instead of accepting S1-S3-only evidence.
    return finish(
      "validation-unavailable",
      baselineHash,
      current,
      currentStages,
      attempts,
      acceptedUnits,
    );
  }

  const eligible = failures.filter(admittedForRepair);
  if (failures.length === 0) {
    return finish("no-failures", baselineHash, current, currentStages, attempts, acceptedUnits);
  }
  if (eligible.length === 0) {
    return finish(
      "no-eligible-failures",
      baselineHash,
      current,
      currentStages,
      attempts,
      acceptedUnits,
    );
  }

  // Attribute failures to permitted units (evidence-based: exact path prefix).
  const targets: AttemptTarget[] = [];
  for (const unit of input.units) {
    if (isTestModulePath(unit.unit)) continue; // tests are never model-editable
    // Generated shared artifacts (runtime helpers) have no source text: they are
    // engine output, not a unit the model may rewrite.
    if (unit.sourceText.trim() === "") continue;
    if (!input.files.has(unit.targetPath)) continue;
    const unitFailures = eligible.filter(
      (failure) =>
        failure.stage !== null && failureDetailsForTarget(failure, unit.targetPath).length > 0,
    );
    if (unitFailures.length > 0) targets.push({ unit, failures: unitFailures });
  }
  if (targets.length === 0) {
    return finish(
      "no-eligible-failures",
      baselineHash,
      current,
      currentStages,
      attempts,
      acceptedUnits,
    );
  }

  const seenStates = new Set<string>([baselineHash]);
  const seenPatches = new Set<string>();
  let attemptsUsed = 0;
  let stopReason: RepairStopReason | null = null;
  let declinedAny = false;
  let exhaustedAny = false;
  let unavailableAny = false;

  for (const target of targets) {
    if (stopReason !== null) break;
    let unitAttempts = 0;
    const priorAttempts: { patchHash: string; outcome: string }[] = [];
    const unitAccepted = { value: false };

    while (unitAttempts < maxPerUnit) {
      if (attemptsUsed >= maxPerRun) {
        stopReason = "run-cap";
        break;
      }
      const baselineForAttempt = stateHash(current);
      if (!seenStates.has(baselineForAttempt)) seenStates.add(baselineForAttempt);
      unitAttempts += 1;
      attemptsUsed += 1;
      const emittedText = current.get(target.unit.targetPath)!;
      // Re-select the failure on every attempt: an earlier accepted patch may
      // have fixed the originally-reported stage while another still fails.
      const failure = target.failures.find(
        (entry) =>
          entry.stage !== null &&
          currentStages.some((stage) => stage.stage === entry.stage && stage.status === "fail"),
      );
      if (failure === undefined) break;
      const diagnostics = [
        ...target.failures.flatMap((entry) =>
          failureDetailsForTarget(entry, target.unit.targetPath),
        ),
      ].slice(0, 12);
      const proposal = await options.proposer.propose({
        unit: target.unit.unit,
        targetPath: target.unit.targetPath,
        sourceText: target.unit.sourceText,
        emittedText,
        failure,
        diagnostics,
        ledgerSummary: summariseLedger(input.ledger ?? [], target.unit.unit),
        attempt: unitAttempts,
        priorAttempts: [...priorAttempts],
      });

      const record = (
        decision: RepairAttemptRecord["decision"],
        reason: string | null,
        candidateStateHash: string | null,
        stages: readonly StageResult[],
      ): void => {
        attempts.push({
          unit: target.unit.unit,
          targetPath: target.unit.targetPath,
          attempt: unitAttempts,
          failureCode: failure.code,
          failureCategory: failure.category,
          baselineStateHash: baselineForAttempt,
          candidateStateHash,
          patchHash: proposal.patch?.diffHash ?? null,
          proposalOutcome: proposal.outcome,
          decision,
          reason,
          stages: stages.map((stage) => ({ stage: stage.stage, status: stage.status })),
          provider: proposal.patch?.escalation.provider ?? null,
          model: proposal.patch?.escalation.model ?? null,
          inputTokens: proposal.inputTokens,
          outputTokens: proposal.outputTokens,
          secretRuleIds: proposal.secretRuleIds,
          timestamp: now().toISOString(),
        });
      };

      if (proposal.outcome !== "patch" || proposal.patch === null) {
        // A blocked proposal (secret gate) is rejected loudly and stops the run;
        // a decline is an explicit "no safe fix" for this unit; other non-patch
        // outcomes (AI disabled, provider error, caps, invalid output) degrade to
        // the deterministic fallback.
        record(
          proposal.outcome === "blocked-secret" ? "rejected" : "no-repair",
          proposal.reason,
          null,
          currentStages,
        );
        if (proposal.outcome === "declined") declinedAny = true;
        if (proposal.outcome === "ai-disabled" || proposal.outcome === "blocked-secret") {
          stopReason = "repair-unavailable";
        }
        if (
          proposal.outcome === "provider-error" ||
          proposal.outcome === "cap-exhausted" ||
          proposal.outcome === "packet-too-large"
        ) {
          unavailableAny = true;
        }
        break;
      }
      if (seenPatches.has(proposal.patch.diffHash)) {
        record("rejected", "duplicate patch (same diff already attempted)", null, currentStages);
        priorAttempts.push({ patchHash: proposal.patch.diffHash, outcome: "duplicate" });
        continue;
      }
      seenPatches.add(proposal.patch.diffHash);

      // Defense in depth: a non-AI proposer (tests/tools) is subject to the same
      // policy as the model — no validation weakening, no test suppression.
      const policy = validatePatchPolicy(proposal.patch.diff, proposal.patch);
      if (!policy.ok) {
        record("rejected", policy.reason, null, currentStages);
        priorAttempts.push({ patchHash: proposal.patch.diffHash, outcome: "policy-rejected" });
        continue;
      }

      const applied = applyUnifiedDiff(emittedText, proposal.patch.diff, proposal.patch);
      if (!applied.ok) {
        record("rejected", applied.reason, null, currentStages);
        priorAttempts.push({ patchHash: proposal.patch.diffHash, outcome: "does-not-apply" });
        continue;
      }
      if (applied.text === emittedText) {
        record("rejected", "patch is a no-op", null, currentStages);
        priorAttempts.push({ patchHash: proposal.patch.diffHash, outcome: "no-op" });
        continue;
      }
      const candidate = new Map(current);
      candidate.set(target.unit.targetPath, applied.text);
      const candidateHash = stateHash(candidate);
      if (seenStates.has(candidateHash)) {
        record(
          "rejected",
          "patch reproduces a previously seen state (loop detected)",
          candidateHash,
          currentStages,
        );
        priorAttempts.push({ patchHash: proposal.patch.diffHash, outcome: "loop" });
        stopReason = "loop-detected";
        break;
      }

      let candidateStages: readonly StageResult[];
      try {
        candidateStages = await options.validate(candidate);
      } catch (error) {
        // Validation infrastructure failed: restore exactly, never accept.
        record(
          "rejected",
          `validation failed to run: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
          candidateHash,
          currentStages,
        );
        stopReason = "validation-error";
        break;
      }
      const verdict = acceptance(currentStages, candidateStages);
      const missingRequired = requiredPassing.filter(
        (stage) => candidateStages.find((result) => result.stage === stage)?.status !== "pass",
      );
      if (!verdict.accept || missingRequired.length > 0) {
        // Remember rejected states too: reproducing one later proves a loop.
        seenStates.add(candidateHash);
        record(
          "rejected",
          verdict.accept
            ? `required behavioral stage not passing: ${missingRequired.join(", ")}`
            : verdict.reason,
          candidateHash,
          candidateStages,
        );
        priorAttempts.push({ patchHash: proposal.patch.diffHash, outcome: "rejected" });
        continue;
      }
      // Accept: commit the candidate state and its verdicts.
      seenStates.add(candidateHash);
      current = candidate;
      currentStages = candidateStages;
      unitAccepted.value = true;
      record("accepted", verdict.reason, candidateHash, candidateStages);
      // Continue while any failure attributed to this unit is still failing; a
      // patch that only fixes one of several failing stages must keep going.
      const stillFailing = target.failures.some(
        (entry) =>
          entry.stage !== null &&
          candidateStages.some((stage) => stage.stage === entry.stage && stage.status === "fail"),
      );
      if (!stillFailing) break;
    }
    if (unitAccepted.value) acceptedUnits.push(target.unit.unit);
    if (unitAttempts >= maxPerUnit) exhaustedAny = true;
    // An unresolved unit does not stop the run: another unit's repair may still
    // be attributable. The final stop reason reports any leftover failures.
  }

  if (stopReason === null) {
    const resolved = eligible.every((failure) =>
      currentStages.every((stage) => stage.stage !== failure.stage || stage.status !== "fail"),
    );
    stopReason = resolved
      ? "success"
      : exhaustedAny || attemptsUsed >= maxPerRun
        ? "attempts-exhausted"
        : unavailableAny
          ? "repair-unavailable"
          : declinedAny
            ? "declined"
            : "attempts-exhausted";
  }
  return finish(stopReason, baselineHash, current, currentStages, attempts, acceptedUnits);
}

function finish(
  stopReason: RepairStopReason,
  baselineHash: string,
  files: ReadonlyMap<string, string>,
  stages: readonly StageResult[],
  attempts: readonly RepairAttemptRecord[],
  acceptedUnits: readonly string[],
): RepairRunResult {
  const finalStateHash = stateHash(files);
  return {
    files,
    stages,
    attempts,
    stopReason,
    acceptedUnits,
    baselineStateHash: baselineHash,
    finalStateHash,
  };
}

function clamp(requested: number, maximum: number): number {
  if (!Number.isFinite(requested) || requested < 1) return 1;
  return Math.min(Math.floor(requested), maximum);
}

// Acceptance (docs/validation.md claim ladder + AGENTS §4 monotonicity):
//  1. No stage that PASSED at baseline may be non-pass in the candidate (a repair
//     may never break an already-valid check — includes turning a pass into
//     skipped/warn).
//  2. The candidate's claim level must be strictly HIGHER than the baseline's.
//     Skipped/inconclusive stages never count as pass (computeClaimLevel already
//     enforces this), so "cannot run" can never be accepted as a fix.
// Equal claim levels are rejected: no demonstrated improvement, no accepted patch.
export function acceptance(
  baseline: readonly StageResult[],
  candidate: readonly StageResult[],
): { readonly accept: boolean; readonly reason: string } {
  const candidateByStage = new Map(candidate.map((stage) => [stage.stage, stage]));
  for (const stage of baseline) {
    if (stage.status !== "pass") continue;
    const after = candidateByStage.get(stage.stage);
    if (after === undefined) {
      return { accept: false, reason: `candidate omitted previously passing stage ${stage.stage}` };
    }
    if (after.status !== "pass") {
      return {
        accept: false,
        reason: `candidate regressed ${stage.stage} from pass to ${after.status}`,
      };
    }
  }
  const baselineClaim = computeClaimLevel(baseline);
  const candidateClaim = computeClaimLevel(candidate);
  if (candidateClaim <= baselineClaim) {
    return {
      accept: false,
      reason: `no demonstrated improvement (claim level ${String(baselineClaim)} → ${String(candidateClaim)})`,
    };
  }
  return {
    accept: true,
    reason: `claim level improved ${String(baselineClaim)} → ${String(candidateClaim)} with no passing stage regressed`,
  };
}

function summariseLedger(ledger: readonly LedgerEntry[], unit: string): readonly string[] {
  return ledger
    .filter((entry) => entry.unit === unit)
    .slice(0, 12)
    .map((entry) => `${entry.rule} [${entry.decision}]`);
}

// Stage names relevant to a failure (exported for callers selecting validators).
export function stagesForFailures(
  failures: readonly ClassifiedFailure[],
): readonly ValidationStageName[] {
  return [
    ...new Set(
      failures
        .map((failure) => failure.stage)
        .filter((stage): stage is ValidationStageName => stage !== null),
    ),
  ];
}
