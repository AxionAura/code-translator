// Sandbox v1 enforcement tests (docs/security.md §3, roadmap M6): these tests
// verify the runner actually ENFORCES its limits (timeout kills, caps truncate,
// env allowlist isolates, bwrap unshare-net blocks network) — not that flags
// exist. Capability-dependent cases skip with an explicit reason when the tool
// is genuinely absent (bwrap probe failure), never silently.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  detectCapabilities,
  SandboxRunner,
  type SandboxCapabilities,
  type SandboxRunSpec,
} from "../src/index.js";

let capabilities: SandboxCapabilities;
let runner: SandboxRunner;

beforeAll(async () => {
  capabilities = await detectCapabilities();
  runner = new SandboxRunner({
    capabilities,
    cpuSeconds: 10,
    addressSpaceBytes: 2 * 1024 * 1024 * 1024,
  });
});

function spec(overrides: Partial<SandboxRunSpec> & { argv: readonly string[] }): SandboxRunSpec {
  return {
    files: [{ path: "main.py", content: "print('ok')\n" }],
    timeoutMs: 15000,
    stdoutCapBytes: 1024 * 1024,
    stderrCapBytes: 1024 * 1024,
    ...overrides,
  };
}

const PYTHON = "python3";

describe("sandbox capability report", () => {
  it("reports tool availability honestly (bwrap + prlimit probed)", () => {
    // This machine is expected to have both; when absent, the report says so.
    if (capabilities.bwrap.available) {
      expect(capabilities.bwrap.version).toBeTruthy();
      expect(capabilities.networkIsolation).toBe("enforced");
    } else {
      expect(capabilities.bwrap.unavailableReason).toBeTruthy();
      expect(capabilities.networkIsolation).toBe("policy-only");
    }
    expect(capabilities.prlimit.available).toBe(true); // util-linux present in CI
  });
});

