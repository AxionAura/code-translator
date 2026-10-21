// Unified-diff grammar + application (M9 WS B). Patches are untrusted: only the
// documented grammar is accepted, file headers may only name the scoped target,
// and old lines must match the baseline CONTENT exactly.
import { describe, expect, it } from "vitest";

import { applyUnifiedDiff, parseUnifiedDiff, validatePatchPolicy } from "../src/index.js";
import { EMITTED_TEXT, FIX_DIFF } from "./helpers.js";

const scope = { unit: "calc.py", targetPath: "calc.ts" };

describe("parseUnifiedDiff", () => {
  it("accepts a file-header diff that names the scoped target (a/ b/ prefixes)", () => {
    const diff = `--- a/calc.ts\t2026-01-01\n+++ b/calc.ts\t2026-01-02\n${FIX_DIFF}`;
    const parsed = parseUnifiedDiff(diff, scope);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.hunks.length).toBe(1);
  });

  it("rejects headers that target another file", () => {
    const diff = `--- a/other.ts\n+++ b/other.ts\n${FIX_DIFF}`;
    const parsed = parseUnifiedDiff(diff, scope);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("another file");
  });

  it("rejects a missing +++ header", () => {
    const parsed = parseUnifiedDiff(`--- a/calc.ts\n${FIX_DIFF}`, scope);
    expect(parsed.ok).toBe(false);
  });

  it("rejects binary patches and git metadata operations", () => {
    for (const diff of [
      `Binary files a/calc.ts and b/calc.ts differ`,
      `new file mode 100644\n${FIX_DIFF}`,
      `deleted file mode 100644\n${FIX_DIFF}`,
      `rename from calc.ts\nrename to gone.ts\n${FIX_DIFF}`,
    ]) {
      const parsed = parseUnifiedDiff(diff, scope);
      expect(parsed.ok).toBe(false);
    }
  });

  it("rejects combined diffs, missing hunk prefixes, and wrong old-line counts", () => {
    expect(parseUnifiedDiff(`diff --cc calc.ts\n${FIX_DIFF}`, scope).ok).toBe(false);
    expect(parseUnifiedDiff("@@ -1,1 +1,1 @@\nnot prefixed", scope).ok).toBe(false);
    const wrongCount = "@@ -1,5 +1,5 @@\n-  return a + ;\n+  return a + b;\n";
    const parsed = parseUnifiedDiff(wrongCount, scope);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("declares 5 old lines");
  });

  it("rejects a patch without hunk headers", () => {
    const parsed = parseUnifiedDiff("", scope);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("no hunks");
    const prose = parseUnifiedDiff("just prose\n", scope);
    expect(prose.ok).toBe(false);
    if (!prose.ok) expect(prose.reason).toContain("unsupported patch line");
  });
});

describe("validatePatchPolicy", () => {
  function addLine(line: string): string {
    return [
      "@@ -1,1 +1,2 @@",
      `+${line}`,
      " export function add(a: number, b: number): number {",
      "",
    ].join("\n");
  }

  it("accepts ordinary fixes", () => {
    expect(validatePatchPolicy(FIX_DIFF, scope)).toEqual({ ok: true });
  });

  it("rejects validation/lint/test weakening on added lines", () => {
    for (const line of [
      "// @ts-nocheck",
      "// @ts-ignore",
      "// @ts-expect-error",
      'declare module "pathlib";',
      "declare global { interface Window { x: unknown } }",
      "/* eslint-disable */",
      "// istanbul ignore next",
      "test.skip('x', () => {});",
      "it.only('x', () => {});",
    ]) {
      const verdict = validatePatchPolicy(addLine(line), scope);
      expect(verdict.ok, line).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain("forbidden construct");
    }
  });

  it("still rejects diffs that do not parse", () => {
    expect(validatePatchPolicy("not a diff", scope).ok).toBe(false);
  });
});

describe("applyUnifiedDiff", () => {
  it("applies a clean hunk", () => {
    const result = applyUnifiedDiff(EMITTED_TEXT, FIX_DIFF, scope);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("return a + b;");
      expect(result.text).not.toContain("return a + ;");
      expect(result.text.endsWith("\n")).toBe(true);
    }
  });

  it("is content-exact: mismatched context is rejected, never fuzzily applied", () => {
    const wrongContext = FIX_DIFF.replace(
      " export function add(a: number, b: number): number {",
      " export function subtract(a: number, b: number): number {",
    );
    const result = applyUnifiedDiff(EMITTED_TEXT, wrongContext, scope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("does not match");
  });

  it("tolerates line-number drift (patch(1) semantics) but not wrong content", () => {
    const drifted = FIX_DIFF.replace("@@ -1,3 +1,3 @@", "@@ -40,3 +40,3 @@");
    const result = applyUnifiedDiff(EMITTED_TEXT, drifted, scope);
    expect(result.ok).toBe(true);
  });

  it("applies multiple hunks in order and preserves untouched lines", () => {
    const base = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
    const diff = [
      "@@ -1,2 +1,2 @@",
      " alpha",
      "-beta",
      "+BETA",
      "@@ -4,2 +4,2 @@",
      " delta",
      "-epsilon",
      "+EPSILON",
      "",
    ].join("\n");
    const result = applyUnifiedDiff(base, diff, scope);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe("alpha\nBETA\ngamma\ndelta\nEPSILON\n");
  });

  it("supports pure insertions and pure deletions", () => {
    const insertion = "@@ -1,1 +1,2 @@\n alpha\n+inserted\n";
    const inserted = applyUnifiedDiff("alpha\nbeta\n", insertion, scope);
    expect(inserted.ok).toBe(true);
    if (inserted.ok) expect(inserted.text).toBe("alpha\ninserted\nbeta\n");

    const deletion = "@@ -1,2 +1,1 @@\n alpha\n-beta\n";
    const deleted = applyUnifiedDiff("alpha\nbeta\ngamma\n", deletion, scope);
    expect(deleted.ok).toBe(true);
    if (deleted.ok) expect(deleted.text).toBe("alpha\ngamma\n");
  });
});
