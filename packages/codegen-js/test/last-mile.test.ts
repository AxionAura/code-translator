// Last-mile coverage (roadmap M7): async arrows with block bodies (JS→TS),
// else-branches with non-block consequents, null/regex/new-expression
// initializer inference, and the remaining statement arms.
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@ctrans/core";
import {
  createOxcJsParser,
  createOxcSyntaxValidator,
  OracleTypeValidator,
  type OxcJsParser,
} from "@ctrans/parser-js";
import { JsToTsTranslator, TsToJsTranslator } from "../src/js-directions.js";

let js: OxcJsParser;

beforeAll(async () => {
  js = await createOxcJsParser();
});

async function emitBoth(
  source: string,
  filename: string,
): Promise<{ jsOut: string; tsOut: string }> {
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
    jsOut: jsFiles.get(filename.replace(/\.ts$/, ".js"))!,
    tsOut: tsFiles.get(filename.replace(/\.js$/, ".ts"))!,
  };
}

describe("last-mile arms", () => {
  it("async block arrows, null/regex/new initializers, else-if chains", async () => {
    const source = [
      "export async function f(o, n) {",
      "  const runner = async (label) => {",
      "    await o.run(label);",
      "    return label;",
      "  };",
      "  const nothing = null;",
      "  const pattern = /ab+/;",
      "  const made = new Error('x');",
      "  if (n > 1) {",
      "    return runner('big');",
      "  } else if (n > 0) {",
      "    return 'mid';",
      "  } else {",
      "    return nothing;",
      "  }",
      "}",
    ].join("\n");
    const { jsOut, tsOut } = await emitBoth(source, "mod.js");
    expect(jsOut).toContain("async (label) => {");
    expect(jsOut).toContain("} else if (n > 0) {");
    expect(tsOut).toContain("const pattern: RegExp = /ab+/;");
    expect(tsOut).toContain('const made: Error = new Error("x")');
    // JS→TS honest annotations from initializer evidence.
    expect(tsOut).toContain("const nothing: null = null;");
    expect(tsOut).toContain("const pattern: RegExp = /ab+/;");
    expect(tsOut).toContain('const made: Error = new Error("x")');
    expect(tsOut).toContain("const runner = async (label: unknown): Promise<unknown> => {");
    await new Promise<void>(async (resolve, reject) => {
      try {
        const validator = await createOxcSyntaxValidator();
        const s1 = await validator.validate([
          { path: "mod.js", content: jsOut, language: "javascript" as const },
          { path: "mod.ts", content: tsOut, language: "typescript" as const },
        ]);
        expect(s1.status, s1.details.join("; ")).toBe("pass");
        const s2 = await new OracleTypeValidator().validate([{ path: "mod.ts", content: tsOut }]);
        expect(s2.status, s2.details.join("; ")).toBe("pass");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
});
