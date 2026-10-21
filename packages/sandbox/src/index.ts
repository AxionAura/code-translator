// Responsibility (docs/architecture.md section 3): isolated process execution for
// source and translated code. M6 v1: hardened spawn + prlimit + bwrap
// autodetection, capability reporting, and the typed outcome taxonomy. M10 adds
// the Docker/Podman strict driver (optional gVisor) with evidence-based capability
// detection. Every execution of source or translated project code goes through
// SandboxRunner.run.
export { detectCapabilities, type SandboxCapabilities, type ToolCapability } from "./capability.js";
export {
  buildContainerArgv,
  cleanupContainer,
  containerNameFor,
  detectContainerCapabilities,
  validateContainerOptions,
  type CommandProbe,
  type ContainerCapabilities,
  type ContainerDetectionOptions,
  type ContainerKind,
  type ContainerRunOptions,
  type ContainerRuntimeStatus,
  type GvisorStatus,
} from "./container.js";
export {
  SandboxOutputLimitError,
  SandboxIsolationError,
  SandboxSpawnError,
  SandboxSpecError,
  SandboxTimeoutError,
} from "./errors.js";
export {
  SandboxRunner,
  outcomeError,
  type SandboxFileSpec,
  type SandboxRunOptions,
  type SandboxRunResult,
  type SandboxRunSpec,
} from "./runner.js";
export const packageName = "@ctrans/sandbox";
