// Arm-completion sweep (roadmap M7): constructs whose lowering arms the matrix
// and behavior tests do not reach — local default/namespace imports, counting-loop
// bound/update variants, helper-callback array methods, and the remaining string/
// dict surface. Every entry asserts S1 (bridge re-parse) and the emitted fragments.
import { beforeAll, describe, expect, it } from "vitest";

import {
  analyzeModule,
  buildModuleGraph,
  type AnalyzedUnit,
  type ModuleGraphModel,
} from "@ctrans/core";
import { createOxcJsParser, type OxcJsParser } from "@ctrans/parser-js";
import { createJsToPyTranslator } from "../src/index.js";
import type { UnitTranslator } from "@ctrans/core";

let js: OxcJsParser;

beforeAll(async () => {
  js = await createOxcJsParser();
});

// Two-module project: main.js imports every import form from helper.js.
async function translateProject(
  mainSource: string,
  helperSource: string,
): Promise<{ mainPy: string; helperPy: string }> {
  const mainParse = await js.parse(mainSource, { filename: "src/main.js", language: "javascript" });
  const helperParse = await js.parse(helperSource, {
    filename: "src/helper.js",
    language: "javascript",
  });
  const graph: ModuleGraphModel = buildModuleGraph([
    { filename: "src/main.js", parseResult: mainParse },
    { filename: "src/helper.js", parseResult: helperParse },
  ]);
  const translator: UnitTranslator = createJsToPyTranslator();
  const units: readonly AnalyzedUnit[] = [
    { filename: "src/main.js", parseResult: mainParse, model: analyzeModule(mainParse) },
    { filename: "src/helper.js", parseResult: helperParse, model: analyzeModule(helperParse) },
  ];
  for (const unit of units) await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits!();
  const files = new Map<string, string>();
  for (const file of shared.files) files.set(file.targetPath, file.content);
  return { mainPy: files.get("src/main.py")!, helperPy: files.get("src/helper.py")! };
}

describe("arm completion: import forms (2-module project)", () => {
  it("lowers default/namespace/named/alias imports from a local module", async () => {
    const { mainPy, helperPy } = await translateProject(
      [
        "import maker from './helper.js';",
        "import * as helpers from './helper.js';",
        "import { alpha, beta as rename } from './helper.js';",
        "export const used = maker() + helpers.alpha + alpha + rename;",
      ].join("\n"),
      "export default function maker() {\n  return 1;\n}\nexport function alpha() {\n  return 2;\n}\nexport function beta() {\n  return 3;\n}\n",
    );
    expect(helperPy).toContain("def maker():");
    expect(mainPy).toContain("from .helper import default as maker");
    expect(mainPy).toContain("from .helper import helper as helpers");
    expect(mainPy).toContain("alpha, beta as rename");
  });

  it("lowers import-side-effect and star re-export forms", async () => {
    const { mainPy } = await translateProject(
      ["import './helper.js';", "export * from './helper.js';", "export const x = 1;"].join("\n"),
      "export const value = 1;\n",
    );
    expect(mainPy).toContain("from .helper import *");
  });
});

async function emit(source: string): Promise<string> {
  const parseResult = await js.parse(source, { filename: "mod.js", language: "javascript" });
  const unit = { filename: "mod.js", parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename: "mod.js", parseResult }]);
  const translator = createJsToPyTranslator();
  await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits!();
  return shared.files.find((file) => file.targetPath === "mod.py")!.content;
}

describe("arm completion: counting-loop variants", () => {
  it("lowers --, += and -= updates and reversed bounds", async () => {
    const output = await emit(
      [
        "export function f(n) {",
        "  let a = 0;",
        "  for (let i = n; i > 0; i--) {",
        "    a += 1;",
        "  }",
        "  for (let i = 0; i < n; i += 2) {",
        "    a += 2;",
        "  }",
        "  for (let i = n; i >= 0; i -= 3) {",
        "    a += 3;",
        "  }",
        "  return a;",
        "}",
      ].join("\n"),
    );
    expect(output).toContain("range(n, 0, -1)");
    expect(output).toContain("range(0, n, 2)");
    expect(output).toContain("range(n, -1, -3)");
  });
});

describe("arm completion: helper-callback array methods", () => {
  it("routes named-function callbacks through the helpers", async () => {
    const output = await emit(
      [
        "import { double, big } from './x.js';",
        "export function f(xs, predicate) {",
        "  return [xs.map(double), xs.filter(big), xs.reduce(addAll, 0), xs.find(big), xs.forEach(log)];",
        "}",
      ].join("\n"),
    );
    expect(output).toContain("__ctrans_js_map(xs, double)");
    expect(output).toContain("__ctrans_js_filter(xs, big)");
    expect(output).toContain("__ctrans_js_reduce(xs, addAll, 0, True)");
    expect(output).toContain("__ctrans_js_find(xs, big)");
    expect(output).toContain("__ctrans_js_for_each(xs, log)");
  });

  it("lowers sort/reverse/pop/shift on array receivers", async () => {
    const output = await emit(
      "export function f(xs) {\n  return [xs.sort(), xs.reverse(), xs.pop(), xs.shift()];\n}\n",
    );
    expect(output).toContain("__ctrans_js_sort(xs)");
    expect(output).toContain("__ctrans_js_reverse(xs)");
    expect(output).toContain("xs.pop()");
    expect(output).toContain("xs.pop(0)");
  });

  it("lowers prefix decrement and compound updates on dynamic targets", async () => {
    const output = await emit(
      "export function f(o) {\n  --o.count;\n  o.total -= 2;\n  return o;\n}\n",
    );
    expect(output).toContain('__ctrans_js_get(o, "count")');
  });
});
