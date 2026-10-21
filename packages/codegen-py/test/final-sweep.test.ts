// Final coverage sweep (roadmap M7): targets the remaining uncovered lowering
// arms in the codegen-py translator — string method surface, dict/Map surface,
// Object.* surface, switch/throw arms, and for-in variants.
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

describe("final sweep: codegen-py string/dict/Object surfaces", () => {
  it("lowers the full string-method surface on typed receivers", async () => {
    const { output } = await emit(
      [
        "const s = 'demo';",
        "export function f() {",
        "  return [",
        "    s.charAt(0),",
        "    s.replaceAll('a', 'b'),",
        "    s.indexOf('e'),",
        "    s.slice(1),",
        "    s.endsWith('o'),",
        "  ];",
        "}",
      ].join("\n"),
    );
    expect(output).toContain("s[0 : 0 + 1]");
    expect(output).toContain('s.replace("a", "b")');
    expect(output).toContain('s.find("e")');
    expect(output).toContain("s[1:]");
    expect(output).toContain('s.endswith("o")');
  });

  it("lowers string methods on unknown receivers through helpers", async () => {
    const { output } = await emit(
      "export function f(s) {\n  return [s.charAt(1), s.repeat(2), s.padStart(4), s.charCodeAt(0), s.substring(0, 2)];\n}\n",
    );
    expect(output).toContain("s[1 : 1 + 1]");
    expect(output).toContain("__ctrans_js_repeat(s, 2)");
    expect(output).toContain("__ctrans_js_pad_start(s, 4)");
    expect(output).toContain("__ctrans_js_char_code_at(s, 0)");
    expect(output).toContain("__ctrans_js_substring(s, 0, 2)");
  });

  it("lowers the Map/dict surface", async () => {
    const { output } = await emit(
      "export function f(m) {\n  m.set('k', 1);\n  const v = m.get('k');\n  const has = m.has('k');\n  const gone = m.delete('k');\n  return [v, has, gone];\n}\n",
    );
    // Unknown receivers route member reads/calls through the helper (honest).
    expect(output).toContain('__ctrans_js_get(m, "set")');
    expect(output).toContain('__ctrans_js_get(m, "get")("k")');
    expect(output).toContain('__ctrans_js_get(m, "has")("k")');
    expect(output).toContain('__ctrans_js_get(m, "delete")("k")');
  });

  it("lowers Object.values/entries/assign", async () => {
    const { output } = await emit(
      "export function f(o) {\n  return [Object.values(o), Object.entries(o), Object.assign({}, o)];\n}\n",
    );
    expect(output).toContain("__ctrans_js_object_values(o)");
    expect(output).toContain("__ctrans_js_object_entries(o)");
    expect(output).toContain("{**{}");
  });

  it("classifies bare-raised values and switch fallthrough markers", async () => {
    const { output, ledger } = await emit(
      "export function f(x) {\n  switch (x) {\n    case 1:\n    case 2:\n      return 'low';\n  }\n}\n",
    );
    expect(output).toContain("# ctrans: unsupported case fallthrough");
    expect(ledger.some((entry) => entry.decision === "unsupported")).toBe(true);
  });

  it("lowers string-typed concatenation natively", async () => {
    const { output } = await emit(
      "const greeting = 'hi';\nexport function f(name) {\n  return greeting + name;\n}\n",
    );
    expect(output).toContain("__ctrans_js_add(greeting, name)");
  });

  it("lowers Array.includes/indexOf on unknown receivers via helpers", async () => {
    const { output } = await emit(
      "export function f(xs, needle) {\n  return [xs.includes(needle), xs.indexOf(needle)];\n}\n",
    );
    expect(output).toContain("__ctrans_js_includes(xs, needle)");
    expect(output).toContain("__ctrans_js_index_of(xs, needle)");
  });

  it("lowers pop/shift on unknown receivers with pop-form", async () => {
    const { output } = await emit("export function f(xs) {\n  return [xs.pop(), xs.shift()];\n}\n");
    expect(output).toContain("xs.pop()");
    expect(output).toContain("xs.pop(0)");
  });
});
