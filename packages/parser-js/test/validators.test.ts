// Validator + safety internals: S1/S2 verdicts must be structured and honest
// (fail/skip reasons are surfaced in reports), and the depth-measurement helpers are
// the D-020 containment machinery.
import { describe, expect, it } from "vitest";

import { maxAstDepth, maxBracketDepth, MAX_SAFE_NESTING_DEPTH } from "../src/safety.js";
import { createOxcSyntaxValidator, OracleTypeValidator } from "../src/validators.js";
import type { AstNode } from "@ctrans/core";

describe("S1 syntax validator", () => {
  it("passes clean files and files with supported helper output", async () => {
    const validator = await createOxcSyntaxValidator();
    const result = await validator.validate([
      {
        path: "a.ts",
        content: "export function f(a: number): number {\n  return a;\n}\n",
        language: "typescript",
      },
      { path: "b.js", content: "export function g(x) {\n  return x;\n}\n", language: "javascript" },
    ]);
    expect(result.status).toBe("pass");
  });

  it("fails with per-file detail on syntax errors", async () => {
    const validator = await createOxcSyntaxValidator();
    const result = await validator.validate([
      { path: "bad.ts", content: "function {{{{\n", language: "typescript" },
    ]);
    expect(result.status).toBe("fail");
    expect(result.details.join("\n")).toContain("bad.ts");
  });
});

describe("S2 type validator (oracle-backed)", () => {
  it("passes well-typed files", async () => {
    const validator = new OracleTypeValidator();
    const result = await validator.validate([
      { path: "a.ts", content: "export function f(a: number): number {\n  return a;\n}\n" },
    ]);
    expect(result.status).toBe("pass");
  });

  it("reports type errors with codes and file names", async () => {
    const validator = new OracleTypeValidator();
    const result = await validator.validate([
      { path: "bad.ts", content: "export function f(a: number): string {\n  return a;\n}\n" },
    ]);
    expect(result.status).toBe("fail");
    expect(result.details.join("\n")).toContain("bad.ts");
  });

  it("ignores non-TS files honestly (JS has no checker)", async () => {
    const validator = new OracleTypeValidator();
    const result = await validator.validate([
      { path: "c.js", content: "this is not even parseable }}{{{\n" },
    ]);
    expect(result.status).toBe("pass");
  });
});

describe("safety depth measurement (D-020 helpers)", () => {
  it("measures bracket depth linearly", () => {
    expect(maxBracketDepth("f((a[0]), { x: 1 });")).toBe(3); // [, (, { nest to 3
    expect(maxBracketDepth("")).toBe(0);
    expect(maxBracketDepth("x)")).toBe(0); // a close without an open never inflates depth
  });

  it("measures AST depth iteratively (stack-safe by construction)", () => {
    let node: AstNode = { kind: "Leaf", span: null, fields: {} };
    for (let i = 0; i < 3000; i += 1) {
      node = { kind: "Node", span: null, fields: { child: node } };
    }
    expect(maxAstDepth(node)).toBe(3001);
    expect(MAX_SAFE_NESTING_DEPTH).toBe(2000);
  });
});
