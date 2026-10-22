// Strict container driver + capability detection (M10; docs/security.md §3).
// The pure argv builder is tested directly (the security-relevant flags are the
// contract); runner tests use a controlled fake runtime executable so the suite
// does not depend on a local Docker daemon. A real daemon-backed run is exercised
// when one is available, with an explicit evidence branch when it is not.
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import {
  buildContainerArgv,
  detectContainerCapabilities,
  detectCapabilities,
  SandboxIsolationError,
  SandboxRunner,
  validateContainerOptions,
  type CommandProbe,
  type ContainerCapabilities,
  type ContainerRunOptions,
  type SandboxRunSpec,
} from "../src/index.js";

const exec = promisify(execFile);
const created: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created.reverse()) rmSync(dir, { recursive: true, force: true });
});

function fakeProbe(responses: Readonly<Record<string, string>>): CommandProbe {
  return {
    async run(path, args) {
      const key = `${path} ${args.join(" ")}`;
      const response = responses[key];
      if (response === undefined) {
        throw Object.assign(new Error(`not found: ${path}`), { code: "ENOENT" });
      }
      return { stdout: response };
    },
  };
}

describe("detectContainerCapabilities", () => {
  it("requires a daemon answer, not just an executable", async () => {
    const caps = await detectContainerCapabilities({
      probe: fakeProbe({
        "docker --version": "Docker version 29.8.1, build abc",
        "docker version --format {{.Server.Version}}": "29.8.1",
        "podman --version": "podman version 5.8.7",
        "podman info --format {{.Version.Version}}": "5.8.7",
        "runsc --version": "runsc version release-2024",
      }),
    });
    expect(caps.docker.executable).toBe(true);
    expect(caps.docker.daemon).toBe(true);
    expect(caps.docker.usable).toBe(true);
    expect(caps.podman.usable).toBe(true);
    expect(caps.gvisor.available).toBe(true);
    expect(caps.gvisor.runtimeName).toBe("runsc");
    // Deterministic choice: docker first.
    expect(caps.usable?.kind).toBe("docker");
  });

  it("reports an installed client with an unreachable daemon as unusable", async () => {
    const caps = await detectContainerCapabilities({
      probe: fakeProbe({
        "docker --version": "Docker version 29.8.1, build abc",
        "podman --version": "podman version 5.8.7",
        "podman info --format {{.Version.Version}}": "5.8.7",
      }),
    });
    expect(caps.docker.executable).toBe(true);
    expect(caps.docker.daemon).toBe(false);
    expect(caps.docker.usable).toBe(false);
    expect(caps.docker.unavailableReason).toContain("daemon/runtime is not reachable");
    expect(caps.usable?.kind).toBe("podman");
    expect(caps.gvisor.available).toBe(false);
  });

  it("reports no usable runtime when neither works", async () => {
    const caps = await detectContainerCapabilities({ probe: fakeProbe({}) });
    expect(caps.docker.executable).toBe(false);
    expect(caps.podman.executable).toBe(false);
    expect(caps.usable).toBeNull();
    expect(caps.docker.unavailableReason).toContain("not found");
  });
});

describe("buildContainerArgv", () => {
  const options: ContainerRunOptions = {
    runtime: "docker",
    runtimePath: "/usr/bin/docker",
    image: "ctrans/validation:1",
  };

  it("enforces no-network, read-only rootfs, dropped capabilities, and mount boundaries", () => {
    const argv = buildContainerArgv(options, "/tmp/ctrans-run-abc", {
      strict: true,
      argv: ["node", "/tool/node_modules/vitest/vitest.mjs", "run"],
      containerMounts: [{ path: "/tool/node_modules", readOnly: true }],
      env: { PYTHONPATH: "." },
    });
    const text = argv.join(" ");
    expect(text).toContain("--network none");
    expect(text).toContain("--read-only");
    expect(text).toContain("--cap-drop ALL");
    expect(text).toContain("--security-opt no-new-privileges");
    expect(text).toContain("--pull=never");
    expect(text).toContain("--pids-limit 256");
    expect(text).toContain("--memory 2g");
    expect(text).toContain("--tmpfs /tmp:rw,nosuid,nodev");
    expect(text).toContain("--volume /tmp/ctrans-run-abc:/tmp/ctrans-run-abc:rw");
    expect(text).toContain("--volume /tool/node_modules:/tool/node_modules:ro");
    expect(text).toContain("--env PYTHONPATH=.");
    expect(text).toContain("--entrypoint node");
    // No host environment or docker socket is exposed.
    expect(text).not.toContain("docker.sock");
    expect(text).not.toContain("CTRANS_AI_KEY");
  });

  it("rejects writable toolchain mounts (the workspace is the only rw path)", () => {
    expect(() =>
      buildContainerArgv(options, "/tmp/ws", {
        strict: true,
        argv: ["node", "--version"],
        containerMounts: [{ path: "/tool/node_modules", readOnly: false }],
      }),
    ).toThrow(/only the workspace is writable/);
  });

  it("uses the container-native argv when provided", () => {
    const argv = buildContainerArgv(options, "/tmp/ws", {
      strict: true,
      argv: ["/host/node", "/host/vitest.mjs"],
      containerArgv: ["node", "/mounted/vitest.mjs", "run"],
    });
    expect(argv.slice(-2)).toEqual(["/mounted/vitest.mjs", "run"]);
    expect(argv).toContain("--entrypoint");
    expect(argv[argv.indexOf("--entrypoint") + 1]).toBe("node");
  });

  it("adds the gVisor runtime only when it was verified as available", () => {
    const argv = buildContainerArgv(
      { ...options, gvisor: { requested: true, available: true, runtimeName: "runsc" } },
      "/tmp/ws",
      { strict: true, argv: ["/bin/true"] },
    );
    expect(argv.join(" ")).toContain("--runtime runsc");
  });

  it("refuses requested-but-unavailable gVisor and malformed images", () => {
    expect(() =>
      validateContainerOptions({
        ...options,
        gvisor: { requested: true, available: false, runtimeName: "runsc" },
      }),
    ).toThrow(/gVisor/);
    expect(() => validateContainerOptions({ ...options, image: "bad image; rm -rf /" })).toThrow(
      /invalid container image/,
    );
  });
});

