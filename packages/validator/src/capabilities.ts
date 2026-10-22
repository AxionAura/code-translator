// Validation capability matrix (roadmap M10; docs/validation.md §3): the
// environment facts that unlock S2/S4/S5/S6 and strict-mode execution. Detection
// runs real, bounded probes; an executable that exists but fails its functional
// probe is NOT reported as available. `ctrans doctor` and the validation wiring
// consume this one model so their verdicts cannot drift.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  detectCapabilities,
  detectContainerCapabilities,
  type CommandProbe,
  type ContainerCapabilities,
  type SandboxCapabilities,
} from "@ctrans/sandbox";

const execFileP = promisify(execFile);

export type CapabilityState = "available" | "unavailable" | "optional";

export interface ToolStatus {
  readonly name: string;
  // Required for full deterministic validation (not for every individual run).
  readonly required: boolean;
  readonly state: CapabilityState;
  readonly version: string | null;
  // Path or command that was probed.
  readonly path: string | null;
  readonly detail: string;
  // The tool exists but its functional probe failed (e.g. daemon down).
  readonly probeFailed: boolean;
}

export interface ValidationCapabilities {
  readonly node: ToolStatus;
  readonly python: ToolStatus;
  readonly bwrap: ToolStatus;
  readonly prlimit: ToolStatus;
  readonly pyright: ToolStatus;
  readonly tsc: ToolStatus;
  readonly vitest: ToolStatus;
  readonly docker: ToolStatus;
  readonly podman: ToolStatus;
  readonly gvisor: ToolStatus;
  readonly container: ContainerCapabilities;
  readonly sandbox: SandboxCapabilities;
  // A container runtime is usable (strict mode still also needs an explicit image).
  readonly strictAvailable: boolean;
  readonly requiredAvailable: boolean;
}

export interface ValidationCapabilityOptions {
  readonly probe?: CommandProbe;
  readonly nodePath?: string;
  readonly pythonPath?: string;
  readonly pyrightEntryPath?: string;
  readonly typescriptEntryPath?: string;
  readonly vitestEntryPath?: string;
  readonly bwrapPath?: string;
  readonly prlimitPath?: string;
  readonly dockerPath?: string;
  readonly podmanPath?: string;
  readonly gvisorPath?: string;
  readonly sandbox?: SandboxCapabilities;
  readonly containers?: ContainerCapabilities;
}

const PROBE_TIMEOUT_MS = 10000;

