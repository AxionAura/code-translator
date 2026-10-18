import { describe, expect, it } from "vitest";

import { TypeScriptSemanticOracle } from "../src/ts-oracle.js";

const oracle = new TypeScriptSemanticOracle();

const SOURCE = [
  "export interface Shape { area(): number }",
  "export type Label = 'small' | 'large';",
  "export const answer: number = 42;",
  "export function double(n: number): number { return n * 2; }",
  "const broken: string = 42;",
  "",
].join("\n");

const FILES = [{ filename: "mod.ts", source: SOURCE }];

describe("TypeScript 6 semantic oracle", () => {
  it("summarizes the module export surface with kinds, flags, and types", () => {
    const summary = oracle.summarizeModule({ files: FILES, filename: "mod.ts" });
    const byName = new Map(summary.exports.map((entry) => [entry.name, entry]));
    expect(byName.get("Shape")?.exportKind).toBe("type");
    expect(byName.get("Label")?.exportKind).toBe("type");
    expect(byName.get("answer")?.exportKind).toBe("value");
    expect(byName.get("double")?.exportKind).toBe("value");
    expect(byName.get("double")?.type?.display).toBe("(n: number) => number");
    expect(byName.get("Shape")?.symbolFlags).toContain("Interface");
    // Declaration spans land on the answer line and reproduce the declared name.
    const answerSpan = byName.get("answer")?.declarations[0];
    expect(answerSpan).toBeDefined();
    const answerSlice = Buffer.from(SOURCE, "utf8")
      .subarray(answerSpan!.startByteOffset, answerSpan!.endByteOffset)
      .toString("utf8");
    expect(answerSlice).toContain("answer");
    expect(answerSpan!.startByteOffset).toBeGreaterThanOrEqual(
      SOURCE.indexOf("export const answer"),
    );
  });

  it("reports semantic diagnostics with contract spans", () => {
    const summary = oracle.summarizeModule({ files: FILES, filename: "mod.ts" });
    const typeError = summary.diagnostics.find(
      (entry) => entry.code === 2322, // Type 'number' is not assignable to type 'string'
    );
    expect(typeError).toBeDefined();
    expect(typeError?.severity).toBe("error");
    expect(typeError?.span).not.toBeNull();
    // The compiler anchors the error inside the offending statement (at the declarator).
    const statementStart = SOURCE.indexOf("const broken");
    const statementEnd = SOURCE.indexOf(";", statementStart);
    expect(typeError!.span!.startByteOffset).toBeGreaterThanOrEqual(statementStart);
    expect(typeError!.span!.endByteOffset).toBeLessThanOrEqual(statementEnd);
  });

  it("answers type-at-position queries through byte offsets", () => {
    const singleLine = "export const answer: number = 42;\n";
    const typeAt = oracle.typeAt({
      files: [{ filename: "mod.ts", source: singleLine }],
      filename: "mod.ts",
      byteOffset: Buffer.byteLength("export const answer: ", "utf8"),
    });
    expect(typeAt?.display).toBe("number");
    expect(typeAt?.flags).toContain("Number");

    const atFunction = oracle.typeAt({
      files: FILES,
      filename: "mod.ts",
      byteOffset: SOURCE.indexOf("double(n"),
    });
    expect(atFunction?.display).toContain("(n: number)");
  }, 30000);

  it("returns null types gracefully for positions without content", () => {
    const typeAt = oracle.typeAt({
      files: [{ filename: "mod.ts", source: "const x = 1;\n" }],
      filename: "mod.ts",
      byteOffset: 0, // keyword start - no value type
    });
    // Either a type or null is acceptable; it must never throw for in-bounds offsets.
    expect(typeAt === null || typeof typeAt.display === "string").toBe(true);
  });

  it("works for JavaScript inputs too (allowJs)", () => {
    const summary = oracle.summarizeModule({
      files: [{ filename: "plain.js", source: "export const size = 10;\n" }],
      filename: "plain.js",
    });
    const size = summary.exports.find((entry) => entry.name === "size");
    expect(size?.type?.display).toBe("10");
  });
});
