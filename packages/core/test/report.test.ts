import { describe, expect, it } from "vitest";

import { ReportValidationError, validateTranslationReport } from "../src/report.js";

const goodReport = {
  generator: { name: "code-translator", version: "0.0.0" },
  sourceLanguage: "python",
  targetLanguage: "typescript",
  files: [
    {
      source: "src/api.py",
      target: "src/api.ts",
      status: "translated",
      decisionCounts: { deterministic: 40, semantic: 3, ambiguous: 1, unsupported: 0 },
    },
  ],
  decisionTotals: { deterministic: 40, semantic: 3, ambiguous: 1, unsupported: 0 },
  warnings: ["CTW-NUM-INT-ARBITRARY-PRECISION"],
  unsupported: [],
  ambiguous: [],
  validationStages: [
    { stage: "S1-syntax", status: "pass", reason: null },
    { stage: "S5-tests", status: "skipped", reason: "no tests in source project" },
  ],
  claimLevel: 2,
  repairJournal: null,
};

describe("translation report schema", () => {
  it("accepts a well-formed report and round-trips through JSON", () => {
    const report = validateTranslationReport(goodReport);
    expect(report.claimLevel).toBe(2);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("rejects invalid claim levels, statuses, and decision counts", () => {
    expect(() => validateTranslationReport({ ...goodReport, claimLevel: 6 })).toThrow(
      ReportValidationError,
    );
    expect(() =>
      validateTranslationReport({
        ...goodReport,
        files: [{ ...goodReport.files[0]!, status: "almost-fine" }],
      }),
    ).toThrow(ReportValidationError);
    expect(() =>
      validateTranslationReport({
        ...goodReport,
        decisionTotals: { ...goodReport.decisionTotals, ambiguous: -1 },
      }),
    ).toThrow(ReportValidationError);
    expect(() => validateTranslationReport({ ...goodReport, generator: { name: "x" } })).toThrow(
      ReportValidationError,
    );
  });
});
