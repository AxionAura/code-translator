// Final floor lines (roadmap M7): static blocks, abstract members, provable
// truthiness shortcuts, and the remaining class-member arms.
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

describe("final floor lines (codegen-py)", () => {
  it("reports static blocks unsupported", async () => {
    const { output, ledger } = await emit(
      "export class M {\n  static {\n    M.x = 1;\n  }\n}\n",
      "javascript",
    );
    expect(output).toContain("# ctrans: unsupported static block");
    expect(ledger.some((entry) => entry.decision === "unsupported")).toBe(true);
  });

  it("short-circuits truthiness for boolean literals and number literals", async () => {
    const { output } = await emit(
      "export function f() {\n  if (true) {\n    return 1;\n  }\n  if (0) {\n    return 2;\n  }\n  return 3;\n}\n",
    );
    expect(output).toContain("if True:");
    expect(output).toContain("if 0:");
  });

  it("lowers computed class keys and generator methods", async () => {
    const { output } = await emit(
      "export class K {\n  ['dynamic']() {\n    return 1;\n  }\n  *walk() {\n    yield 1;\n  }\n}\n",
    );
    expect(output).toContain("def dynamic(self):");
    expect(output).toContain("def walk(self):");
    expect(output).toContain("yield 1");
  });

  it("lowers try/else semantics through finally with a return", async () => {
    const { output } = await emit(
      "export function f(o) {\n  try {\n    return o.value;\n  } catch (error) {\n    return null;\n  } finally {\n    o.done = true;\n  }\n}\n",
    );
    expect(output).toContain("except Exception as error:");
    expect(output).toContain("finally:");
    expect(output).toContain('o["done"] = True');
  });
});
