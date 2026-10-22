// Container isolation driver (roadmap M10; docs/security.md §3): Docker/Podman
// strict-mode execution, optional gVisor. Detection is evidence-based — an
// executable on PATH is not "available" until its daemon answers — and a strict
// run refuses to start when the configured runtime, daemon, image, or requested
// gVisor runtime is unavailable. No silent fallback to host execution.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { SandboxSpecError } from "./errors.js";

const execFileP = promisify(execFile);

export type ContainerKind = "docker" | "podman";

export interface ContainerRuntimeStatus {
  readonly kind: ContainerKind;
  readonly path: string;
  // The executable itself ran successfully.
  readonly executable: boolean;
  // The daemon/runtime answered a real query (docker/podman info).
  readonly daemon: boolean;
  readonly version: string | null;
  readonly daemonVersion: string | null;
  // Why this runtime cannot be used (null only when usable).
  readonly unavailableReason: string | null;
  readonly usable: boolean;
}

export interface GvisorStatus {
  readonly available: boolean;
  readonly version: string | null;
  readonly runtimeName: string;
  readonly unavailableReason: string | null;
}

export interface ContainerCapabilities {
  readonly docker: ContainerRuntimeStatus;
  readonly podman: ContainerRuntimeStatus;
  readonly gvisor: GvisorStatus;
  // First usable runtime in deterministic order (docker, then podman).
  readonly usable: ContainerRuntimeStatus | null;
}

// Minimal command probe abstraction: tests inject a deterministic fake; the
// production implementation only runs tool binaries, never project code.
export interface CommandProbe {
  run(path: string, args: readonly string[], timeoutMs: number): Promise<{ stdout: string }>;
}

export interface ContainerDetectionOptions {
  readonly dockerPath?: string;
  readonly podmanPath?: string;
  readonly gvisorPath?: string;
  readonly probe?: CommandProbe;
}

const DEFAULT_DOCKER_PATH = "docker";
const DEFAULT_PODMAN_PATH = "podman";
const DEFAULT_GVISOR_PATH = "runsc";
const PROBE_TIMEOUT_MS = 8000;

