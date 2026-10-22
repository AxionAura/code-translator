// Last uncovered arms: ForIn (TS→JS), await-for-of, for-in with expression LHS,
// arrow inference via isKnownCallable, Array/Object/New annotation inference in
// JS→TS, and boolean literal inference.
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@axion-ct/core";
import {
  createOxcJsParser,
  createOxcSyntaxValidator,
  OracleTypeValidator,
  type OxcJsParser,
} from "@axion-ct/parser-js";
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

describe("for-in + inference arms", () => {
  it("for-in over a map, await for-of, boolean/annotation inference", async () => {
    const source = [
      "export async function f(map, stream) {",
      "  const out = [];",
      "  for (const key in map) {",
      "    out.push(key);",
      "  }",
      "  for await (const chunk of stream) {",
      "    out.push(chunk);",
      "  }",
      "  const flag = true;",
      "  const list = [1, 2];",
      "  const mapping = { a: 1 };",
      "  const made = new Map();",
      "  return [out, flag, list, mapping, made];",
      "}",
    ].join("\n");
    const { jsOut, tsOut } = await emitBoth(source, "mod.js");
    expect(jsOut).toContain("for (const key in map) {");
    expect(jsOut).toContain("for await (const chunk of stream) {");
    expect(tsOut).toContain("for (const key in map) {");
    expect(tsOut).toContain("const flag: boolean = true;");
    expect(tsOut).toContain("const list: Array<unknown> = [1, 2];");
    expect(tsOut).toContain("const mapping: Record<string, unknown> = { a: 1 };");
    expect(tsOut).toContain("const made: Map = new Map();");
    const validator = await createOxcSyntaxValidator();
    const s1 = await validator.validate([
      { path: "mod.js", content: jsOut, language: "javascript" as const },
      { path: "mod.ts", content: tsOut, language: "typescript" as const },
    ]);
    expect(s1.status, s1.details.join("; ")).toBe("pass");
  });

  it("annotates arrow-bound callables without assertion (isKnownCallable)", async () => {
    const { tsOut } = await emitBoth(
      "export function run() {\n  const handler = (x) => x;\n  return handler(1);\n}\n",
      "mod.js",
    );
    expect(tsOut).toContain("const handler = (x: unknown): unknown => x;");
    expect(tsOut).toContain("handler(1)");
    const s2 = await new OracleTypeValidator().validate([{ path: "mod.ts", content: tsOut }]);
    expect(s2.status, s2.details.join("; ")).toBe("pass");
  });
});
