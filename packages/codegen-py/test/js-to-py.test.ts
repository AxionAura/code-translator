import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@axion-ct/core";
import { createOxcJsParser, type OxcJsParser } from "@axion-ct/parser-js";
import { createJsToPyTranslator } from "../src/index.js";

let js: OxcJsParser;

beforeAll(async () => {
  js = await createOxcJsParser();
});

async function translateJs(
  source: string,
  filename = "mod.js",
): Promise<{
  files: Map<string, string>;
  ledger: Awaited<ReturnType<ReturnType<typeof createJsToPyTranslator>["translateUnit"]>>["ledger"];
}> {
  const parseResult = await js.parse(source, { filename, language: "javascript" });
  const unit = { filename, parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename, parseResult }]);
  const translator = createJsToPyTranslator();
  const emission = await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits!();
  const files = new Map<string, string>();
  for (const file of [...emission.files, ...shared.files]) files.set(file.targetPath, file.content);
  return { files, ledger: emission.ledger };
}

describe("JS → Python (WS B)", () => {
  it("translates functions, arithmetic, and conditionals to idiomatic Python", async () => {
    const { files } = await translateJs(
      [
        "export function clamp(value, low, high) {",
        "  if (value < low) {",
        "    return low;",
        "  }",
        "  if (value > high) {",
        "    return high;",
        "  }",
        "  return value;",
        "}",
      ].join("\n"),
    );
    const output = files.get("mod.py")!;
    expect(output).toContain("def clamp(value, low, high):");
    expect(output).toContain("if value < low:");
    expect(output).toContain("return low");
    expect(output).toContain('__all__ = ["clamp"]');
  });

  it("maps template literals to f-strings and preserves JS stringification", async () => {
    const { files } = await translateJs(
      "export function label(name, count, flag) {\n  return `${name}: ${count} ${flag}`;\n}\n",
    );
    const output = files.get("mod.py")!;
    expect(output).toContain(
      'return f"{_ctrans_str_js(name)}: {_ctrans_str_js(count)} {_ctrans_str_js(flag)}"',
    );
  });

  it("routes JS-only semantics through runtime helpers", async () => {
    const { files } = await translateJs(
      [
        "export function sample(items, text) {",
        "  const first = items[0];",
        "  const truncated = text % 7;",
        "  const flagged = items.includes(3);",
        "  return `${first}/${truncated}/${flagged}`;",
        "}",
      ].join("\n"),
    );
    const output = files.get("mod.py")!;
    // Dynamic index through the undefined-for-missing helper.
    expect(output).toContain("_ctrans_js_get(items, 0)");
    // JS % truncation vs Python's floored %.
    expect(output).toContain("_ctrans_js_mod(text, 7)");
    // Array.includes with JS membership semantics.
    expect(output).toContain("_ctrans_js_includes(items, 3)");
    const runtime = files.get("__ctrans_runtime.py")!;
    expect(runtime).toContain("def __ctrans_js_mod");
    expect(runtime).toContain("def __ctrans_js_get");
    expect(runtime).toContain("def __ctrans_js_includes");
  });

  it("maps array method calls on provable receivers", async () => {
    const { files } = await translateJs(
      [
        "export function process(xs) {",
        "  const doubled = xs.map((x) => x * 2);",
        "  const big = xs.filter((x) => x > 2);",
        "  xs.push(9);",
        "  return [doubled, big, xs.length];",
        "}",
      ].join("\n"),
    );
    const output = files.get("mod.py")!;
    expect(output).toContain("_ctrans_js_map(xs, lambda x, *_ctrans_extra: x * 2)");
    expect(output).toContain("_ctrans_js_filter(xs, lambda x, *_ctrans_extra: x > 2)");
    expect(output).toContain("_ctrans_push_value(xs, 9)");
    expect(output).toContain("len(xs)");
  });

  it("lowers classes with constructor, fields, methods, and this", async () => {
    const { files } = await translateJs(
      [
        "export class Counter {",
        "  items = [];",
        "  constructor(start) {",
        "    this.count = start;",
        "  }",
        "  increment() {",
        "    this.count += 1;",
        "    return this.count;",
        "  }",
        "}",
      ].join("\n"),
    );
    const output = files.get("mod.py")!;
    expect(output).toContain("class Counter:");
    expect(output).toContain("def __init__(self, start):");
    expect(output).toContain("self.items = []");
    expect(output).toContain("self.count = start");
    expect(output).toContain("def increment(self):");
    // `this.count += 1` on an instance field: dynamic receiver → helper-backed read.
    expect(output).toContain("self.count = _ctrans_js_add(self.count, 1)");
  });

  it("reports unsupported constructs loudly", async () => {
    const { files, ledger } = await translateJs(
      "export function f(xs) {\n  for (let i = 0; i < xs.length; i++) {\n    if (xs[i] > 1) {\n      continue;\n    }\n  }\n  switch (xs) {\n    case 1:\n      return 'a';\n    default:\n      return 'b';\n  }\n}\n",
    );
    const output = files.get("mod.py")!;
    expect(output).toContain("for i in range(");
    expect(output).toContain("== 1");
    expect(output).toContain("else:");
    const unsupported = ledger.filter((entry) => entry.decision === "unsupported");
    expect(unsupported.length).toBe(0);
  });
});
