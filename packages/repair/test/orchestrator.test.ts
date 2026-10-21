// Bounded repair loop (M9 WS C/D): central caps, state-hash loop detection,
// monotone acceptance, and exact rollback (the baseline map is never mutated).
import { describe, expect, it } from "vitest";

import {
  MAX_ATTEMPTS_PER_RUN,
  MAX_ATTEMPTS_PER_UNIT,
  DisabledRepairProposer,
  acceptance,
  runRepairLoop,
  stateHash,
  type RepairLoopInput,
  type RepairProposer,
} from "../src/index.js";
import {
  MARKER_TEXT,
  ScriptedProposer,
  ledgerEntry,
  markerDiff,
  nonPatchProposal,
  patchProposal,
  stageResult,
  twoStage,
} from "./helpers.js";

const SOURCE = "def value():\n    return 1\n";

function input(overrides: Partial<RepairLoopInput> = {}): RepairLoopInput {
  return {
    files: new Map([["calc.ts", MARKER_TEXT]]),
    units: [{ unit: "calc.py", targetPath: "calc.ts", sourceText: SOURCE }],
    stages: twoStage("fail", "pass", ["calc.ts: Unexpected token"]),
    ...overrides,
  };
}

function acceptedValidate() {
  return async (files: ReadonlyMap<string, string>) =>
    files.get("calc.ts")!.includes("attempt marker fixed")
      ? twoStage("pass", "pass")
      : twoStage("fail", "pass");
}

describe("runRepairLoop: eligibility", () => {
  it("reports no-failures without proposing anything", async () => {
    const proposer = new ScriptedProposer(() => nonPatchProposal("declined", "unused"));
    const result = await runRepairLoop(input({ stages: twoStage("pass", "pass") }), {
      proposer,
      validate: acceptedValidate(),
    });
    expect(result.stopReason).toBe("no-failures");
    expect(proposer.requests).toEqual([]);
    expect(result.attempts).toEqual([]);
  });

  it("refuses infrastructure failures (never treats them as source defects)", async () => {
    const proposer = new ScriptedProposer(() => nonPatchProposal("declined", "unused"));
    const result = await runRepairLoop(
      input({
        stages: [stageResult("S1-syntax", "fail", "sandbox timeout while validating")],
      }),
      { proposer, validate: acceptedValidate() },
    );
    expect(result.stopReason).toBe("no-eligible-failures");
    expect(proposer.requests).toEqual([]);
    expect(result.attempts).toEqual([]);
  });

  it("refuses unsupported ledger evidence", async () => {
    const proposer = new ScriptedProposer(() => nonPatchProposal("declined", "unused"));
    const result = await runRepairLoop(
      input({
        stages: twoStage("pass", "pass"),
        ledger: [ledgerEntry({ decision: "unsupported" })],
      }),
      { proposer, validate: acceptedValidate() },
    );
    expect(result.stopReason).toBe("no-eligible-failures");
    expect(proposer.requests).toEqual([]);
  });

  it("never guesses attribution for details that name another file", async () => {
    const proposer = new ScriptedProposer(() => nonPatchProposal("declined", "unused"));
    const result = await runRepairLoop(
      input({ stages: twoStage("fail", "pass", ["other.ts: Unexpected token"]) }),
      { proposer, validate: acceptedValidate() },
    );
    expect(result.stopReason).toBe("no-eligible-failures");
    expect(proposer.requests).toEqual([]);
  });

  it("never exposes test modules to the model", async () => {
    const proposer = new ScriptedProposer(() => nonPatchProposal("declined", "unused"));
    const result = await runRepairLoop(
      input({
        files: new Map([["test_calc.ts", MARKER_TEXT]]),
        units: [
          { unit: "test_calc.py", targetPath: "test_calc.ts", sourceText: "def test_x(): pass\n" },
        ],
        stages: twoStage("fail", "pass", ["test_calc.ts: Unexpected token"]),
      }),
      { proposer, validate: acceptedValidate() },
    );
    expect(result.stopReason).toBe("no-eligible-failures");
    expect(proposer.requests).toEqual([]);
  });

  it("never targets generated artifacts that have no source text", async () => {
    const proposer = new ScriptedProposer(() => nonPatchProposal("declined", "unused"));
    const runtime =
      "export function __ctrans_mod(a: number, b: number): number {\n  return a;\n}\n";
    const result = await runRepairLoop(
      input({
        files: new Map([["__ctrans_runtime.ts", runtime]]),
        units: [{ unit: "__ctrans_runtime.ts", targetPath: "__ctrans_runtime.ts", sourceText: "" }],
        stages: twoStage("fail", "pass", ["__ctrans_runtime.ts: type error"]),
      }),
      { proposer, validate: acceptedValidate() },
    );
    expect(result.stopReason).toBe("no-eligible-failures");
    expect(proposer.requests).toEqual([]);
  });

  it("rejects a scripted patch that tries to suppress validation", async () => {
    let validations = 0;
    const proposer = new ScriptedProposer((request) =>
      patchProposal(
        request,
        [
          "@@ -1,2 +1,3 @@",
          "+// @ts-ignore",
          " // attempt marker",
          " export const value = 1;",
          "",
        ].join("\n"),
      ),
    );
    const result = await runRepairLoop(input(), {
      proposer,
      validate: async () => {
        validations += 1;
        return twoStage("pass", "pass");
      },
    });
    expect(result.attempts[0]!.decision).toBe("rejected");
    expect(result.attempts[0]!.reason).toContain("forbidden construct");
    expect(validations).toBe(0);
    expect(result.files.get("calc.ts")).toBe(MARKER_TEXT);
  });
});

