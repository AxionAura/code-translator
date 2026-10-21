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
} from "@ctrans/validator";

import { runnerToolchain } from "./toolchain.ts";

export interface DoctorResult {
  readonly code: 0 | 1;
  readonly stdout: string;
  readonly stderr: string;
}

export type CapabilityDetector = () => Promise<ValidationCapabilities>;

export async function runDoctor(detect?: CapabilityDetector): Promise<DoctorResult> {
  const capabilities = detect === undefined ? await defaultDetection() : await detect();
  return {
    code: capabilityExitCode(capabilities),
    stdout: formatCapabilityReport(capabilities),
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
