// M7 coverage: exercise the codegen-py lowering arms the matrix and behavior
// tests do not reach (do-while, labels, nested destructure, string ops, Object
// surface, remainder, increment forms, chained member access, JSON surface).
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@axion-ct/core";
import { createOxcJsParser, type OxcJsParser } from "@axion-ct/parser-js";
import { createJsToPyTranslator } from "../src/index.js";

let js: OxcJsParser;

beforeAll(async () => {
  js = await createOxcJsParser();
});

async function emit(
  source: string,
  language: "javascript" | "typescript" = "javascript",
): Promise<string> {
  const filename = language === "typescript" ? "mod.ts" : "mod.js";
  const parseResult = await js.parse(source, { filename, language });
  const unit = { filename, parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename, parseResult }]);
  const translator = createJsToPyTranslator();
  await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits!();
  let output = "";
  for (const file of shared.files) {
    if (file.targetPath === "mod.py") output = file.content;
  }
  return output;
}

describe("codegen-py coverage arms", () => {
  it("lowers do-while to while True + trailing break", async () => {
    const output = await emit(
      "export function f(n) {\n  do {\n    n -= 1;\n  } while (n > 0);\n  return n;\n}\n",
    );
    expect(output).toContain("while True:");
    expect(output).toContain("if not (n > 0):");
    expect(output).toContain("break");
  });

  it("reports labeled statements unsupported", async () => {
    const output = await emit(
      "export function f(xs) {\n  outer: for (const x of xs) {\n    break outer;\n  }\n}\n",
    );
    expect(output).toContain("# ctrans: unsupported labeled statement");
  });

  it("lowers nested property access through dynamic helpers", async () => {
    const output = await emit("export function f(config) {\n  return config.database.url;\n}\n");
    expect(output).toContain("__ctrans_js_get(");
  });

  it("lowers do-while with continue as unsupported (semantics not reproducible)", async () => {
    const output = await emit(
      "export function f(n) {\n  do {\n    n -= 1;\n    if (n === 3) {\n      continue;\n    }\n  } while (n > 0);\n  return n;\n}\n",
    );
    expect(output).toContain("# ctrans: unsupported do-while with continue");
  });

  it("emits ambient TS constructs as erased", async () => {
    const output = await emit(
      "declare function external(n: number): number;\nexport const used = external(1);\n",
      "typescript",
    );
    expect(output).not.toContain("declare");
  });

  it("classifies object rest destructuring as unsupported", async () => {
    const output = await emit(
      "export function f(o) {\n  const { a, ...rest } = o;\n  return rest;\n}\n",
    );
    expect(output).toContain("# ctrans: unsupported object rest in destructuring");
  });

  it("static class fields map to class attributes", async () => {
    const output = await emit("export class Registry {\n  static VERSION = 2;\n}\n");
    expect(output).toContain("VERSION = 2");
  });

  it("string surface: padStart, charCodeAt, substring, repeat", async () => {
    const output = await emit(
      "export function f(s) {\n  return [s.padStart(5, '0'), s.charCodeAt(0), s.substring(1, 3), s.repeat(2)];\n}\n",
    );
    expect(output).toContain("__ctrans_js_pad_start(s, 5, '0')".replaceAll("'", '"'));
    expect(output).toContain("__ctrans_js_char_code_at(s, 0)");
    expect(output).toContain("__ctrans_js_substring(s, 1, 3)");
    expect(output).toContain("__ctrans_js_repeat(s, 2)");
  });
});
