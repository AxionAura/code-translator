// Responsibility (docs/architecture.md §3): failure classification and the
// bounded, observable repair loop (M9). Public API: classify → propose a
// unit-scoped unified diff → apply → re-validate → monotone accept/revert, with
// centralized caps, state-hash loop detection, and a hash-only journal.
export {
  admittedForRepair,
  classifyFailures,
  failureDetailsForTarget,
  inconclusiveStages,
  isInfrastructureEvidence,
  type ClassifiedFailure,
  type FailureCategory,
} from "./categories.js";
export {
  applyUnifiedDiff,
  parseUnifiedDiff,
  validatePatchPolicy,
  type DiffApplication,
} from "./diff.js";
export {
  AiRepairProposer,
  DisabledRepairProposer,
  type RepairProposerOptions,
} from "./proposer.js";
export {
  MAX_ATTEMPTS_PER_RUN,
  MAX_ATTEMPTS_PER_UNIT,
  acceptance,
  runRepairLoop,
  stateHash,
  stagesForFailures,
  type RepairLoopInput,
  type RepairLoopOptions,
  type RepairUnit,
} from "./orchestrator.js";
export {
  JOURNAL_DIRECTORY,
  JOURNAL_FILE,
  RepairJournal,
  type LoadedRepairJournal,
  type RepairJournalRun,
} from "./journal.js";
export type {
  ProposalOutcome,
  RepairAttemptRecord,
  RepairPatch,
  RepairPatchScope,
  RepairProposal,
  RepairProposer,
  RepairRequest,
  RepairRunResult,
  RepairStopReason,
} from "./types.js";
export const packageName = "@axion-ct/repair";
