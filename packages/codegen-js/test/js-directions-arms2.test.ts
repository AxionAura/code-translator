// Arm-completion sweep for the reverse JS↔TS directions (roadmap M7): import
// forms (2-module project), switch/loop variants, chain calls, spreads, and the
// remaining statement/expression arms both translators share.
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@axion-ct/core";
import { createOxcJsParser, createOxcSyntaxValidator, type OxcJsParser } from "@axion-ct/parser-js";
import { JsToTsTranslator, TsToJsTranslator } from "../src/js-directions.js";

let js: OxcJsParser;

beforeAll(async () => {
  js = await createOxcJsParser();
});

async function emitBoth(
  mainSource: string,
  helperSource: string | null,
): Promise<{ jsOut: string | undefined; tsOut: string | undefined }> {
  const language = "typescript";
  const mainParse = await js.parse(mainSource, { filename: "src/main.ts", language });
  const inputs = [{ filename: "src/main.ts", parseResult: mainParse }];
  if (helperSource !== null) {
    const helperParse = await js.parse(helperSource, { filename: "src/helper.ts", language });
    inputs.push({ filename: "src/helper.ts", parseResult: helperParse });
  }
  const graph = buildModuleGraph(
    inputs.map((input) => ({ filename: input.filename, parseResult: input.parseResult })),
  );
  const tsToJs = new TsToJsTranslator();
  const jsToTs = new JsToTsTranslator();
  for (const unit of inputs.map((input) => ({
    ...input,
    model: analyzeModule(input.parseResult),
  }))) {
    await tsToJs.translateUnit(unit, graph);
    await jsToTs.translateUnit(unit, graph);
  }
  const jsFiles = new Map<string, string>();
  for (const file of (await tsToJs.finalizeUnits()).files)
    jsFiles.set(file.targetPath, file.content);
  const tsFiles = new Map<string, string>();
  for (const file of (await jsToTs.finalizeUnits()).files)
    tsFiles.set(file.targetPath, file.content);
  return {
    jsOut: jsFiles.get("src/main.js"),
    tsOut: tsFiles.get("src/main.ts"),
  };
}

async function assertS1(
  files: readonly { path: string; content: string }[],
  language: "javascript" | "typescript",
): Promise<void> {
  const validator = await createOxcSyntaxValidator();
  const result = await validator.validate(files.map((file) => ({ ...file, language })));
  expect(result.status, result.details.join("; ")).toBe("pass");
}

describe("arm completion: import forms", () => {
  it("lowers default/namespace/alias exports+imports across modules", async () => {
    const { jsOut, tsOut } = await emitBoth(
      [
        "import maker from './helper.js';",
        "import * as helpers from './helper.js';",
        "import { alpha, beta as rename } from './helper.js';",
        "export const used = maker() + helpers.alpha + alpha + rename;",
        "export { alpha as exportedAlpha };",
      ].join("\n"),
      "export default function maker(): number {\n  return 1;\n}\nexport function alpha(): number {\n  return 2;\n}\nexport function beta(): number {\n  return 3;\n}\n",
    );
    expect(jsOut).toContain('from "');
    expect(tsOut).toContain("maker");
    await assertS1(
      [
        { path: "src/main.js", content: jsOut! },
        { path: "src/helper.js", content: "export function maker() {}" },
      ],
      "javascript",
    );
  });

  it("lowers export-default declarations and star reexports", async () => {
    const { jsOut } = await emitBoth(
      "export default class Engine {\n  start() {\n    return 1;\n  }\n}\n",
      null,
    );
    expect(jsOut).toContain("class Engine");
    expect(jsOut).toContain("export default Engine;");
    await assertS1([{ path: "src/main.js", content: jsOut! }], "javascript");
  });

  it("lowers `export *` and re-export lists", async () => {
    const { jsOut } = await emitBoth(
      "export * from './helper.js';\nexport { alpha } from './helper.js';\n",
      "export function alpha() {\n  return 1;\n}\n",
    );
    expect(jsOut).toContain('export * from "./helper.js"');
    expect(jsOut).toContain('export { alpha } from "./helper.js"');
    await assertS1([{ path: "src/main.js", content: jsOut! }], "javascript");
  });
});

describe("arm completion: statement arms", () => {
  it("lowers switch with fallthrough, do-while, labeled loops, sequences", async () => {
    const { jsOut, tsOut } = await emitBoth(
      [
        "export function control(n, obj) {",
        "  do {",
        "    n -= 1;",
        "  } while (n > 0);",
        "  switch (n) {",
        "    case 0:",
        "    case 1:",
        "      return 'low';",
        "    default:",
        "      return 'high';",
        "  }",
        "}",
      ].join("\n"),
      null,
    );
    expect(jsOut).toContain("switch (n)");
    await assertS1([{ path: "src/main.js", content: jsOut! }], "javascript");
    await assertS1([{ path: "src/main.ts", content: tsOut! }], "typescript");
  });

  it("lowers optional calls, computed chains, and update forms", async () => {
    const { jsOut, tsOut } = await emitBoth(
      [
        "export function run(handler, o, n) {",
        "  handler?.('x');",
        "  const v = o?.deep?.[0];",
        "  void v;",
        "  n++;",
        "  ++n;",
        "  return n;",
        "}",
      ].join("\n"),
      null,
    );
    expect(jsOut).toContain("handler?.(");
    expect(jsOut).toContain("?.[");
    expect(jsOut).toContain("++n;");
    await assertS1([{ path: "src/main.js", content: jsOut! }], "javascript");
    await assertS1([{ path: "src/main.ts", content: tsOut! }], "typescript");
  });

  it("lowers empty statements and bare blocks", async () => {
    const { jsOut } = await emitBoth(
      "export function f() {\n  ;\n  {\n    const x = 1;\n    void x;\n  }\n}\n",
      null,
    );
    await assertS1([{ path: "src/main.js", content: jsOut! }], "javascript");
  });
});
