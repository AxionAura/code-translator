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

async function translate(
  translator: TsToJsTranslator | JsToTsTranslator,
  source: string,
  filename: string,
): Promise<{
  files: Map<string, string>;
  ledger: Awaited<ReturnType<typeof translator.translateUnit>>["ledger"];
}> {
  const parseResult = await js.parse(source, {
    filename,
    language: filename.endsWith(".ts") ? "typescript" : "javascript",
  });
  const unit = { filename, parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename, parseResult }]);
  const emission = await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits();
  const files = new Map<string, string>();
  for (const file of [...emission.files, ...shared.files]) files.set(file.targetPath, file.content);
  return { files, ledger: emission.ledger };
}

async function assertS1(
  files: ReadonlyMap<string, string>,
  language: "javascript" | "typescript",
): Promise<void> {
  const validator = await createOxcSyntaxValidator();
  const result = await validator.validate(
    [...files.entries()].map(([path, content]) => ({ path, content, language })),
  );
  expect(result.status, result.details.join("; ")).toBe("pass");
}

describe("TS → JS erasure (WS D)", () => {
  it("erases type-only syntax and preserves runtime code", async () => {
    const { files, ledger } = await translate(
      new TsToJsTranslator(),
      [
        "export interface Shape { area(): number; }",
        "export type Id = string;",
        "export function area(s: Shape): number { return s.area(); }",
        "const size: number = 42 as number;",
        "export class Box implements Shape { private w: number = 3; area(): number { return this.w * this.w; } }",
      ].join("\n"),
      "mod.ts",
    );
    const output = files.get("mod.js")!;
    expect(output).toContain("export function area(s) {");
    expect(output).toContain("const size = 42;");
    expect(output).toContain("export class Box {");
    expect(output).toContain("w = 3;");
    expect(output).not.toContain("interface");
    expect(output).not.toContain(": number");
    expect(output).not.toContain("implements");
    // `export interface` erases under the export wrapper (oxc marks the whole
    // export type-only); `export type` records the declaration rule. Both are the
    // same honest erasure.
    expect(
      ledger.filter((entry) => entry.decision === "deterministic" && entry.rule.includes("erased"))
        .length,
    ).toBeGreaterThanOrEqual(2);
    expect(ledger.some((entry) => entry.rule === "js.ExportNamedDeclaration→erased")).toBe(true);
    await assertS1(files, "javascript");
  });

  it("reports runtime TS constructs as unsupported (enums, namespaces)", async () => {
    const { files, ledger } = await translate(
      new TsToJsTranslator(),
      "enum Color { Red, Green }\nnamespace Store { export const value = 1; }\n",
      "mod.ts",
    );
    expect(ledger.filter((entry) => entry.decision === "unsupported").length).toBe(2);
    expect(files.get("mod.js")!).toContain("ctrans: unsupported enum");
    await assertS1(files, "javascript");
  });

  it("rewrites import specifiers to target module paths", async () => {
    const parseResult = await js.parse(
      'import { helper } from "./helper.js";\nexport const used = helper();\n',
      {
        filename: "src/main.ts",
        language: "typescript",
      },
    );
    const helperParse = await js.parse("export function helper(): number { return 1; }\n", {
      filename: "src/helper.ts",
      language: "typescript",
    });
    const graph = buildModuleGraph([
      { filename: "src/main.ts", parseResult },
      { filename: "src/helper.ts", parseResult: helperParse },
    ]);
    const translator = new TsToJsTranslator();
    for (const input of [
      { filename: "src/main.ts", parseResult, model: analyzeModule(parseResult) },
      { filename: "src/helper.ts", parseResult: helperParse, model: analyzeModule(helperParse) },
    ]) {
      await translator.translateUnit(input, graph);
    }
    const shared = await translator.finalizeUnits();
    const files = new Map<string, string>();
    for (const file of shared.files) files.set(file.targetPath, file.content);
    expect(files.get("src/main.js")!).toContain('from "./helper.js"');
  });
});

describe("JS → TS honest types (WS C)", () => {
  it("annotates unknown signatures and infers literal initializers", async () => {
    const { files, ledger } = await translate(
      new JsToTsTranslator(),
      [
        "export function add(a, b) {",
        "  return a + b;",
        "}",
        "const scale = 3;",
        "const name = `box-${scale}`;",
        "let later;",
      ].join("\n"),
      "mod.js",
    );
    const output = files.get("mod.ts")!;
    expect(output).toContain("function add(a: unknown, b: unknown): unknown {");
    expect(output).toContain("const scale: number = 3;");
    expect(output).toContain("const name: string = `box-${scale}`;");
    expect(output).toContain("let later: unknown;");
    // The arithmetic on unknowns carries a runtime-neutral assertion.
    expect(output).toMatch(/\(a as number\) \+ \(b as number\)/);
    expect(ledger.some((entry) => entry.rule === "js.operand→ts.assert-number")).toBe(true);
    await assertS1(files, "typescript");
    // Honest-types claim: the emitted TS passes the STRICT oracle (no invented
    // types — unknowns + runtime-neutral assertions only).
    const s2 = await new OracleTypeValidator().validate(
      [...files.entries()].map(([path, content]) => ({ path, content })),
    );
    expect(s2.status, s2.details.join("; ")).toBe("pass");
  });

  it("asserts member access and calls on unknown receivers (runtime-neutral)", async () => {
    const { files } = await translate(
      new JsToTsTranslator(),
      "export function run(handler, data) {\n  handler('start');\n  const first = data.items[0];\n  return first;\n}\n",
      "mod.js",
    );
    const output = files.get("mod.ts")!;
    expect(output).toContain('(handler as unknown as (...args: unknown[]) => unknown)("start");');
    expect(output).toContain("(data as unknown as Record<PropertyKey, unknown>)");
    await assertS1(files, "typescript");
    const s2 = await new OracleTypeValidator().validate(
      [...files.entries()].map(([path, content]) => ({ path, content })),
    );
    expect(s2.status, s2.details.join("; ")).toBe("pass");
  });
});