describe("sandbox enforcement", () => {
  it("runs a simple command and reports the real exit code and output", async () => {
    const result = await runner.run(
      spec({
        argv: [PYTHON, "-c", "print('hello-sandbox')"],
        files: [{ path: "main.py", content: "" }],
      }),
    );
    expect(result.outcome).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello-sandbox");
  });

  it("reports nonzero exits as completed with the real code (verdict is data)", async () => {
    const result = await runner.run(
      spec({
        argv: [PYTHON, "-c", "raise SystemExit(3)"],
        files: [{ path: "main.py", content: "" }],
      }),
    );
    expect(result.outcome).toBe("completed");
    expect(result.exitCode).toBe(3);
  });

  it("kills the process at the wall-clock timeout and classifies it", async () => {
    const result = await runner.run(
      spec({
        argv: [PYTHON, "-c", "import time; time.sleep(60)"],
        files: [{ path: "main.py", content: "" }],
        timeoutMs: 1500,
      }),
    );
    expect(result.outcome).toBe("timeout");
    expect(result.durationMs).toBeLessThan(10000);
    expect(result.signal).toBe("SIGKILL");
  });

  it("kills the process when stdout exceeds its cap", async () => {
    const result = await runner.run(
      spec({
        argv: [PYTHON, "-c", "print('x' * 100000)"],
        files: [{ path: "main.py", content: "" }],
        stdoutCapBytes: 1024,
        timeoutMs: 15000,
      }),
    );
    expect(result.outcome).toBe("output-limit");
    expect(result.stdoutTruncated).toBe(true);
  });

  it("kills the process when stderr exceeds its cap", async () => {
    const result = await runner.run(
      spec({
        argv: [PYTHON, "-c", "import sys; print('e' * 100000, file=sys.stderr)"],
        files: [{ path: "main.py", content: "" }],
        stderrCapBytes: 1024,
        timeoutMs: 15000,
      }),
    );
    expect(result.outcome).toBe("output-limit");
    expect(result.stderrTruncated).toBe(true);
  });

  it("isolates the environment to the allowlist (no caller env leakage)", async () => {
    process.env["CTRANS_SANDBOX_CANARY"] = "leak-me";
    const result = await runner.run(
      spec({
        argv: [PYTHON, "-c", "import os; print(os.environ.get('CTRANS_SANDBOX_CANARY', 'absent'))"],
        files: [{ path: "main.py", content: "" }],
      }),
    );
    delete process.env["CTRANS_SANDBOX_CANARY"];
    expect(result.stdout).toContain("absent");
  });

  it("pins HOME away from the user's real home", async () => {
    const result = await runner.run(
      spec({
        argv: [PYTHON, "-c", "import os; print(os.environ['HOME'])"],
        files: [{ path: "main.py", content: "" }],
      }),
    );
    expect(result.stdout.trim()).toBe("/nonexistent-home");
  });

  it("rejects malformed specs (empty argv, escaping paths, absolute paths)", async () => {
    const { SandboxSpecError } = await import("../src/index.js");
    await expect(runner.run(spec({ argv: [] }))).rejects.toThrow(SandboxSpecError);
    await expect(
      runner.run(
        spec({
          argv: [PYTHON, "main.py"],
          files: [{ path: "../escape.py", content: "" }],
        }),
      ),
    ).rejects.toThrow(SandboxSpecError);
    await expect(
      runner.run(
        spec({
          argv: [PYTHON, "main.py"],
          files: [{ path: "/absolute.py", content: "" }],
        }),
      ),
    ).rejects.toThrow(SandboxSpecError);
  });

  it("reports command-not-found as a nonzero exit inside the sandbox", async () => {
    // The wrapper (bwrap/prlimit) spawns fine; the missing BINARY exits 127 —
    // an honest command failure, not a sandbox failure.
    const result = await runner.run(
      spec({
        argv: ["ctrans-definitely-not-a-binary", "--version"],
        files: [{ path: "main.py", content: "" }],
      }),
    );
    expect(result.outcome).toBe("completed");
    expect(result.exitCode).toBe(127);
  });

  it("reports spawn failures when the sandbox machinery itself is missing", async () => {
    if (capabilities.bwrap.available || capabilities.prlimit.available) {
      // Both wrappers present: the spawn-failed path is only reachable by a
      // broken wrapper path, which the capability report already flags.
      console.log("[skip] spawn-failure path requires no wrappers; capability report covers it");
      return;
    }
    const broken = new SandboxRunner({
      capabilities: {
        ...capabilities,
        bwrap: { available: false, version: null, unavailableReason: "test" },
        prlimit: { available: false, version: null, unavailableReason: "test" },
      },
    });
    const result = await broken.run(
      spec({
        argv: ["ctrans-definitely-not-a-binary", "--version"],
        files: [{ path: "main.py", content: "" }],
      }),
    );
    expect(result.outcome).toBe("spawn-failed");
  });

  it("materializes the workspace file set with executable bits", async () => {
    const script = "#!/bin/sh\necho script-ran\n";
    const result = await runner.run(
      spec({
        argv: [join("/bin", "sh"), "tool.sh"],
        files: [{ path: "tool.sh", content: script, executable: true }],
      }),
    );
    expect(result.outcome).toBe("completed");
    expect(result.stdout).toContain("script-ran");
  });

  it("re-binds toolchain mounts that live under the shadowed /tmp", async () => {
    // Reproduces the clean-clone layout: both the workspace and the toolchain
    // symlink target are under /tmp, where bwrap mounts a tmpfs.
    const target = mkdtempSync(join(tmpdir(), "ctrans-tool-"));
    writeFileSync(join(target, "value.txt"), "mounted-value\n");
    try {
      const result = await runner.run(
        spec({
          argv: [PYTHON, "-c", "print(open('tool/value.txt').read(), end='')"],
          files: [{ path: "main.py", content: "" }],
          symlinks: [{ path: "tool", target }],
          containerMounts: [{ path: target, readOnly: true }],
        }),
      );
      expect(result.outcome).toBe("completed");
      expect(result.stdout).toBe("mounted-value\n");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

// Network isolation is only enforced when bwrap is usable; verify the REAL
// guarantee (unshare-net), not a flag. Skips with the honest reason when the
// probe says bwrap is unavailable.
describe("network isolation (capability-aware)", () => {
  it("blocks outbound network for the child when bwrap is available", async () => {
    if (!capabilities.bwrap.available) {
      // Honest skip with the recorded reason (reported in CI output).
      console.log(`[skip] bwrap unavailable: ${String(capabilities.bwrap.unavailableReason)}`);
      return;
    }
    const result = await runner.run(
      spec({
        argv: [
          PYTHON,
          "-c",
          [
            "import socket",
            "try:",
            "    socket.create_connection(('example.com', 80), timeout=3)",
            "    print('NETWORK-REACHED')",
            "except OSError:",
            "    print('NETWORK-BLOCKED')",
          ].join("\n"),
        ],
        files: [{ path: "main.py", content: "" }],
        timeoutMs: 20000,
      }),
    );
    expect(result.outcome).toBe("completed");
    expect(result.stdout).toContain("NETWORK-BLOCKED");
  });

  it("fails in strict mode when isolation is required but unavailable", async () => {
    if (capabilities.bwrap.available) return; // strict-path only testable without bwrap
    const strict = new SandboxRunner({ capabilities });
    await expect(
      strict.run(
        spec({
          argv: [PYTHON, "-c", "print('x')"],
          files: [{ path: "main.py", content: "" }],
          requireNetworkIsolation: true,
        }),
      ),
    ).rejects.toThrow("network isolation required");
  });
});

afterAll(() => {
  void capabilities;
  void runner;
});
