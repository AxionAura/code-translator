// `ctrans doctor` (roadmap M10): reports OBSERVED environment capabilities using
// bounded probes only. It never executes project code, never installs anything,
// and never claims a capability it could not actually exercise. Exit code 1 means
// a required capability is missing (affected stages will be skipped, never faked).
import {
  capabilityExitCode,
  detectValidationCapabilities,
  formatCapabilityReport,
  pyrightEntryPath,
  type ValidationCapabilities,
} from "@axion-ct/validator";

import { jsonOutput } from "./output.js";
import { runnerToolchain } from "./toolchain.js";

export interface DoctorResult {
  readonly code: 0 | 1;
  readonly stdout: string;
  readonly stderr: string;
}

export type CapabilityDetector = () => Promise<ValidationCapabilities>;

export interface DoctorOptions {
  readonly json?: boolean;
}

export async function runDoctor(
  detect?: CapabilityDetector,
  options: DoctorOptions = {},
): Promise<DoctorResult> {
  const capabilities = detect === undefined ? await defaultDetection() : await detect();
  return {
    code: capabilityExitCode(capabilities),
    stdout:
      options.json === true
        ? jsonOutput({
            command: "doctor",
            requiredAvailable: capabilities.requiredAvailable,
            strictAvailable: capabilities.strictAvailable,
            capabilities,
          })
        : formatCapabilityReport(capabilities),
    stderr: "",
  };
}

async function defaultDetection(): Promise<ValidationCapabilities> {
  const toolchain = runnerToolchain();
  return detectValidationCapabilities({
    nodePath: process.execPath,
    pythonPath: "python3",
    pyrightEntryPath: pyrightEntryPath(import.meta.url),
    typescriptEntryPath: toolchain.typescriptEntryPath,
    vitestEntryPath: toolchain.vitestEntryPath,
  });
}
