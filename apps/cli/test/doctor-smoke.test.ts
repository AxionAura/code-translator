// CLI M10 surface: `doctor` reports observed capabilities; project `--smoke`
// runs an opt-in S7 harness only through the sandbox; strict flags fail closed
// when a runtime/image is unavailable.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  detectCapabilities,
  type ContainerCapabilities,
  type SandboxCapabilities,
} from "@axion-ct/sandbox";
import { detectValidationCapabilities } from "@axion-ct/validator";

import { runCliCommand, runnerToolchain } from "../src/main.ts";
import { runDoctor } from "../src/doctor.ts";

const workspace = mkdtempSync(join(tmpdir(), "ctrans-doctor-smoke-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

const CLEAN_MODULE = `def compute():
    return 1
`;
const CLEAN_TEST = `from mod import compute

def test_compute():
    assert compute() == 1
`;

function writeProject(name: string, files: Record<string, string>): string {
  const root = join(workspace, name, "src");
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

let capabilities: SandboxCapabilities;
beforeAll(async () => {
  capabilities = await detectCapabilities();
});

describe("ctrans doctor", () => {
  it("reports the actual environment and exit code matches the required matrix", async () => {
    const result = await runCliCommand(["doctor"]);
    expect([0, 1]).toContain(result.code);
    expect(result.stdout).toContain("ctrans doctor — observed environment capabilities");
    for (const name of [
      "node",
      "python3",
      "tsc",
      "pyright",
      "vitest",
      "bwrap",
      "docker",
      "podman",
      "gvisor",
    ]) {
      expect(result.stdout).toContain(name);
    }
    // The bwrap line must agree with a direct, independent probe.
    const isolation = capabilities.bwrap.available;
    expect(result.stdout).toContain(
      isolation ? "strict container mode" : "required capabilities: MISSING",
    );
  }, 60000);

  it("uses the shared capability model and fails only on missing REQUIRED tools", async () => {
    const toolchain = runnerToolchain();
    const healthy = await detectValidationCapabilities({
      nodePath: process.execPath,
      pythonPath: "python3",
      pyrightEntryPath: "/definitely/missing/pyright",
      typescriptEntryPath: toolchain.typescriptEntryPath,
      vitestEntryPath: toolchain.vitestEntryPath,
      sandbox: capabilities,
      containers: noContainers(),
    });
    expect(healthy.pyright.state).toBe("unavailable");
    const failed = await runDoctor(async () => healthy);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("pyright");
    expect(failed.stdout).toContain("not found");
  });
});

function noContainers(): ContainerCapabilities {
  const status = {
    executable: false,
    daemon: false,
    version: null,
    daemonVersion: null,
    usable: false,
    unavailableReason: "not found",
  } as const;
  return {
    docker: { kind: "docker", path: "docker", ...status },
    podman: { kind: "podman", path: "podman", ...status },
    gvisor: {
      available: false,
      version: null,
      runtimeName: "runsc",
      unavailableReason: "runsc not found",
    },
    usable: null,
  };
}

describe("project --smoke (S7)", () => {
  it("runs an opt-in harness in the sandbox and records the verdict", async () => {
    const sourceRoot = writeProject("smoke", {
      "mod.py": CLEAN_MODULE,
      "tests/test_mod.py": CLEAN_TEST,
    });
    const out = join(workspace, "smoke-out");
    const manifest = join(workspace, "smoke.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        argv: ["node", "harness.mjs"],
        files: [
          {
            path: "harness.mjs",
            content: "import { compute } from './mod.ts';\nconsole.log(compute());\n",
          },
        ],
        expectedStdout: "1\n",
      }),
      "utf8",
    );
    const result = await runCliCommand([
      "project",
      sourceRoot,
      "--to",
      "ts",
      "-o",
      out,
      "--smoke",
      manifest,
      "--no-tests",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/smoke: (pass|skipped)/);
    const smoke = JSON.parse(readFileSync(join(out, ".ctrans", "smoke.json"), "utf8")) as {
      status: string;
      exitCode: number | null;
    };
    if (capabilities.bwrap.available) {
      expect(smoke.status).toBe("pass");
      expect(smoke.exitCode).toBe(0);
    } else {
      expect(smoke.status).toBe("skipped");
    }
  }, 120000);

  it("rejects malformed or misapplied smoke manifests", async () => {
    const sourceRoot = writeProject("smoke-bad", { "mod.py": CLEAN_MODULE });
    const out = join(workspace, "smoke-bad-out");
    const badJson = join(workspace, "bad-smoke.json");
    writeFileSync(badJson, "{not json", "utf8");
    const malformed = await runCliCommand([
      "project",
      sourceRoot,
      "--to",
      "ts",
      "-o",
      out,
      "--smoke",
      badJson,
    ]);
    expect(malformed.code).toBe(1);
    expect(malformed.stderr).toContain("not valid JSON");
    const misplaced = await runCliCommand([
      "translate",
      sourceRoot,
      "--to",
      "ts",
      "-o",
      out,
      "--smoke",
      badJson,
    ]);
    expect(misplaced.code).toBe(2);
    expect(misplaced.stderr).toContain("only available for `project`");
  });

  it("does not run S7 without a harness (explicit opt-in)", async () => {
    const sourceRoot = writeProject("no-smoke", { "mod.py": CLEAN_MODULE });
    const out = join(workspace, "no-smoke-out");
    const result = await runCliCommand([
      "project",
      sourceRoot,
      "--to",
      "ts",
      "-o",
      out,
      "--no-tests",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("smoke: pass");
    const report = JSON.parse(readFileSync(join(out, ".ctrans", "report.json"), "utf8")) as {
      validationStages: { stage: string; status: string }[];
    };
    const s7 = report.validationStages.find((stage) => stage.stage === "S7-smoke");
    expect(s7?.status).toBe("skipped");
  }, 120000);
});

describe("strict mode CLI gates", () => {
  it("--sandbox-image requires --strict", async () => {
    const sourceRoot = writeProject("strict-image", { "mod.py": CLEAN_MODULE });
    const result = await runCliCommand([
      "project",
      sourceRoot,
      "--to",
      "ts",
      "-o",
      join(workspace, "strict-image-out"),
      "--sandbox-image",
      "ctrans/image:1",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("requires --strict");
  });

  it("refuses strict mode without a configured image (never falls back to the host)", async () => {
    const sourceRoot = writeProject("strict-no-image", { "mod.py": CLEAN_MODULE });
    const out = join(workspace, "strict-no-image-out");
    const previous = process.env["CTRANS_SANDBOX_IMAGE"];
    delete process.env["CTRANS_SANDBOX_IMAGE"];
    try {
      const result = await runCliCommand([
        "project",
        sourceRoot,
        "--to",
        "ts",
        "-o",
        out,
        "--strict",
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/strict|sandbox-image|CTRANS_SANDBOX_IMAGE/i);
    } finally {
      if (previous === undefined) delete process.env["CTRANS_SANDBOX_IMAGE"];
      else process.env["CTRANS_SANDBOX_IMAGE"] = previous;
    }
  }, 60000);
});
