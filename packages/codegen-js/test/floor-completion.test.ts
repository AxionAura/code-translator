// Floor completion (roadmap M7): the final uncovered arms in both reverse
// printers — export-default forms, while/do-while non-block bodies, `void` and
// `delete` statements (TS→JS); for-in over arrays, brace escapes in templates,
// nested conditionals, sequence expressions (JS→Py).
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@ctrans/core";
import { createOxcJsParser, createOxcSyntaxValidator, type OxcJsParser } from "@ctrans/parser-js";
import { TsToJsTranslator } from "../src/js-directions.js";
import { createJsToPyTranslator } from "@ctrans/codegen-py";

let js: OxcJsParser;

beforeAll(async () => {
  js = await createOxcJsParser();
});

describe("floor completion: TS→JS", () => {
  it("lowers export-default function, non-block while/do bodies, void/delete", async () => {
    const source = [
      "export default function pick(o) {",
      "  while (o.ready) o.step();",
      "  do o.reset(); while (o.dirty);",
      "  delete o.cache;",
      "  return void 0;",
      "}",
    ].join("\n");
    const parseResult = await js.parse(source, { filename: "mod.ts", language: "typescript" });
    const unit = { filename: "mod.ts", parseResult, model: analyzeModule(parseResult) };
    const graph = buildModuleGraph([{ filename: "mod.ts", parseResult }]);
    const translator = new TsToJsTranslator();
    await translator.translateUnit(unit, graph);
    const shared = await translator.finalizeUnits();
    const output = shared.files.find((file) => file.targetPath === "mod.js")!.content;
    expect(output).toContain("function pick(o) {");
    expect(output).toContain("export default pick;");
    expect(output).toContain("while (o.ready)");
    expect(output).toContain("} while (o.dirty);");
    const validator = await createOxcSyntaxValidator();
    const s1 = await validator.validate([
      { path: "mod.js", content: output, language: "javascript" as const },
    ]);
    expect(s1.status, s1.details.join("; ")).toBe("pass");
  });
});

describe("floor completion: JS→Py", () => {
  it("lowers for-in over arrays, template braces, nested conditionals, sequences", async () => {
    const source = [
      "export function f(xs, flag) {",
      "  const keys = [];",
      "  for (const k in xs) {",
      "    keys.push(k);",
      "  }",
      "  const brace = `a{b}c${flag}`;",
      "  const nested = flag ? (flag === 1 ? 'one' : 'many') : 'none';",
      "  const seq = (flag = 2, flag + 1);",
      "  return [keys, brace, nested, seq];",
      "}",
    ].join("\n");
    const parseResult = await js.parse(source, { filename: "mod.js", language: "javascript" });
    const unit = { filename: "mod.js", parseResult, model: analyzeModule(parseResult) };
    const graph = buildModuleGraph([{ filename: "mod.js", parseResult }]);
    const translator = createJsToPyTranslator();
    await translator.translateUnit(unit, graph);
    const shared = await translator.finalizeUnits!();
    const output = shared.files.find((file) => file.targetPath === "mod.py")!.content;
    expect(output).toContain("__ctrans_js_array_from_keys(xs)");
    expect(output).toContain('f"a{{b}}c{__ctrans_str_js(flag)}"');
    expect(output).toContain("if __ctrans_truthy");
    expect(output).toContain("== 1");
    expect(output).toContain("_ctrans_tmp");
    const { createPythonBridgeParser } = await import("@ctrans/parser-py");
    const bridge = await createPythonBridgeParser();
    try {
      await bridge.parse(output, { filename: "out.py" });
    } catch (error) {
      throw new Error(
        `S1 failed: ${error instanceof Error ? error.message : String(error)}\n${output}`,
      );
    }
  });
});