function spec(overrides: Partial<SandboxRunSpec> & { argv: readonly string[] }): SandboxRunSpec {
  return {
    files: [{ path: "main.txt", content: "x\n" }],
    timeoutMs: 15000,
    stdoutCapBytes: 65536,
    stderrCapBytes: 65536,
    ...overrides,
  };
}

async function fakeRuntimeScript(exitCode: number): Promise<string> {
  const dir = tempDir("ctrans-fake-container-");
  const path = join(dir, "fake-docker");
  writeFileSync(path, `#!/bin/sh\nexit ${String(exitCode)}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

describe("SandboxRunner strict mode", () => {
  it("refuses to run when no container runtime is configured", async () => {
    const runner = new SandboxRunner({
      capabilities: await detectCapabilities(),
    });
    await expect(
      runner.run(spec({ argv: ["python3", "-c", "print(1)"], strict: true })),
    ).rejects.toBeInstanceOf(SandboxIsolationError);
  });

  it("refuses a strict run when gVisor was requested but is unavailable", async () => {
    const runner = new SandboxRunner({
      capabilities: await detectCapabilities(),
      container: {
        runtime: "docker",
        runtimePath: await fakeRuntimeScript(0),
        image: "ctrans/test:1",
        gvisor: { requested: true, available: false, runtimeName: "runsc" },
      },
    });
    await expect(runner.run(spec({ argv: ["/bin/true"], strict: true }))).rejects.toThrow(/gVisor/);
  });

  it("classifies a container-CLI startup failure as infrastructure (exit 125)", async () => {
    const runner = new SandboxRunner({
      capabilities: await detectCapabilities(),
      container: {
        runtime: "docker",
        runtimePath: await fakeRuntimeScript(125),
        image: "ctrans/test:1",
      },
    });
    const result = await runner.run(
      spec({ argv: ["/bin/true"], strict: true, stdoutCapBytes: 4096, stderrCapBytes: 4096 }),
    );
    expect(result.outcome).toBe("container-error");
    expect(result.exitCode).toBe(125);
  });

  it("times out and still cleans up a hanging container CLI", async () => {
    const dir = tempDir("ctrans-fake-hang-");
    const path = join(dir, "fake-docker");
    writeFileSync(path, '#!/bin/sh\nif [ "$1" = "rm" ]; then exit 0; fi\nsleep 60\n', "utf8");
    chmodSync(path, 0o755);
    const runner = new SandboxRunner({
      capabilities: await detectCapabilities(),
      container: { runtime: "docker", runtimePath: path, image: "ctrans/test:1" },
    });
    const result = await runner.run(spec({ argv: ["/bin/true"], strict: true, timeoutMs: 500 }));
    expect(result.outcome).toBe("timeout");
    expect(result.durationMs).toBeLessThan(10000);
  });

  it("executes a real container run when a daemon and local image are available", async () => {
    const caps = await detectContainerCapabilities();
    const image = await firstLocalImage(caps);
    if (caps.usable === null || image === null) {
      // Honest environment branch: the refusal path above is the guarantee on
      // hosts without a runtime/image; no successful isolation claim is invented.
      console.log("[env] no usable container runtime or local image: real strict run not executed");
      return;
    }
    const runner = new SandboxRunner({
      capabilities: await detectCapabilities(),
      container: {
        runtime: caps.usable.kind,
        runtimePath: caps.usable.path,
        image,
      },
    });
    console.log(
      `[env] executing real strict container run with ${caps.usable.kind} image ${image}`,
    );
    const result = await runner.run(
      spec({
        argv: ["/bin/echo", "strict-container-ok"],
        strict: true,
        containerArgv: ["/bin/echo", "strict-container-ok"],
        timeoutMs: 30000,
      }),
    );
    expect(result.outcome, result.stderr).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("strict-container-ok");
  }, 60000);
});

async function firstLocalImage(caps: ContainerCapabilities): Promise<string | null> {
  if (caps.usable === null) return null;
  for (const image of ["fedora:44", "ubuntu:latest"]) {
    try {
      await exec(caps.usable.path, ["image", "inspect", image], { timeout: 10000 });
      return image;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}
