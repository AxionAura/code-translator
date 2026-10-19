// Responsibility (docs/architecture.md section 3): validation stages S5 (translated
// test execution) and S6 (differential comparison), both sandboxed. S1-S3 live in
// core/parser-js; S4 (build) is deferred until a bundler target exists.
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
  type TestOutcome,
} from "./stages.js";
export const packageName = "@ctrans/validator";
