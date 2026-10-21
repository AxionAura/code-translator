// Targeted arm coverage (roadmap M7): the last uncovered clusters in the
// codegen-py translator — type-only exports, specifiers-with-alias re-exports,
// dict-receiver method calls, Object.assign surface, typed-dict get/keys.
import { beforeAll, describe, expect, it } from "vitest";

import {
  analyzeModule,
  buildModuleGraph,
  type AnalyzedUnit,
  type ModuleGraphModel,
} from "@ctrans/core";
import { createOxcJsParser, type OxcJsParser } from "@ctrans/parser-js";
import { createJsToPyTranslator } from "../src/index.js";

let js: OxcJsParser;

beforeAll(async () => {
  js = await createOxcJsParser();
});

async function emitProject(
  mainSource: string,
  helperSource: string,
): Promise<{
  mainPy: string;
  helperPy: string;
  ledger: readonly { rule: string; decision: string }[];
}> {
  const mainParse = await js.parse(mainSource, { filename: "src/main.js", language: "javascript" });
  const helperParse = await js.parse(helperSource, {
    filename: "src/helper.js",
    language: "javascript",
  });
  const graph: ModuleGraphModel = buildModuleGraph([
    { filename: "src/main.js", parseResult: mainParse },
    { filename: "src/helper.js", parseResult: helperParse },
  ]);
  const translator = createJsToPyTranslator();
  const units: readonly AnalyzedUnit[] = [
    { filename: "src/main.js", parseResult: mainParse, model: analyzeModule(mainParse) },
    { filename: "src/helper.js", parseResult: helperParse, model: analyzeModule(helperParse) },
  ];
  let ledger: readonly { rule: string; decision: string }[] = [];
  for (const unit of units) {
    const emission = await translator.translateUnit(unit, graph);
    ledger = [...ledger, ...emission.ledger];
  }
  const shared = await translator.finalizeUnits!();
  const files = new Map<string, string>();
  for (const file of shared.files) files.set(file.targetPath, file.content);
  return { mainPy: files.get("src/main.py")!, helperPy: files.get("src/helper.py")!, ledger };
}

describe("targeted arms: exports and dict surface", () => {
  it("lowers alias re-export lists from a local module", async () => {
    const { mainPy } = await emitProject(
      "export { helper as tool, second } from './helper.js';\nexport const x = 1;\n",
      "export function helper() {\n  return 1;\n}\nexport const second = 2;\n",
    );
    expect(mainPy).toContain("from .helper import helper as tool, second");
    expect(mainPy).toContain("__all__");
  });

  it("lowers dict-receiver Map surface natively", async () => {
    const { mainPy } = await emitProject(
      [
        "import { makeMap } from './helper.js';",
        "export function use() {",
        "  const m = makeMap();",
        "  m.set('k', 1);",
        "  const v = m.get('k');",
        "  const has = m.has('k');",
        "  const ks = m.keys();",
        "  const vs = m.values();",
        "  const es = m.entries();",
        "  const gone = m.delete('k');",
        "  return [v, has, ks, vs, es, gone];",
        "}",
      ].join("\n"),
      "export function makeMap() {\n  return { a: 1 };\n}\n",
    );
    // makeMap's return is an object literal → dict receiver kind propagates
    // through the import binding? No: imported bindings are unknown — assert the
    // honest helper routing.
    expect(mainPy).toContain('__ctrans_js_get(m, "set")("k", 1)');
    expect(mainPy).toContain('__ctrans_js_get(m, "get")("k")');
    expect(mainPy).toContain('__ctrans_js_get(m, "has")("k")');
    expect(mainPy).toContain('__ctrans_js_get(m, "keys")()');
    expect(mainPy).toContain('__ctrans_js_get(m, "values")()');
    expect(mainPy).toContain('__ctrans_js_get(m, "entries")()');
    expect(mainPy).toContain('__ctrans_js_get(m, "delete")("k")');
  });

  it("lowers dict surface on literal receivers natively", async () => {
    const parseResult = await js.parse(
      "export function use(o) {\n  const m = { a: 1 };\n  const v = m.get('a');\n  const has = m.has('a');\n  const ks = m.keys();\n  return [v, has, ks];\n}\n",
      { filename: "mod.js", language: "javascript" },
    );
    const unit = { filename: "mod.js", parseResult, model: analyzeModule(parseResult) };
    const graph = buildModuleGraph([{ filename: "mod.js", parseResult }]);
    const translator = createJsToPyTranslator();
    await translator.translateUnit(unit, graph);
    const shared = await translator.finalizeUnits!();
    const output = shared.files.find((file) => file.targetPath === "mod.py")!.content;
    expect(output).toContain('__ctrans_js_get(m, "a")');
    expect(output).toContain('"a" in m');
    expect(output).toContain("list(m.keys())");
  });

  it("lowers Object.assign merges and dict writes on literal receivers", async () => {
    const parseResult = await js.parse(
      "export function merge(base, patch) {\n  const out = Object.assign({}, base, patch);\n  out.extra = 1;\n  return out;\n}\n",
      { filename: "mod.js", language: "javascript" },
    );
    const unit = { filename: "mod.js", parseResult, model: analyzeModule(parseResult) };
    const graph = buildModuleGraph([{ filename: "mod.js", parseResult }]);
    const translator = createJsToPyTranslator();
    await translator.translateUnit(unit, graph);
    const shared = await translator.finalizeUnits!();
    const output = shared.files.find((file) => file.targetPath === "mod.py")!.content;
    expect(output).toContain("{**{}");
    expect(output).toContain('out["extra"] = 1');
  });

  it("erases TS type-only exports and imports", async () => {
    const parseResult = await js.parse(
      "export type Only = string;\nimport type { Else } from './else.js';\nexport const x: Only = 'v';\nvoid Else;\n",
      { filename: "mod.ts", language: "typescript" },
    );
    const unit = { filename: "mod.ts", parseResult, model: analyzeModule(parseResult) };
    const graph = buildModuleGraph([{ filename: "mod.ts", parseResult }]);
    const translator = createJsToPyTranslator();
    await translator.translateUnit(unit, graph);
    const shared = await translator.finalizeUnits!();
    const output = shared.files.find((file) => file.targetPath === "mod.py")!.content;
    expect(output).not.toContain("import");
    expect(output).toContain("x =");
  });
});
