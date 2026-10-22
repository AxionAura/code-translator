// Capability matrix + evidence validation (M10). Every documented capability is
// probed functionally (a fake probe supplies deterministic environment facts);
// inconsistent stage evidence is rejected instead of producing a claim.
import { describe, expect, it } from "vitest";

import type {
  CommandProbe,
  ContainerCapabilities,
  ContainerRuntimeStatus,
  SandboxCapabilities,
} from "@ctrans/sandbox";

import {
  assembleStages,
  assertStageEvidence,
  capabilityExitCode,
  detectValidationCapabilities,
  formatCapabilityReport,
  stageEvidenceIssues,
  ValidationEvidenceError,
  type ValidationCapabilityOptions,
} from "../src/index.js";
import type { StageResult, ValidationStageName } from "@ctrans/core";

function sandbox(bwrap = true): SandboxCapabilities {
  return {
    bwrap: {
      available: bwrap,
      version: bwrap ? "bubblewrap 0.12.0" : null,
      unavailableReason: bwrap
        ? null
        : "bwrap unshare profile failed (unprivileged namespaces disabled)",
    },
    prlimit: { available: true, version: "prlimit 2.39", unavailableReason: null },
    networkIsolation: bwrap ? "enforced" : "policy-only",
    filesystemIsolation: bwrap ? "bwrap-allowlist" : "none",
  };
}

const usableDocker: ContainerRuntimeStatus = {
  kind: "docker",
  path: "docker",
  executable: true,
  daemon: true,
  version: "Docker version 29.8.1",
  daemonVersion: "29.8.1",
  unavailableReason: null,
  usable: true,
};

const clientOnlyPodman: ContainerRuntimeStatus = {
  kind: "podman",
  path: "podman",
  executable: true,
  daemon: false,
  version: "podman version 5.8.7",
  daemonVersion: null,
  unavailableReason: "podman daemon/runtime is not reachable (2)",
  usable: false,
};

function containers(
  docker: ContainerRuntimeStatus = usableDocker,
  gvisor = false,
): ContainerCapabilities {
  return {
    docker,
    podman: clientOnlyPodman,
    gvisor: {
      available: gvisor,
      version: gvisor ? "runsc release-2024" : null,
      runtimeName: "runsc",
      unavailableReason: gvisor ? null : "runsc not found",
    },
    usable: docker.usable ? docker : null,
  };
}

function probe(responses: Readonly<Record<string, string>>): CommandProbe {
  return {
    async run(path, args) {
      const response = responses[`${path} ${args.join(" ")}`];
      if (response === undefined) {
        throw Object.assign(new Error(`missing ${path}`), { code: "ENOENT" });
      }
      return { stdout: response };
    },
  };
}

const baseResponses: Record<string, string> = {
  "/usr/bin/node --version": "v24.15.0",
  "python3 --version": "Python 3.14.7",
  "/usr/bin/node /tool/pyright/index.js --version": "pyright 1.1.406",
  "/usr/bin/node /tool/typescript/bin/tsc --version": "Version 6.0.3",
  "/usr/bin/node /tool/node_modules/vitest/vitest.mjs --version": "5.0.3",
};

function options(
  overrides: Partial<ValidationCapabilityOptions> = {},
): ValidationCapabilityOptions {
  return {
    probe: probe(baseResponses),
    nodePath: "/usr/bin/node",
    pythonPath: "python3",
    pyrightEntryPath: "/tool/pyright/index.js",
    typescriptEntryPath: "/tool/typescript/bin/tsc",
    vitestEntryPath: "/tool/node_modules/vitest/vitest.mjs",
    sandbox: sandbox(),
    containers: containers(),
    ...overrides,
  };
}

describe("detectValidationCapabilities", () => {
  it("reports every required capability from functional probes", async () => {
    const caps = await detectValidationCapabilities(options());
    expect(caps.node.state).toBe("available");
    expect(caps.python.state).toBe("available");
    expect(caps.tsc.version).toBe("Version 6.0.3");
    expect(caps.pyright.version).toBe("pyright 1.1.406");
    expect(caps.vitest.version).toBe("5.0.3");
    expect(caps.bwrap.state).toBe("available");
    expect(caps.docker.state).toBe("available");
    expect(caps.podman.state).toBe("optional");
    expect(caps.podman.probeFailed).toBe(true);
    expect(caps.strictAvailable).toBe(true);
    expect(caps.requiredAvailable).toBe(true);
    expect(capabilityExitCode(caps)).toBe(0);
  });

  it("marks missing required tools unavailable with actionable detail and exit 1", async () => {
    const responses = { ...baseResponses };
    delete responses["python3 --version"];
    const caps = await detectValidationCapabilities(options({ probe: probe(responses) }));
    expect(caps.python.state).toBe("unavailable");
    expect(caps.python.detail).toContain("not found");
    expect(caps.requiredAvailable).toBe(false);
    expect(capabilityExitCode(caps)).toBe(1);
    const report = formatCapabilityReport(caps);
    expect(report).toContain("MISSING");
    expect(report).toContain("python3");
  });

  it("does not treat a toolchain path as available when its probe fails", async () => {
    const caps = await detectValidationCapabilities(
      options({
        probe: probe({ ...baseResponses, "/usr/bin/node /tool/typescript/bin/tsc --version": "" }),
      }),
    );
    // Empty stdout is a successful probe but carries no version; the tool ran.
    expect(caps.tsc.state).toBe("available");
    expect(caps.tsc.version).toBeNull();
  });

  it("reports bwrap without functional isolation as unavailable, not optional", async () => {
    const caps = await detectValidationCapabilities(options({ sandbox: sandbox(false) }));
    expect(caps.bwrap.state).toBe("unavailable");
    expect(caps.bwrap.detail).toContain("unshare");
    expect(caps.requiredAvailable).toBe(false);
  });

  it("missing optional container runtimes do not fail required validation", async () => {
    const down: ContainerRuntimeStatus = {
      ...usableDocker,
      daemon: false,
      usable: false,
      unavailableReason: "docker daemon/runtime is not reachable (1)",
    };
    const caps = await detectValidationCapabilities(options({ containers: containers(down) }));
    expect(caps.strictAvailable).toBe(false);
    expect(caps.docker.state).toBe("optional");
    expect(caps.requiredAvailable).toBe(true);
    expect(capabilityExitCode(caps)).toBe(0);
    expect(formatCapabilityReport(caps)).toContain("strict container mode: unavailable");
    expect(formatCapabilityReport(caps)).toContain("filesystem isolation:");
  });

  it("reports gVisor only when the runtime probe succeeded", async () => {
    const withGvisor = await detectValidationCapabilities(
      options({ containers: containers(usableDocker, true) }),
    );
    expect(withGvisor.gvisor.state).toBe("available");
    expect(formatCapabilityReport(withGvisor)).toContain("gVisor: available");
    const without = await detectValidationCapabilities(options());
    expect(without.gvisor.state).toBe("optional");
    expect(formatCapabilityReport(without)).toContain("optional and not available");
  });

  it("treats missing toolchain entry configuration as unavailable (no invented paths)", async () => {
    const configured = options();
    expect(configured.vitestEntryPath).toBeDefined();
    const withoutVitest = { ...configured };
    delete withoutVitest.vitestEntryPath;
    const caps = await detectValidationCapabilities(withoutVitest);
    expect(caps.vitest.state).toBe("unavailable");
    expect(caps.vitest.detail).toContain("not configured");
  });
});