describe("acceptance: monotone claim ladder", () => {
  it("accepts a strictly higher claim level with no passing stage regressed", () => {
    const verdict = acceptance(twoStage("pass", "fail"), twoStage("pass", "pass"));
    expect(verdict.accept).toBe(true);
    expect(verdict.reason).toContain("claim level improved");
  });

  it("rejects an equal claim level (no demonstrated improvement)", () => {
    const verdict = acceptance(twoStage("pass", "fail"), twoStage("pass", "fail"));
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("no demonstrated improvement");
  });

  it("rejects any candidate that regresses a previously passing stage", () => {
    const verdict = acceptance(twoStage("pass", "fail"), twoStage("fail", "pass"));
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("regressed S1-syntax");
  });

  it("never treats skipped as passed, and rejects pass→skipped", () => {
    const skippedCandidate = [
      stageResult("S1-syntax", "pass"),
      stageResult("S2-types", "skipped", "type checker unavailable"),
    ];
    const baseline = twoStage("pass", "pass");
    const verdict = acceptance(baseline, skippedCandidate);
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("regressed S2-types from pass to skipped");

    const skippedBaseline = [
      stageResult("S1-syntax", "skipped", "not wired"),
      stageResult("S2-types", "pass"),
    ];
    const equalSkipped = acceptance(skippedBaseline, skippedBaseline);
    expect(equalSkipped.accept).toBe(false);
  });

  it("rejects a candidate that omits a previously passing stage", () => {
    const verdict = acceptance(twoStage("pass", "pass"), twoStage("pass", "pass").slice(0, 1));
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("omitted previously passing stage S2-types");
  });
});

