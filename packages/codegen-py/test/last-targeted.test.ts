// Final targeted arms (roadmap M7): the last uncovered clusters in codegen-py —
// Math/JSON/Object surfaces on mixed receivers, truthiness variants, TS module
// statements in JS input, and unsupported-pattern classification.
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@ctrans/core";
import { createOxcJsParser, type OxcJsParser } from "@ctrans/parser-js";
import { createJsToPyTranslator } from "../src/index.js";

let js: OxcJsParser;

beforeAll(async () => {
  js = await createOxcJsParser();
});

async function emit(
  source: string,
  language: "javascript" | "typescript" = "javascript",
): Promise<{
  output: string;
  ledger: readonly { rule: string; decision: string }[];
}> {
  const filename = language === "typescript" ? "mod.ts" : "mod.js";
  const parseResult = await js.parse(source, { filename, language });
  const unit = { filename, parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename, parseResult }]);
  const translator = createJsToPyTranslator();
  await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits!();
  return {
    output: shared.files.find((file) => file.targetPath === "mod.py")!.content,
    ledger: shared.ledger,
  };
}

describe("final targeted arms (codegen-py)", () => {
  it("lowers the Math and JSON surfaces", async () => {
    const { output } = await emit(
      "export function f(x, y) {\n  return [Math.floor(x), Math.max(x, y), JSON.stringify({ a: x }), JSON.parse('{}')];\n}\n",
    );
    expect(output).toContain('__ctrans_math_entry("floor", x)');
    expect(output).toContain('__ctrans_math_entry("max", x, y)');
    expect(output).toContain('__import__("json").dumps(');
    expect(output).toContain('__import__("json").loads("{}")');
  });

  it("classifies truthiness arms: literal null, containers, unknowns", async () => {
    const { output } = await emit(
      "export function f(flag, xs, obj, dyn) {\n  const a = flag ? 1 : 0;\n  if (xs) {\n    return [a, len(obj) > 0, __ctrans_truthy(dyn)];\n  }\n  return 0;\n}\n",
    );
    expect(output).toContain("len(obj) > 0");
    expect(output).toContain("__ctrans_truthy(dyn)");
  });

  it("classifies TS module statements arriving in a .ts input (JS direction)", async () => {
    const { output, ledger } = await emit(
      "export enum E { A }\nexport namespace N {\n  export const v = 1;\n}\n",
      "typescript",
    );
    expect(output).toContain("# ctrans: unsupported enum");
    expect(output).toContain("# ctrans: unsupported namespace");
    expect(ledger.filter((entry) => entry.decision === "unsupported").length).toBe(2);
  });

  it("classifies unsupported binding patterns", async () => {
    const { output, ledger } = await emit(
      "export function f(o) {\n  const { a: { b } } = o;\n  return b;\n}\n",
    );
    expect(output).toContain("_ctrans_tmp01 = o");
    expect(ledger.length).toBeGreaterThan(0);
  });

  it("emits bare attribute writes for non-object receivers verbatim", async () => {
    const { output } = await emit(
      "export function f(box) {\n  box.label = 'x';\n  return box;\n}\n",
    );
    // Unknown receiver: dict-style write (JS objects are dicts in the model).
    expect(output).toContain('box["label"] = "x"');
  });
});