const execProbe: CommandProbe = {
  async run(path, args, timeoutMs) {
    const probeDir = mkdtempSync(join(tmpdir(), "ctrans-container-probe-"));
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

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? String(code) : "unknown";
}

function firstLine(text: string): string | null {
  const line = text.trim().split("\n")[0] ?? "";
  return line === "" ? null : line;
}

async function probeRuntime(
  kind: ContainerKind,
  path: string,
  probe: CommandProbe,
): Promise<ContainerRuntimeStatus> {
  let version: string | null = null;
  try {
    version = firstLine((await probe.run(path, ["--version"], PROBE_TIMEOUT_MS)).stdout);
  } catch (error) {
    const code = errorCode(error);
    return {
      kind,
      path,
      executable: false,
      daemon: false,
      version: null,
      daemonVersion: null,
      unavailableReason:
        code === "ENOENT" ? `${path} not found` : `${path} --version failed (${code})`,
      usable: false,
    };
  }
  // The version probe only proves the client exists. Ask the daemon/runtime a
  // real question: `docker version` requires a reachable server, and `podman
  // info` requires a functioning runtime.
  try {
    const query =
      kind === "docker"
        ? await probe.run(path, ["version", "--format", "{{.Server.Version}}"], PROBE_TIMEOUT_MS)
        : await probe.run(path, ["info", "--format", "{{.Version.Version}}"], PROBE_TIMEOUT_MS);
    return {
      kind,
      path,
      executable: true,
      daemon: true,
      version,
      daemonVersion: firstLine(query.stdout),
      unavailableReason: null,
      usable: true,
    };
  } catch (error) {
    return {
      kind,
      path,
      executable: true,
      daemon: false,
      version,
      daemonVersion: null,
      unavailableReason: `${kind} daemon/runtime is not reachable (${errorCode(error)})`,
      usable: false,
    };
  }
}

async function probeGvisor(path: string, probe: CommandProbe): Promise<GvisorStatus> {
  try {
    const version = firstLine((await probe.run(path, ["--version"], PROBE_TIMEOUT_MS)).stdout);
    return {
      available: true,
      version,
      runtimeName: "runsc",
      unavailableReason: null,
    };
  } catch (error) {
    const code = errorCode(error);
    return {
      available: false,
      version: null,
      runtimeName: "runsc",
      unavailableReason: code === "ENOENT" ? `${path} not found` : `${path} probe failed (${code})`,
    };
  }
}

export async function detectContainerCapabilities(
  options: ContainerDetectionOptions = {},
): Promise<ContainerCapabilities> {
  const probe = options.probe ?? execProbe;
  const [docker, podman, gvisor] = await Promise.all([
    probeRuntime("docker", options.dockerPath ?? DEFAULT_DOCKER_PATH, probe),
    probeRuntime("podman", options.podmanPath ?? DEFAULT_PODMAN_PATH, probe),
    probeGvisor(options.gvisorPath ?? DEFAULT_GVISOR_PATH, probe),
  ]);
  return {
    docker,
    podman,
    gvisor,
    usable: docker.usable ? docker : podman.usable ? podman : null,
  };
}

// Configuration handed to the runner for a strict run. The image must contain
// the toolchain executables the run needs (documented in docs/security.md §3);
// pulling is disabled so a missing image is a hard failure, never a network fetch.
export interface ContainerRunOptions {
  readonly runtime: ContainerKind;
  readonly runtimePath: string;
  readonly image: string;
  readonly gvisor?: {
    readonly requested: boolean;
    readonly available: boolean;
    readonly runtimeName: string;
  };
}

const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

export function validateContainerOptions(options: ContainerRunOptions): void {
  if (options.runtime !== "docker" && options.runtime !== "podman") {
    throw new Error(`unsupported container runtime "${String(options.runtime)}"`);
  }
  if (!IMAGE_PATTERN.test(options.image)) {
    throw new Error(`invalid container image reference: ${options.image}`);
  }
  if (options.gvisor?.requested === true && !options.gvisor.available) {
    throw new Error("gVisor execution was requested but runsc is not available");
  }
}

export interface ContainerCommandSpec {
  readonly strict?: boolean;
  readonly argv: readonly string[];
  // Container-native argv (e.g. ["node", "/mounted/vitest.mjs", "run"]). Falls
  // back to argv when absent.
  readonly containerArgv?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly containerMounts?: readonly { readonly path: string; readonly readOnly?: boolean }[];
}

export function containerNameFor(workspace: string): string {
  const suffix = workspace.split("/").pop() ?? "run";
  return `ctrans-${suffix.replaceAll(/[^A-Za-z0-9_.-]/g, "-")}`;
}

// Build the docker/podman argv. Pure and exported so the security-relevant flags
// are unit-tested directly. `workspace` is mounted read-write (the child's cwd);
// tool-controlled mounts are read-only; no host env, sockets, or credentials are
// exposed; the root filesystem is read-only with a tmpfs /tmp.
export function buildContainerArgv(
  options: ContainerRunOptions,
  workspace: string,
  spec: ContainerCommandSpec,
): readonly string[] {
  if (spec.strict !== true) throw new Error("buildContainerArgv requires a strict spec");
  validateContainerOptions(options);
  const command = spec.containerArgv ?? spec.argv;
  if (command.length === 0 || command[0] === undefined || command[0] === "") {
    throw new Error("container command must start with a non-empty executable");
  }
  const name = containerNameFor(workspace);
  const argv: string[] = [
    options.runtimePath,
    "run",
    "--rm",
    "--pull=never",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    "2g",
    "--cpus",
    "2",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev",
    "--cidfile",
    join(workspace, ".ctrans-container-id"),
    "--volume",
    `${workspace}:${workspace}:rw`,
    "--workdir",
    workspace,
  ];
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (options.runtime === "podman") {
    // Rootless podman maps the caller to root in the container; keep the host
    // identity so bind-mounted workspace files stay accessible.
    argv.push("--userns=keep-id");
  } else if (uid !== undefined && gid !== undefined) {
    argv.push("--user", `${String(uid)}:${String(gid)}`);
  }
  for (const mount of spec.containerMounts ?? []) {
    if (!mount.path.startsWith("/") || mount.path.includes("..")) {
      throw new SandboxSpecError(
        `container mount must be an absolute path without '..': ${mount.path}`,
      );
    }
    if (mount.readOnly === false) {
      throw new SandboxSpecError(
        `container mounts are read-only; only the workspace is writable: ${mount.path}`,
      );
    }
    argv.push("--volume", `${mount.path}:${mount.path}:ro`);
  }
  argv.push("--env", "LANG=C.UTF-8", "--env", "HOME=/nonexistent-home");
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    argv.push("--env", `${key}=${value}`);
  }
  if (options.gvisor?.requested === true) {
    argv.push("--runtime", options.gvisor.runtimeName);
  }
  // Replace any image entrypoint so the command is exactly what the caller asked
  // for (a shell entrypoint could change argv semantics).
  argv.push("--entrypoint", command[0], options.image, ...command.slice(1));
  return argv;
}

// Remove a container that survived a timeout/interruption. `--rm` covers normal
// exits; this is the failure-path cleanup. Bounded, best-effort, never throws.
export async function cleanupContainer(
  runtimePath: string,
  containerId: string,
  timeoutMs = 10000,
): Promise<void> {
  if (containerId === "") return;
  try {
    await execFileP(runtimePath, ["rm", "-f", containerId], {
      timeout: timeoutMs,
      env: { PATH: process.env["PATH"] ?? "" },
    });
  } catch {
    // Already removed, daemon gone, or no permission to clean up — the original
    // run outcome already reports the failure honestly.
  }
}