describe("runRepairLoop: application, acceptance, and rollback", () => {
  it("accepts a patch that demonstrably improves validation and commits it", async () => {
    const files = new Map([["calc.ts", MARKER_TEXT]]);
    const proposer = new ScriptedProposer((request) => patchProposal(request, markerDiff("fixed")));
    const result = await runRepairLoop(input({ files }), {
      proposer,
      validate: acceptedValidate(),
    });
    expect(result.stopReason).toBe("success");
    expect(result.acceptedUnits).toEqual(["calc.py"]);
    expect(result.files.get("calc.ts")).toContain("// attempt marker fixed");
    expect(result.finalStateHash).not.toBe(result.baselineStateHash);
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0]!.decision).toBe("accepted");
    expect(result.attempts[0]!.candidateStateHash).not.toBeNull();
    // The caller's map is never mutated (the baseline stays exact).
    expect(files.get("calc.ts")).toBe(MARKER_TEXT);
  });

  it("reverts a patch that breaks a previously passing S5 stage (roadmap M9 scenario)", async () => {
    const files = new Map([["calc.ts", MARKER_TEXT]]);
    const baselineHash = stateHash(files);
    const baseline = [
      stageResult("S1-syntax", "fail", "syntax error", ["calc.ts: bad token"]),
      stageResult("S2-types", "pass"),
      stageResult("S3-dependencies", "pass"),
      stageResult("S5-tests", "pass"),
    ];
    const proposer = new ScriptedProposer((request) =>
      patchProposal(request, markerDiff("breaksTests")),
    );
    let validations = 0;
    const result = await runRepairLoop(input({ files, stages: baseline }), {
      proposer,
      validate: async () => {
        validations += 1;
        return [
          stageResult("S1-syntax", "pass"),
          stageResult("S2-types", "pass"),
          stageResult("S3-dependencies", "pass"),
          stageResult("S5-tests", "fail", "2 translated tests failed", ["calc.ts: test_x"]),
        ];
      },
    });
    expect(validations).toBe(1);
    expect(result.acceptedUnits).toEqual([]);
    expect(result.stopReason).toBe("attempts-exhausted");
    expect(result.finalStateHash).toBe(baselineHash);
    expect(result.files.get("calc.ts")).toBe(MARKER_TEXT);
    expect(result.attempts[0]!.decision).toBe("rejected");
    expect(result.attempts[0]!.reason).toContain("regressed S5-tests");
  });

  it("rolls back a rejected patch exactly (same content, same state hash)", async () => {
    const files = new Map([["calc.ts", MARKER_TEXT]]);
    const baselineHash = stateHash(files);
    const proposer = new ScriptedProposer((request) =>
      patchProposal(request, markerDiff("stillBad")),
    );
    const result = await runRepairLoop(input({ files }), {
      proposer,
      validate: async () => twoStage("fail", "pass", ["calc.ts: still broken"]),
    });
    expect(result.stopReason).toBe("attempts-exhausted");
    expect(result.acceptedUnits).toEqual([]);
    expect(result.files.get("calc.ts")).toBe(MARKER_TEXT);
    expect(result.finalStateHash).toBe(baselineHash);
    expect(result.attempts.every((attempt) => attempt.decision === "rejected")).toBe(true);
    // The candidate state existed (and was hashed) but was never committed.
    expect(result.attempts.some((attempt) => attempt.candidateStateHash !== null)).toBe(true);
    expect(files.get("calc.ts")).toBe(MARKER_TEXT);
  });

  it("restores the exact baseline when validation throws", async () => {
    const files = new Map([["calc.ts", MARKER_TEXT]]);
    const baselineHash = stateHash(files);
    const proposer = new ScriptedProposer((request) =>
      patchProposal(request, markerDiff("candidate")),
    );
    const result = await runRepairLoop(input({ files }), {
      proposer,
      validate: async () => {
        throw new Error("validator process crashed");
      },
    });
    expect(result.stopReason).toBe("validation-error");
    expect(result.finalStateHash).toBe(baselineHash);
    expect(result.files.get("calc.ts")).toBe(MARKER_TEXT);
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0]!.reason).toContain("validation failed to run");
  });

  it("leaves the caller's baseline untouched when the proposer throws", async () => {
    const files = new Map([["calc.ts", MARKER_TEXT]]);
    const proposer: RepairProposer = {
      async propose() {
        throw new Error("connection lost mid-attempt");
      },
    };
    await expect(
      runRepairLoop(input({ files }), { proposer, validate: acceptedValidate() }),
    ).rejects.toThrow("connection lost");
    expect(files.get("calc.ts")).toBe(MARKER_TEXT);
    expect(stateHash(files)).toBe(stateHash(new Map([["calc.ts", MARKER_TEXT]])));
  });
});

