// Project-mode repair (M10): candidates are re-validated through the REAL S1-S6
// pipeline (tsc build + sandboxed vitest + differential). Acceptance requires a
// strictly higher claim with no passing stage regressed AND passing behavioral
// stages; every rejection leaves the accepted baseline bytes untouched.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { detectCapabilities } from "@axion-ct/sandbox";
import type { RepairProposal, RepairProposer, RepairRequest } from "@axion-ct/repair";
import { RepairJournal } from "@axion-ct/repair";

import { runnerToolchain, runCliCommand } from "../src/main.ts";
import { runProject, type ProjectRunOptions } from "../src/project-run.ts";

const workspace = mkdtempSync(join(tmpdir(), "ctrans-project-repair-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

const BROKEN_RUNTIME = `def compute():
    if False:
        return missing_function()
    return 1
`;
const RUNTIME_TEST = `from mod import compute

def test_compute():
    assert compute() == 1
`;

const OS_SOURCE = `import os

def where():
    return os.getcwd()
`;
const OS_TEST = `from mod import where

def test_where():
    assert len(where()) > 0
`;

function writeProject(name: string, files: Record<string, string>): string {
  const root = join(workspace, name);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, "src", path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  return join(root, "src");
}

function proposal(request: RepairRequest, diff: string): RepairProposal {
  return {
    outcome: "patch",
    patch: {
      unit: request.unit,
      targetPath: request.targetPath,
      diff,
      rationale: "test repair",
      promptHash: "prompt",
      escalation: { provider: "fake", model: "scripted", promptHash: "prompt" },
      diffHash: `hash-${String(request.attempt)}-${diff.length}`,
    },
    reason: null,
    inputTokens: 1,
    outputTokens: 1,
    secretRuleIds: [],
  };
}

function removeMissingCallDiff(request: RepairRequest): string {
  const lines = request.emittedText.split("\n");
  const index = lines.findIndex((line) => line.includes("return missing_function();"));
  return [`@@ -${String(index)},1 +${String(index)},0 @@`, `-${lines[index]}`, ""].join("\n");
}

function fixAndBreakBehaviorDiff(request: RepairRequest): string {
  const lines = request.emittedText.split("\n");
  const call = lines.findIndex((line) => line.includes("return missing_function();"));
  const ret = lines.findIndex((line) => line.trim() === "return 1;");
  return [
    `@@ -${String(call)},1 +${String(call)},0 @@`,
    `-${lines[call]}`,
    `@@ -${String(ret)},1 +${String(ret)},1 @@`,
    `-${lines[ret]}`,
    "+  return 2;",
    "",
  ].join("\n");
}

function prependCommentDiff(): string {
  return ["@@ -1,0 +1,1 @@", "+// repair attempt", ""].join("\n");
}

function scriptedProposer(build: (request: RepairRequest) => RepairProposal): RepairProposer {
  return {
    async propose(request) {
      return build(request);
    },
  };
}

async function optionsFor(
  sourceRoot: string,
  outputRoot: string,
  proposer: RepairProposer,
  overrides: Partial<ProjectRunOptions> = {},
): Promise<ProjectRunOptions> {
  return {
    sourceRoot,
    outputRoot,
    target: "typescript",
    intMode: "number",
    sandbox: await detectCapabilities(),
    nodePath: process.execPath,
    pythonPath: "python3",
    ...runnerToolchain(),
    timeoutMs: 120000,
    repair: { proposer, maxAttemptsPerUnit: 1, maxAttemptsPerRun: 1 },
    ...overrides,
  };
}

describe("project-mode repair: behavioral re-validation", () => {
  it("accepts a candidate that passes S1-S6 and strictly improves the claim", async () => {
    const sourceRoot = writeProject("accepted", {
      "mod.py": BROKEN_RUNTIME,
      "tests/test_mod.py": RUNTIME_TEST,
    });
    const outputRoot = join(workspace, "accepted-out");
    const fullOptions = await optionsFor(
      sourceRoot,
      outputRoot,
      scriptedProposer((request) => proposal(request, removeMissingCallDiff(request))),
    );
    const baselineOptions: ProjectRunOptions = {
      sourceRoot,
      outputRoot,
      target: "typescript",
      intMode: "number",
      sandbox: await detectCapabilities(),
      nodePath: process.execPath,
      pythonPath: "python3",
      ...runnerToolchain(),
      timeoutMs: 120000,
    };
    const before = await runProject(baselineOptions);
    expect(before.pipeline.report.claimLevel).toBe(1);
    expect(before.s5!.status).toBe("pass");
    expect(before.s6!.status).toBe("pass");

    const result = await runProject(fullOptions);
    expect(result.repair!.stopReason).toBe("success");
    expect(result.repair!.acceptedUnits).toEqual(["mod.py"]);
    expect(result.pipeline.report.claimLevel).toBe(5);
    expect(result.stages.map((stage) => `${stage.stage}:${stage.status}`)).toEqual([
      "S1-syntax:pass",
      "S2-types:pass",
      "S3-dependencies:pass",
      "S4-build:pass",
      "S5-tests:pass",
      "S6-differential:pass",
      "S7-smoke:skipped",
    ]);
    const emitted = readFileSync(join(outputRoot, "mod.ts"), "utf8");
    expect(emitted).not.toContain("missing_function");
    // Final report reflects the accepted state and points at the journal.
    const report = JSON.parse(readFileSync(join(outputRoot, ".ctrans", "report.json"), "utf8")) as {
      claimLevel: number;
      repairJournal: string | null;
      validationStages: { stage: string; status: string }[];
    };
    expect(report.claimLevel).toBe(5);
    expect(report.repairJournal).toBe(".ctrans/repairs/repairs.json");
    expect(report.validationStages.map((stage) => `${stage.stage}:${stage.status}`)).toEqual(
      result.stages.map((stage) => `${stage.stage}:${stage.status}`),
    );
    const journal = RepairJournal.load(outputRoot);
    expect(journal.recovered).toBe(false);
    expect(journal.runs.length).toBe(1);
    expect(journal.runs[0]!.stopReason).toBe("success");
    expect(journal.runs[0]!.filesChanged).toEqual(["mod.ts"]);
    expect(journal.runs[0]!.baselineStateHash).not.toBe(journal.runs[0]!.finalStateHash);
  }, 120000);

  it("rejects a candidate that passes S1-S3 but fails S5 (mandatory behavior)", async () => {
    const sourceRoot = writeProject("s5fail", {
      "mod.py": OS_SOURCE,
      "tests/test_mod.py": OS_TEST,
    });
    const outputRoot = join(workspace, "s5fail-out");
    const result = await runProject(
      await optionsFor(
        sourceRoot,
        outputRoot,
        scriptedProposer((request) => {
          const lines = request.emittedText.split("\n");
          const index = lines.findIndex((line) => line.startsWith("import * as os"));
          const diff = [
            `@@ -${String(index)},1 +${String(index)},1 @@`,
            `-${lines[index]}`,
            "+const os = { getcwd: () => 42 };",
            "",
          ].join("\n");
          return proposal(request, diff);
        }),
      ),
    );
    // Candidate: S1/S2/S3 pass (or warn), but the behavior is broken.
    const candidateStages = result.repair!.attempts[0]!.stages;
    expect(candidateStages.find((entry) => entry.stage === "S2-types")!.status).toBe("pass");
    expect(candidateStages.find((entry) => entry.stage === "S5-tests")!.status).toBe("fail");
    expect(result.repair!.acceptedUnits).toEqual([]);
    expect(result.repair!.stopReason).toBe("attempts-exhausted");
    expect(result.repair!.attempts[0]!.reason).toContain("required behavioral stage");
    expect(result.pipeline.report.claimLevel).toBe(1);
    // Baseline bytes preserved exactly.
    const output = readFileSync(join(outputRoot, "mod.ts"), "utf8");
    expect(output).toContain('import * as os from "os";');
    expect(output).not.toContain("getcwd: () => 42");
  }, 120000);

  it("rejects a candidate that regresses a previously passing S5 stage", async () => {
    const sourceRoot = writeProject("regress", {
      "mod.py": BROKEN_RUNTIME,
      "tests/test_mod.py": RUNTIME_TEST,
    });
    const outputRoot = join(workspace, "regress-out");
    const result = await runProject(
      await optionsFor(
        sourceRoot,
        outputRoot,
        scriptedProposer((request) => proposal(request, fixAndBreakBehaviorDiff(request))),
      ),
    );
    expect(result.repair!.acceptedUnits).toEqual([]);
    expect(result.repair!.attempts[0]!.decision).toBe("rejected");
    expect(result.repair!.attempts[0]!.reason ?? "").toMatch(
      /regressed S5-tests|required behavioral stage/,
    );
    expect(readFileSync(join(outputRoot, "mod.ts"), "utf8")).toContain("missing_function");
  }, 120000);

  it("refuses repair when mandatory behavioral validation cannot run (S5/S6 skipped)", async () => {
    const sourceRoot = writeProject("inconclusive", {
      "mod.py": BROKEN_RUNTIME,
      "tests/test_mod.py": RUNTIME_TEST,
    });
    const outputRoot = join(workspace, "inconclusive-out");
    const result = await runProject(
      await optionsFor(
        sourceRoot,
        outputRoot,
        scriptedProposer((request) => proposal(request, removeMissingCallDiff(request))),
        { runTests: false },
      ),
    );
    expect(result.repair!.stopReason).toBe("validation-unavailable");
    expect(result.repair!.attempts).toEqual([]);
    expect(result.pipeline.report.claimLevel).toBe(1);
    expect(readFileSync(join(outputRoot, "mod.ts"), "utf8")).toContain("missing_function");
  }, 120000);

  it("fails closed when strict infrastructure cannot validate (no host fallback)", async () => {
    const sourceRoot = writeProject("infra", {
      "mod.py": BROKEN_RUNTIME,
      "tests/test_mod.py": RUNTIME_TEST,
    });
    const outputRoot = join(workspace, "infra-out");
    const fakeRuntimeDir = mkdtempSync(join(tmpdir(), "ctrans-fake-runtime-"));
    const fakeRuntime = join(fakeRuntimeDir, "docker");
    writeFileSync(
      fakeRuntime,
      '#!/bin/sh\nif [ "$1" = "rm" ]; then exit 0; fi\nexit 125\n',
      "utf8",
    );
    chmodSync(fakeRuntime, 0o755);
    try {
      await expect(
        runProject(
          await optionsFor(
            sourceRoot,
            outputRoot,
            scriptedProposer((request) => proposal(request, removeMissingCallDiff(request))),
            {
              strict: true,
              container: { runtime: "docker", runtimePath: fakeRuntime, image: "ctrans/test:1" },
            },
          ),
        ),
      ).rejects.toThrow(/strict validation could not run/);
      // The host fallback did not run and no unvalidated project was written.
      expect(existsSync(join(outputRoot, "mod.ts"))).toBe(false);
    } finally {
      rmSync(fakeRuntimeDir, { recursive: true, force: true });
    }
  }, 120000);

  it("stops at the cap and leaves a valid, unchanged project", async () => {
    const sourceRoot = writeProject("cap", {
      "mod.py": BROKEN_RUNTIME,
      "tests/test_mod.py": RUNTIME_TEST,
    });
    const outputRoot = join(workspace, "cap-out");
    const result = await runProject(
      await optionsFor(
        sourceRoot,
        outputRoot,
        scriptedProposer((request) => proposal(request, prependCommentDiff())),
      ),
    );
    expect(result.repair!.stopReason).toBe("attempts-exhausted");
    expect(result.repair!.attempts.length).toBe(1);
    expect(result.repair!.attempts[0]!.decision).toBe("rejected");
    expect(readFileSync(join(outputRoot, "mod.ts"), "utf8")).toContain("missing_function");
    expect(result.pipeline.report.claimLevel).toBe(1);
  }, 120000);

  it("keeps report and journal consistent across a rejected then accepted run", async () => {
    const sourceRoot = writeProject("history", {
      "mod.py": BROKEN_RUNTIME,
      "tests/test_mod.py": RUNTIME_TEST,
    });
    const outputRoot = join(workspace, "history-out");
    await runProject(
      await optionsFor(
        sourceRoot,
        outputRoot,
        scriptedProposer((request) => proposal(request, prependCommentDiff())),
      ),
    );
    const accepted = await runProject(
      await optionsFor(
        sourceRoot,
        outputRoot,
        scriptedProposer((request) => proposal(request, removeMissingCallDiff(request))),
      ),
    );
    expect(accepted.repair!.stopReason).toBe("success");
    const journal = RepairJournal.load(outputRoot);
    expect(journal.runs.length).toBe(2);
    expect(journal.runs[0]!.stopReason).toBe("attempts-exhausted");
    expect(journal.runs[0]!.filesChanged).toEqual([]);
    expect(journal.runs[1]!.stopReason).toBe("success");
    expect(journal.runs[1]!.filesChanged).toEqual(["mod.ts"]);
    const report = JSON.parse(readFileSync(join(outputRoot, ".ctrans", "report.json"), "utf8")) as {
      claimLevel: number;
      validationStages: { stage: string; status: string }[];
    };
    expect(report.claimLevel).toBe(5);
    expect(report.validationStages.find((stage) => stage.stage === "S5-tests")!.status).toBe(
      "pass",
    );
    expect(existsSync(join(outputRoot, ".ctrans", "test-results.json"))).toBe(true);
    expect(existsSync(join(outputRoot, ".ctrans", "differential.json"))).toBe(true);
  }, 180000);

  it("CLI project --repair without AI degrades to repair-unavailable and keeps output", async () => {
    const sourceRoot = writeProject("cli-noai", {
      "mod.py": BROKEN_RUNTIME,
      "tests/test_mod.py": RUNTIME_TEST,
    });
    const out = join(workspace, "cli-noai-out");
    const result = await runCliCommand([
      "project",
      sourceRoot,
      "--to",
      "ts",
      "-o",
      out,
      "--repair",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("repair: repair-unavailable");
    expect(readFileSync(join(out, "mod.ts"), "utf8")).toContain("missing_function");
    const journal = RepairJournal.load(out);
    expect(journal.runs[0]!.stopReason).toBe("repair-unavailable");
    expect(journal.runs[0]!.attempts[0]!.proposalOutcome).toBe("ai-disabled");
  }, 120000);

  it("CLI project --repair fails closed when behavioral validation was skipped", async () => {
    const sourceRoot = writeProject("cli-inconclusive", {
      "mod.py": BROKEN_RUNTIME,
      "tests/test_mod.py": RUNTIME_TEST,
    });
    const out = join(workspace, "cli-inconclusive-out");
    const result = await runCliCommand([
      "project",
      sourceRoot,
      "--to",
      "ts",
      "-o",
      out,
      "--no-tests",
      "--repair",
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("repair: validation-unavailable");
    const journal = RepairJournal.load(out);
    expect(journal.runs[0]!.stopReason).toBe("validation-unavailable");
    expect(readFileSync(join(out, "mod.ts"), "utf8")).toContain("missing_function");
  }, 120000);
});