function stage(
  name: ValidationStageName,
  status: StageResult["status"],
  reason: string | null = null,
): StageResult {
  return { stage: name, status, reason, details: [] };
}

const ORDER: readonly ValidationStageName[] = [
  "S1-syntax",
  "S2-types",
  "S3-dependencies",
  "S4-build",
  "S5-tests",
  "S6-differential",
  "S7-smoke",
];

function allPassing(): StageResult[] {
  return ORDER.map((name) => stage(name, name === "S7-smoke" ? "skipped" : "pass"));
}

describe("stage evidence validation (validator-on-validator)", () => {
  it("accepts a complete canonical stage set and derives the claim", () => {
    const stages = allPassing();
    expect(stageEvidenceIssues(stages, { required: ORDER, claimedLevel: 5 })).toEqual([]);
    expect(assertStageEvidence(stages, { required: ORDER })).toBe(5);
  });

  it("rejects duplicate stages", () => {
    const stages = [...allPassing(), stage("S5-tests", "pass")];
    expect(stageEvidenceIssues(stages).some((issue) => issue.includes("duplicate"))).toBe(true);
    expect(() => assertStageEvidence(stages)).toThrow(ValidationEvidenceError);
  });

  it("rejects out-of-order and unknown stages", () => {
    const reversed = [...allPassing()].reverse();
    expect(stageEvidenceIssues(reversed).some((issue) => issue.includes("out of order"))).toBe(
      true,
    );
    const unknown = [
      ...allPassing(),
      { stage: "S9-fake", status: "pass", reason: null, details: [] },
    ] as unknown as StageResult[];
    expect(stageEvidenceIssues(unknown).some((issue) => issue.includes("unknown stage"))).toBe(
      true,
    );
  });

  it("rejects missing required stages (never infers them)", () => {
    const issues = stageEvidenceIssues(
      allPassing().filter((s) => s.stage !== "S7-smoke"),
      {
        required: ORDER,
      },
    );
    expect(issues).toContain("missing required stage: S7-smoke");
  });

  it("rejects a claimed level inconsistent with the executed evidence", () => {
    const failing = allPassing().map((entry) =>
      entry.stage === "S5-tests" ? stage("S5-tests", "fail", "1 test failed") : entry,
    );
    const issues = stageEvidenceIssues(failing, { claimedLevel: 5 });
    expect(issues.some((issue) => issue.includes("computed level 3"))).toBe(true);
  });

  it("rejects a pass carrying a failure reason and a failure without one", () => {
    const passWithReason = allPassing().map((entry) =>
      entry.stage === "S1-syntax" ? stage("S1-syntax", "pass", "broken") : entry,
    );
    expect(
      stageEvidenceIssues(passWithReason).some((i) => i.includes("pass with a failure reason")),
    ).toBe(true);
    const failNoReason = allPassing().map((entry) =>
      entry.stage === "S2-types" ? stage("S2-types", "fail") : entry,
    );
    expect(
      stageEvidenceIssues(failNoReason).some((i) => i.includes("failed without a reason")),
    ).toBe(true);
  });

  it("assembles missing required stages as explicit skips (visible, never absent)", () => {
    const executed = allPassing().filter(
      (entry) => entry.stage === "S1-syntax" || entry.stage === "S5-tests",
    );
    const assembled = assembleStages(executed, ORDER, (name) => `prerequisite for ${name} not run`);
    expect(assembled.map((entry) => entry.stage)).toEqual([...ORDER]);
    for (const entry of assembled) {
      if (entry.stage !== "S1-syntax" && entry.stage !== "S5-tests") {
        expect(entry.status).toBe("skipped");
        expect(entry.reason).toContain("prerequisite");
      }
    }
  });
});
