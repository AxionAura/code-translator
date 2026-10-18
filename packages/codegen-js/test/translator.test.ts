import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule } from "@ctrans/core";
import { createPythonBridgeParser, type PythonBridgeParser } from "@ctrans/parser-py";
import { createOxcSyntaxValidator } from "@ctrans/parser-js";
import { createPyToJsTranslator, type PyToJsTranslator } from "../src/translator.js";

let py: PythonBridgeParser;
let tsTranslator: PyToJsTranslator;

beforeAll(async () => {
  py = await createPythonBridgeParser();
  tsTranslator = await createPyToJsTranslator("typescript");
});

// Lower + materialize (the shared runtime comes from finalizeUnits).
async function translateTs(source: string, filename = "mod.py") {
  const parseResult = await py.parse(source, { filename });
  const unit = { filename, parseResult, model: analyzeModule(parseResult) };
  const graphInputs = { filename: unit.filename, parseResult: unit.parseResult };
  const { buildModuleGraph } = await import("@ctrans/core");
  const graph = buildModuleGraph([graphInputs]);
  const emission = await tsTranslator.translateUnit(unit, graph);
  const shared = await tsTranslator.finalizeUnits();
  const files = new Map<string, string>();
  for (const file of [...emission.files, ...shared.files]) files.set(file.targetPath, file.content);
  return { files, ledger: emission.ledger };
}

describe("python → typescript translator", () => {
  it("emits formatted, re-parseable output with ledger provenance", async () => {
    const { files, ledger } = await translateTs(
      "def add(a: int, b: int) -> int:\n    return a + b\n",
    );
    const module = files.get("mod.ts")!;
    expect(module).toContain("function add(a: number, b: number): number");
    expect(module).toContain("return a + b;");
    expect(ledger.length).toBeGreaterThan(0);
    const validator = await createOxcSyntaxValidator();
    const s1 = await validator.validate(
      [...files.entries()].map(([path, content]) => ({
        path,
        content,
        language: "typescript" as const,
      })),
    );
    expect(s1.status).toBe("pass");
  });

  it("uses runtime helpers for python semantics and emits the runtime module once", async () => {
    const { files } = await translateTs("def f(a, b):\n    return a // b, a % b, a / b\n");
    const module = files.get("mod.ts")!;
    expect(module).toContain("__ctrans_floorDiv(a, b)");
    expect(module).toContain("__ctrans_mod(a, b)");
    expect(module).toContain("__ctrans_div(a, b)");
    expect(module).toMatch(
      /import \{[^}]*__ctrans_floorDiv[^}]*\} from "\.\/__ctrans_runtime\.ts"/,
    );
    const runtime = files.get("__ctrans_runtime.ts");
    expect(runtime).toBeDefined();
    expect(runtime!).toContain("export function __ctrans_floorDiv");
  });

  it("maps comparisons and truthiness to helpers", async () => {
    const { files } = await translateTs(
      "def check(a, b):\n    if a and b:\n        return a == b\n    return not a\n",
    );
    const module = files.get("mod.ts")!;
    // and/or lower to truthiness-gated ternaries (value-preserving); the if-test
    // applies truthy to the resulting VALUE - double truthy is semantically exact.
    expect(module).toContain("if (__ctrans_truthy(__ctrans_truthy(a) ? b : a)) {");
    expect(module).toContain("__ctrans_eq(a, b)");
    expect(module).toContain("!__ctrans_truthy(a)");
  });

  it("translates comprehensions to map/filter chains", async () => {
    const { files } = await translateTs(
      "def big(xs: list[int]):\n    return [x * 2 for x in xs if x > 1]\n",
    );
    const module = files.get("mod.ts")!;
    expect(module).toContain(".filter((x) => __ctrans_truthy(x > 1))");
    expect(module).toContain(".map((x) => x * 2)");
  });

  it("rewrites local imports to target module paths and exports the contract surface", async () => {
    const parseResult = await py.parse(
      "from .helper import thing\n\ndef use():\n    return thing\n",
      { filename: "pkg/main.py" },
    );
    const helper = await py.parse("thing = 1\n", { filename: "pkg/helper.py" });
    const { buildModuleGraph } = await import("@ctrans/core");
    const graph = buildModuleGraph([
      { filename: "pkg/main.py", parseResult },
      { filename: "pkg/helper.py", parseResult: helper },
    ]);
    const unit = { filename: "pkg/main.py", parseResult, model: analyzeModule(parseResult) };
    await tsTranslator.translateUnit(unit, graph);
    const shared = await tsTranslator.finalizeUnits();
    const files = new Map<string, string>();
    for (const file of shared.files) files.set(file.targetPath, file.content);
    const module = files.get("pkg/main.ts")!;
    expect(module).toMatch(/import \{ thing \} from "\.\/helper\.ts";/);
    expect(module).toContain("export function use()");
  });
});
