// Failure classification (roadmap M9 item 1/2): every stage code maps to its
// documented category; infrastructure evidence never masquerades as a source
// defect; skipped stages are inconclusive, not failures; unsupported constructs
// are never repairable.
import { describe, expect, it } from "vitest";

import type { LedgerEntry, StageResult } from "@axion-ct/core";

import {
  admittedForRepair,
  classifyFailures,
  failureDetailsForTarget,
  inconclusiveStages,
  isInfrastructureEvidence,
} from "../src/index.js";

function stage(
  name: StageResult["stage"],
  status: StageResult["status"],
  reason: string | null = null,
  details: readonly string[] = [],
): StageResult {
  return { stage: name, status, reason, details };
}

function ledgerEntry(decision: LedgerEntry["decision"], unit: string, rule: string): LedgerEntry {
  return {
    id: `${unit}#001`,
    unit,
    span: null,
    sourceKind: "py.Example",
    rule,
    decision,
    rationale: "test entry",
    adaptation: null,
    targetSummary: null,
    warnings: [],
    escalation: null,
  };
}

describe("classifyFailures", () => {
  it("maps every stage failure to its validation.md §8 code and category", () => {
    const cases = [
      ["S1-syntax", "V-S1-PARSE", "syntax"],
      ["S2-types", "V-S2-TYPE", "type"],
      ["S3-dependencies", "V-S3-IMPORT", "dependencies"],
      ["S4-build", "V-S4-BUILD", "build"],
      ["S5-tests", "V-S5-TEST", "tests"],
      ["S6-differential", "V-S6-DIVERGE", "differential"],
    ] as const;
    for (const [stageName, code, category] of cases) {
      const [failure] = classifyFailures([stage(stageName, "fail", "failure", [`mod.ts: bad`])]);
      expect(failure?.code).toBe(code);
      expect(failure?.category).toBe(category);
      expect(failure?.stage).toBe(stageName);
      expect(failure?.repairable).toBe(true);
    }
  });

  it("never classifies skipped/pass/warn stages as failures", () => {
    const failures = classifyFailures([
      stage("S1-syntax", "pass"),
      stage("S2-types", "skipped", "no type validator wired"),
      stage("S3-dependencies", "warn", "one external"),
    ]);
    expect(failures).toEqual([]);
    expect(inconclusiveStages([stage("S2-types", "skipped", "no validator")]).length).toBe(1);
  });

  it("classifies timeout/spawn/isolation evidence as non-repairable infrastructure", () => {
    const failures = classifyFailures([
      stage("S5-tests", "fail", "vitest run exceeded 120000ms (sandbox timeout)"),
      stage("S2-types", "fail", "pyright failed to spawn (ENOENT)"),
    ]);
    expect(failures.length).toBe(2);
    for (const failure of failures) {
      expect(failure.category).toBe("infrastructure");
      expect(failure.repairable).toBe(false);
      expect(admittedForRepair(failure)).toBe(false);
    }
    expect(failures[0]!.code).toBe("V-S5-INFRA");
  });

  it("detects infrastructure evidence textually", () => {
    expect(isInfrastructureEvidence("sandboxed execution refused")).toBe(true);
    expect(isInfrastructureEvidence("bwrap unavailable")).toBe(true);
    expect(isInfrastructureEvidence("2 type errors")).toBe(false);
    expect(isInfrastructureEvidence(null)).toBe(false);
  });

  it("unsupported ledger entries are failures but never repairable", () => {
    const failures = classifyFailures(
      [stage("S1-syntax", "pass")],
      [ledgerEntry("unsupported", "mod.py", "py.Match→unsupported")],
    );
    expect(failures.length).toBe(1);
    expect(failures[0]!.code).toBe("V-UNSUPPORTED");
    expect(failures[0]!.repairable).toBe(false);
    expect(failures[0]!.details[0]).toContain("py.Match→unsupported");
  });

  it("attributes details only by exact target-path prefix (never guesses)", () => {
    const [failure] = classifyFailures([
      stage("S2-types", "fail", "1 type error", ["src/mod.ts: bad assign", "other.ts: unrelated"]),
    ]);
    expect(failureDetailsForTarget(failure!, "src/mod.ts")).toEqual(["src/mod.ts: bad assign"]);
    expect(failureDetailsForTarget(failure!, "mod.ts")).toEqual([]);
  });
});
