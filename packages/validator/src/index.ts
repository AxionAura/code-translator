// Responsibility (docs/architecture.md section 3): the validation engine. S5
// (translated test execution) and S6 (differential comparison) are sandboxed; S4
// (build) and S7 (opt-in smoke) are implemented in M10; S1-S3 live in
// core/parser-js. Evidence validation refuses inconsistent stage sets.
export {
  runS5,
  runS6,
  sourceRunnerScript,
  type S5Input,
  type S5Options,
  type S5Result,
  type S6Input,
  type S6Options,
  type S6Result,
  type SandboxRun,
  type TestAttempt,
  type TestOutcome,
} from "./stages.js";
export {
  PyrightTypeValidator,
  parsePyrightJson,
  pyrightEntryPath,
  type PyrightDiagnostic,
  type PyrightValidatorOptions,
} from "./pyright.js";
export { runS4, type BuildTarget, type S4Input, type S4Options } from "./build.js";
export {
  runS7,
  type S7Options,
  type S7Result,
  type SmokeHarness,
  type SmokeHarnessFile,
} from "./smoke.js";
export {
  STAGE_ORDER,
  ValidationEvidenceError,
  assembleStages,
  assertStageEvidence,
  stageEvidenceIssues,
  type StageEvidenceOptions,
} from "./evidence.js";
export {
  capabilityExitCode,
  detectValidationCapabilities,
  formatCapabilityReport,
  type CapabilityState,
  type ToolStatus,
  type ValidationCapabilities,
  type ValidationCapabilityOptions,
} from "./capabilities.js";
export const packageName = "@axion-ct/validator";
