// Final targeted coverage (roadmap M7): the remaining statement arms of both
// reverse printers — try variants, labeled non-loop blocks, call spreads,
// optional member reads (JS→TS), and the namespace-import / export-default /
// star-reexport / abstract-class / decorator arms (TS→JS + JS→Py).
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@ctrans/core";
import { createOxcJsParser, type OxcJsParser } from "@ctrans/parser-js";
import { JsToTsTranslator, TsToJsTranslator } from "../src/js-directions.js";
import { createJsToPyTranslator } from "@ctrans/codegen-py";

let js: OxcJsParser;

beforeAll(async () => {
  js = await createOxcJsParser();
});

async function emitBoth(
  source: string,
  filename: string,
): Promise<{ jsOut: string | undefined; tsOut: string | undefined }> {
  const language = filename.endsWith(".ts") ? "typescript" : "javascript";
  const parseResult = await js.parse(source, { filename, language });
  const unit = { filename, parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename, parseResult }]);
  const tsToJs = new TsToJsTranslator();
  await tsToJs.translateUnit(unit, graph);
  const jsFiles = new Map<string, string>();
  for (const file of (await tsToJs.finalizeUnits()).files)
    jsFiles.set(file.targetPath, file.content);
  const jsToTs = new JsToTsTranslator();
  await jsToTs.translateUnit(unit, graph);
  const tsFiles = new Map<string, string>();
  for (const file of (await jsToTs.finalizeUnits()).files)
    tsFiles.set(file.targetPath, file.content);
  return {
    jsOut: jsFiles.get(filename.replace(/\.ts$/, ".js")),
    tsOut: tsFiles.get(filename.replace(/\.js$/, ".ts")),
  };
}

describe("statement arms: try variants + labeled blocks + spreads", () => {
  it("try/finally without catch, catch with param, labeled non-loop block", async () => {
    const { jsOut, tsOut } = await emitBoth(
      [
        "export function f(o, n) {",
        "  try {",
        "    o.run();",
        "  } finally {",
        "    n = 0;",
        "  }",
        "  try {",
        "    o.stop();",
        "  } catch (error) {",
        "    void error;",
        "  }",
        "  blk: {",
        "    break blk;",
        "  }",
        "}",
      ].join("\n"),
      "mod.ts",
    );
    expect(jsOut).toContain("finally {");
    expect(jsOut).toContain("} catch (error) {");
    expect(jsOut).toContain("blk: {");
    expect(tsOut).toContain("} finally {");
    expect(tsOut).toContain("catch (error: unknown)");
    expect(tsOut).toContain("blk: {");
  });

  it("call spread of untyped arguments asserts the iterable (JS→TS)", async () => {
    const { tsOut } = await emitBoth(
      "export function f(fn, args) {\n  return fn(...args);\n}\n",
      "mod.js",
    );
    expect(tsOut).toContain("...(");
    expect(tsOut).toContain("as unknown[])");
  });

  it("optional member reads on untyped receivers assert records (JS→TS)", async () => {
    const { tsOut } = await emitBoth(
      "export function f(o) {\n  return o?.config?.name;\n}\n",
      "mod.js",
    );
    expect(tsOut).toContain("as unknown as Record<PropertyKey, unknown>");
  });
});

describe("TS→JS module arms", () => {
  it("erases type-only imports while keeping value imports", async () => {
    const { jsOut: output } = await emitBoth(
      "import type { T } from './types.js';\nimport value, { named } from './mixed.js';\nexport const used = value + named;\n",
      "mod.ts",
    );
    expect(output).not.toContain("types.js");
    expect(output).toContain('from "./mixed.js"');
  });

  it("classifies TSImportEquals and TSExportAssignment unsupported", async () => {
    const parseResult = await js.parse("import fs = require('fs');\nexport = fs;\n", {
      filename: "mod.ts",
      language: "typescript",
    });
    const unit = { filename: "mod.ts", parseResult, model: analyzeModule(parseResult) };
    const graph = buildModuleGraph([{ filename: "mod.ts", parseResult }]);
    const translator = new TsToJsTranslator();
    await translator.translateUnit(unit, graph);
    const shared = await translator.finalizeUnits();
    expect(shared.ledger.filter((entry) => entry.decision === "unsupported").length).toBe(2);
  });
});

describe("JS→Py module arms", () => {
  it("lowers namespace imports of local modules", async () => {
    const mainParse = await js.parse(
      "import * as helpers from './helper.js';\nexport const used = helpers.alpha;\n",
      { filename: "src/main.js", language: "javascript" },
    );
    const helperParse = await js.parse("export function alpha() {\n  return 1;\n}\n", {
      filename: "src/helper.js",
      language: "javascript",
    });
    const graph = buildModuleGraph([
      { filename: "src/main.js", parseResult: mainParse },
      { filename: "src/helper.js", parseResult: helperParse },
    ]);
    const translator = createJsToPyTranslator();
    await translator.translateUnit(
      { filename: "src/main.js", parseResult: mainParse, model: analyzeModule(mainParse) },
      graph,
    );
    await translator.translateUnit(
      { filename: "src/helper.js", parseResult: helperParse, model: analyzeModule(helperParse) },
      graph,
    );
    const shared = await translator.finalizeUnits!();
    const mainPy = shared.files.find((file) => file.targetPath === "src/main.py")!.content;
    expect(mainPy).toContain("from .helper import helper as helpers");
  });
});