describe("runRepairLoop: bounds", () => {
  it("stops after three attempts on one unit", async () => {
    const proposer = new ScriptedProposer((request) =>
      patchProposal(request, markerDiff(`bad-${String(request.attempt)}`)),
    );
    const result = await runRepairLoop(input(), {
      proposer,
      validate: async () => twoStage("fail", "pass", ["calc.ts: still broken"]),
    });
    expect(MAX_ATTEMPTS_PER_UNIT).toBe(3);
    expect(result.attempts.length).toBe(3);
    expect(proposer.requests.map((request) => request.attempt)).toEqual([1, 2, 3]);
    expect(result.stopReason).toBe("attempts-exhausted");
  });

  it("shares the eight-attempt run cap across multiple units", async () => {
    const files = new Map([
      ["a.ts", MARKER_TEXT],
      ["b.ts", MARKER_TEXT],
      ["c.ts", MARKER_TEXT],
    ]);
    const units = ["a", "b", "c"].map((name) => ({
      unit: `${name}.py`,
      targetPath: `${name}.ts`,
      sourceText: "def f():\n    return 1\n",
    }));
    const proposer = new ScriptedProposer((request) =>
      patchProposal(request, markerDiff(`${request.unit}-${String(request.attempt)}`)),
    );
    const result = await runRepairLoop(
      input({
        files,
        units,
        stages: twoStage("fail", "pass", ["a.ts: bad", "b.ts: bad", "c.ts: bad"]),
      }),
      {
        proposer,
        validate: async () => twoStage("fail", "pass", ["a.ts: bad", "b.ts: bad", "c.ts: bad"]),
      },
    );
    expect(MAX_ATTEMPTS_PER_RUN).toBe(8);
    expect(result.attempts.length).toBe(8);
    expect(result.stopReason).toBe("run-cap");
    expect(result.acceptedUnits).toEqual([]);
  });

  it("clamps caller-supplied caps: they may tighten but never raise the defaults", async () => {
    const proposer = new ScriptedProposer((request) =>
      patchProposal(request, markerDiff(`bad-${String(request.attempt)}`)),
    );
    const result = await runRepairLoop(input(), {
      proposer,
      validate: async () => twoStage("fail", "pass"),
      maxAttemptsPerUnit: 99,
      maxAttemptsPerRun: 99,
    });
    expect(result.attempts.length).toBe(MAX_ATTEMPTS_PER_UNIT);
  });

  it("detects a repeated candidate state and stops (loop detected)", async () => {
    const proposer = new ScriptedProposer((request) => {
      // Two DIFFERENT diff strings that produce the SAME candidate text.
      const diff = request.attempt === 1 ? markerDiff("same") : markerDiff("same", 2);
      return patchProposal(request, diff);
    });
    const result = await runRepairLoop(input(), {
      proposer,
      validate: async () => twoStage("fail", "pass", ["calc.ts: still broken"]),
    });
    expect(result.stopReason).toBe("loop-detected");
    expect(result.attempts.length).toBe(2);
    expect(result.attempts[1]!.reason).toContain("loop detected");
    expect(result.files.get("calc.ts")).toBe(MARKER_TEXT);
  });

  it("rejects duplicate identical patches without re-validating", async () => {
    let validations = 0;
    const proposer = new ScriptedProposer((request) => patchProposal(request, markerDiff("same")));
    const result = await runRepairLoop(input(), {
      proposer,
      validate: async () => {
        validations += 1;
        return twoStage("fail", "pass");
      },
    });
    expect(result.attempts.map((attempt) => attempt.reason)).toContain(
      "duplicate patch (same diff already attempted)",
    );
    expect(validations).toBe(1);
  });
});

describe("runRepairLoop: typed non-patch outcomes", () => {
  it("reports an AI-disabled run without any model activity", async () => {
    const result = await runRepairLoop(input(), {
      proposer: new DisabledRepairProposer(),
      validate: acceptedValidate(),
    });
    expect(result.stopReason).toBe("repair-unavailable");
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0]!.proposalOutcome).toBe("ai-disabled");
    expect(result.attempts[0]!.decision).toBe("no-repair");
    expect(result.files.get("calc.ts")).toBe(MARKER_TEXT);
  });

  it("records a model decline explicitly and stops cleanly", async () => {
    const proposer = new ScriptedProposer(() =>
      nonPatchProposal("declined", "model declined: no safe minimal fix"),
    );
    const result = await runRepairLoop(input(), { proposer, validate: acceptedValidate() });
    expect(result.stopReason).toBe("declined");
    expect(result.attempts[0]!.proposalOutcome).toBe("declined");
    expect(result.attempts[0]!.decision).toBe("no-repair");
  });

  it("stops loudly when the secret gate blocks a proposal", async () => {
    const proposer = new ScriptedProposer(() =>
      nonPatchProposal("blocked-secret", "1 potential secret(s) detected", ["secretlint/x"]),
    );
    const result = await runRepairLoop(input(), { proposer, validate: acceptedValidate() });
    expect(result.stopReason).toBe("repair-unavailable");
    expect(result.attempts[0]!.decision).toBe("rejected");
    expect(result.attempts[0]!.secretRuleIds).toEqual(["secretlint/x"]);
  });

  it("degrades a provider error to the deterministic fallback", async () => {
    const proposer = new ScriptedProposer(() =>
      nonPatchProposal("provider-error", "AI-HTTP-ERROR: 503"),
    );
    const result = await runRepairLoop(input(), { proposer, validate: acceptedValidate() });
    expect(result.stopReason).toBe("repair-unavailable");
    expect(result.attempts[0]!.proposalOutcome).toBe("provider-error");
    expect(result.files.get("calc.ts")).toBe(MARKER_TEXT);
  });
});
