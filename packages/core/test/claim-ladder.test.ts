// Claim-ladder pure-function tests (docs/validation.md §2; roadmap M10): each
// level requires every lower stage to genuinely pass. Skipped is inconclusive;
// S4 only blocks when it actually ran and failed; S7 is outside the ladder.
import { describe, expect, it } from "vitest";

import { computeClaimLevel, type StageResult, type ValidationStageName } from "../src/index.js";

function stage(
  name: ValidationStageName,
  status: StageResult["status"],
  reason: string | null = null,
): StageResult {
  return { stage: name, status, reason, details: [] };
}

function ladder(
  overrides: Partial<Record<ValidationStageName, StageResult["status"]>>,
): StageResult[] {
  const order: ValidationStageName[] = [
    "S1-syntax",
    "S2-types",
    "S3-dependencies",
    "S4-build",
    "S5-tests",
    "S6-differential",
    "S7-smoke",
  ];
  return order.map((name) => stage(name, overrides[name] ?? "pass"));
}

describe("computeClaimLevel boundaries", () => {
  it("awards levels only when every lower stage passes", () => {
    expect(computeClaimLevel([])).toBe(0);
    expect(computeClaimLevel([stage("S1-syntax", "pass")])).toBe(1);
    expect(computeClaimLevel([stage("S1-syntax", "pass"), stage("S2-types", "pass")])).toBe(2);
    expect(
      computeClaimLevel([
        stage("S1-syntax", "pass"),
        stage("S2-types", "pass"),
        stage("S3-dependencies", "pass"),
      ]),
    ).toBe(3);
    expect(computeClaimLevel(ladder({}))).toBe(5);
  });

  it("skipped never counts as pass at any level", () => {
    expect(computeClaimLevel(ladder({ "S1-syntax": "skipped" }))).toBe(0);
    expect(computeClaimLevel(ladder({ "S2-types": "skipped" }))).toBe(1);
    expect(computeClaimLevel(ladder({ "S3-dependencies": "skipped" }))).toBe(2);
    expect(computeClaimLevel(ladder({ "S5-tests": "skipped" }))).toBe(3);
    expect(computeClaimLevel(ladder({ "S6-differential": "skipped" }))).toBe(4);
  });

  it("warn does not count as pass", () => {
    expect(computeClaimLevel(ladder({ "S3-dependencies": "warn" }))).toBe(2);
    expect(computeClaimLevel(ladder({ "S5-tests": "warn" }))).toBe(3);
    expect(computeClaimLevel(ladder({ "S6-differential": "warn" }))).toBe(4);
  });

  it("an EXECUTED S4 failure caps the claim at 3 but a skipped S4 does not block", () => {
    expect(computeClaimLevel(ladder({ "S4-build": "fail" }))).toBe(3);
    expect(computeClaimLevel(ladder({ "S4-build": "skipped" }))).toBe(5);
    expect(computeClaimLevel(ladder({ "S4-build": "warn" }))).toBe(5);
    // S4 cannot matter when a lower stage already caps the claim.
    expect(computeClaimLevel(ladder({ "S2-types": "fail", "S4-build": "fail" }))).toBe(1);
  });

  it("S7 smoke is outside the ladder (reported, never inflating)", () => {
    expect(computeClaimLevel(ladder({ "S7-smoke": "fail" }))).toBe(5);
    expect(computeClaimLevel(ladder({ "S7-smoke": "skipped" }))).toBe(5);
  });
});