const defaultProbe: CommandProbe = {
  async run(path, args, timeoutMs) {
    const probeDir = mkdtempSync(join(tmpdir(), "ctrans-capability-probe-"));
    try {
      const { stdout } = await execFileP(path, [...args], {
        cwd: probeDir,
        timeout: timeoutMs,
        env: { PATH: process.env["PATH"] ?? "" },
      });
      return { stdout: stdout.trim() };
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  },
};

function firstLine(text: string): string | null {
  const line = text.trim().split("\n")[0] ?? "";
  return line === "" ? null : line;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? String(code) : "failed";
}

async function probeExecutable(
  name: string,
  required: boolean,
  path: string | null,
  probe: CommandProbe,
  args: readonly string[],
): Promise<ToolStatus> {
  if (path === null) {
    return {
      name,
      required,
      state: required ? "unavailable" : "optional",
      version: null,
      path: null,
      detail: `${name} is not configured for this installation`,
      probeFailed: false,
    };
  }
  try {
    const { stdout } = await probe.run(path, args, PROBE_TIMEOUT_MS);
    return {
      name,
      required,
      state: "available",
      version: firstLine(stdout),
      path,
      detail: path,
      probeFailed: false,
    };
  } catch (error) {
    const code = errorCode(error);
    return {
      name,
      required,
      state: required ? "unavailable" : "optional",
      version: null,
      path,
      detail:
        code === "ENOENT" ? `${path} not found` : `${path} ${args.join(" ")} failed (${code})`,
      probeFailed: code !== "ENOENT",
    };
  }
}

// JS entry points are probed through the node binary, so a broken package is not
// reported as available merely because the file exists.
async function probeNodeEntry(
  name: string,
  nodePath: string,
  entryPath: string | undefined,
  probe: CommandProbe,
): Promise<ToolStatus> {
  if (entryPath === undefined) {
    return {
      name,
      required: true,
      state: "unavailable",
      version: null,
      path: null,
      detail: `${name} entry path is not configured for this installation`,
      probeFailed: false,
    };
  }
  const status = await probeExecutable(name, true, nodePath, probe, [entryPath, "--version"]);
  return status.state === "available" ? { ...status, path: entryPath, detail: entryPath } : status;
}

function fromSandboxTool(
  name: string,
  required: boolean,
  tool: { available: boolean; version: string | null; unavailableReason: string | null },
  path: string,
): ToolStatus {
  if (tool.available) {
    return {
      name,
      required,
      state: "available",
      version: tool.version,
      path,
      detail: path,
      probeFailed: false,
    };
  }
  const reason = tool.unavailableReason ?? `${name} unavailable`;
  return {
    name,
    required,
    state: required ? "unavailable" : "optional",
    version: tool.version,
    path,
    detail: reason,
    // A version alone does not mean usable (bwrap's unshare probe is separate).
    probeFailed: tool.version !== null || /probe failed|unshare profile/i.test(reason),
  };
}

export async function detectValidationCapabilities(
  options: ValidationCapabilityOptions = {},
): Promise<ValidationCapabilities> {
  const probe = options.probe ?? defaultProbe;
  const nodePath = options.nodePath ?? process.execPath;
  const pythonPath = options.pythonPath ?? "python3";
  const sandbox =
    options.sandbox ??
    (await detectCapabilities(options.bwrapPath ?? "bwrap", options.prlimitPath ?? "prlimit"));
  const containers =
    options.containers ??
    (await detectContainerCapabilities({
      ...(options.probe === undefined ? {} : { probe: options.probe }),
      ...(options.dockerPath === undefined ? {} : { dockerPath: options.dockerPath }),
      ...(options.podmanPath === undefined ? {} : { podmanPath: options.podmanPath }),
      ...(options.gvisorPath === undefined ? {} : { gvisorPath: options.gvisorPath }),
    }));
  const [node, python, pyright, tsc, vitest] = await Promise.all([
    probeExecutable("node", true, nodePath, probe, ["--version"]),
    probeExecutable("python3", true, pythonPath, probe, ["--version"]),
    probeNodeEntry("pyright", nodePath, options.pyrightEntryPath, probe),
    probeNodeEntry("tsc", nodePath, options.typescriptEntryPath, probe),
    probeNodeEntry("vitest", nodePath, options.vitestEntryPath, probe),
  ]);
  const bwrap = fromSandboxTool("bwrap", true, sandbox.bwrap, options.bwrapPath ?? "bwrap");
  const prlimit = fromSandboxTool(
    "prlimit",
    false,
    sandbox.prlimit,
    options.prlimitPath ?? "prlimit",
  );
  const docker: ToolStatus = {
    name: "docker",
    required: false,
    state: containers.docker.usable ? "available" : "optional",
    version: containers.docker.version,
    path: containers.docker.path,
    detail: containers.docker.usable
      ? `${containers.docker.path} (daemon ${containers.docker.daemonVersion ?? "unknown"})`
      : (containers.docker.unavailableReason ?? "docker unavailable"),
    probeFailed: containers.docker.executable && !containers.docker.daemon,
  };
  const podman: ToolStatus = {
    name: "podman",
    required: false,
    state: containers.podman.usable ? "available" : "optional",
    version: containers.podman.version,
    path: containers.podman.path,
    detail: containers.podman.usable
      ? `${containers.podman.path} (runtime ${containers.podman.daemonVersion ?? "unknown"})`
      : (containers.podman.unavailableReason ?? "podman unavailable"),
    probeFailed: containers.podman.executable && !containers.podman.daemon,
  };
  const gvisor: ToolStatus = {
    name: "gvisor",
    required: false,
    state: containers.gvisor.available ? "available" : "optional",
    version: containers.gvisor.version,
    path: containers.gvisor.available ? containers.gvisor.runtimeName : null,
    detail: containers.gvisor.available
      ? `runsc available (--runtime ${containers.gvisor.runtimeName})`
      : (containers.gvisor.unavailableReason ?? "runsc unavailable"),
    probeFailed: false,
  };
  const requiredStatuses = [node, python, bwrap, pyright, tsc, vitest];
  return {
    node,
    python,
    bwrap,
    prlimit,
    pyright,
    tsc,
    vitest,
    docker,
    podman,
    gvisor,
    container: containers,
    sandbox,
    strictAvailable: containers.usable !== null,
    requiredAvailable: requiredStatuses.every((status) => status.state === "available"),
  };
}

// Stable, testable doctor output. Required failures are actionable; optional
// capabilities are reported as optional, never as failures of the install.
export function formatCapabilityReport(capabilities: ValidationCapabilities): string {
  const rows: ToolStatus[] = [
    capabilities.node,
    capabilities.python,
    capabilities.tsc,
    capabilities.pyright,
    capabilities.vitest,
    capabilities.bwrap,
    capabilities.prlimit,
    capabilities.docker,
    capabilities.podman,
    capabilities.gvisor,
  ];
  const lines = ["ctrans doctor — observed environment capabilities", ""];
  for (const status of rows) {
    const label = status.state.padEnd(11);
    const requirement = status.required ? "required" : "optional";
    lines.push(
      `${status.name.padEnd(10)} ${label} ${requirement.padEnd(8)} ${status.version ?? "-"}`,
    );
    lines.push(`${"".padEnd(22)}${status.detail}`);
  }
  lines.push("");
  lines.push(
    capabilities.requiredAvailable
      ? "required capabilities: available — full deterministic validation is supported"
      : "required capabilities: MISSING — affected stages are reported skipped with their reasons",
  );
  lines.push(
    capabilities.sandbox.filesystemIsolation === "bwrap-allowlist"
      ? "filesystem isolation: bwrap least-privilege allowlist (system trees + minimal /etc + workspace/toolchain mounts)"
      : "filesystem isolation: none (bwrap unavailable; no host-filesystem boundary)",
  );
  lines.push(
    capabilities.strictAvailable
      ? "strict container mode: a Docker/Podman runtime is usable (an explicit image is still required)"
      : "strict container mode: unavailable (no usable Docker/Podman runtime)",
  );
  lines.push(
    capabilities.gvisor.state === "available"
      ? "gVisor: available (opt-in via strict mode)"
      : "gVisor: optional and not available",
  );
  return lines.join("\n") + "\n";
}

// Doctor exit code: 0 only when every required capability was observed usable.
export function capabilityExitCode(capabilities: ValidationCapabilities): 0 | 1 {
  return capabilities.requiredAvailable ? 0 : 1;
}
