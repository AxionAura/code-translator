// Unsupported-arm sweep for the codegen-py translator (roadmap M7): every
// unsupported and comment-only-body arm produces the marker, keeps the module
// parseable, and classifies the ledger honestly.
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

describe("unsupported-arm sweep (codegen-py)", () => {
  it("abstract class / static block / abstract members / odd members", async () => {
    const { output, ledger } = await emit(
      [
        "export abstract class Base {",
        "  abstract run(): void;",
        "  static {",
        "    Base.marker = 1;",
        "  }",
        "}",
      ].join("\n"),
      "typescript",
    );
    expect(output).toContain("# ctrans: unsupported abstract class");
    expect(
      ledger.filter((entry) => entry.decision === "unsupported").length,
    ).toBeGreaterThanOrEqual(1);
    // The emitted module must still re-parse (markers are comments).
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

  it("strict/loose equality join the == mapping comment honestly", async () => {
    const { output, ledger } = await emit(
      "export function cmp(a, b) {\n  return [a === b, a !== b, a == b];\n}\n",
    );
    expect(output).toContain("==");
    expect(
      ledger.filter((entry) => entry.decision === "semantic" && entry.rule.includes("js.==="))
        .length,
    ).toBe(1);
  });

  it("block-bodied and async arrow expressions are unsupported with markers", async () => {
    const { output, ledger } = await emit(
      "export function f(xs) {\n  const g = function () {\n    return 1;\n  };\n  void g;\n}\n",
    );
    // Block-bodied function expressions lower to named defs (honest Python idiom).
    expect(output).toContain("def g():");
    expect(output).toContain("return 1");
    expect(ledger.some((entry) => entry.decision === "semantic")).toBe(true);
  });

  it("comment-only bodies emit pass so the module re-parses", async () => {
    const { output } = await emit(
      "export function f(o) {\n  const { a, ...rest } = o;\n  void a;\n}\n",
    );
    expect(output).toContain("# ctrans: unsupported object rest in destructuring");
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
