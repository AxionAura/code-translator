// M5 coverage-completion batch: meaningful behaviors on the new-code paths that
// the workstream and semantics suites don't reach — bigint mixed-operand
// sub/mul boundaries, hoisted unpack elements, self-field comparisons, async
// import-form variants, and registry-module JS stripping. Every test asserts
// emission or executed behavior (no line-chasing without behavior).
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@axion-ct/core";
import { createPythonBridgeParser, type PythonBridgeParser } from "@axion-ct/parser-py";
import { createRegistryLookup } from "@axion-ct/registry";
import type { RegistryLookup } from "@axion-ct/core";
import { createPyToJsTranslator, type PyToJsTranslator } from "../src/translator.js";

let py: PythonBridgeParser;
let registry: RegistryLookup;
let tsTranslator: PyToJsTranslator;
let bigintTranslator: PyToJsTranslator;
let jsTranslator: PyToJsTranslator;

const OUT_DIR = join(import.meta.dirname, ".tmp-m5-coverage");

beforeAll(async () => {
  py = await createPythonBridgeParser();
  registry = createRegistryLookup();
  tsTranslator = await createPyToJsTranslator("typescript", { registry });
  bigintTranslator = await createPyToJsTranslator("typescript", {
    intMode: "bigint",
    registry,
  });
  jsTranslator = await createPyToJsTranslator("javascript", { registry });
  mkdirSync(OUT_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true });
});

async function translate(
  translator: PyToJsTranslator,
  source: string,
  filename = "mod.py",
): Promise<{
  files: Map<string, string>;
  ledger: readonly {
    rule: string;
    decision: string;
    warnings: readonly string[];
    targetSummary: string | null;
  }[];
}> {
  const parseResult = await py.parse(source, { filename });
  const unit = { filename, parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename: unit.filename, parseResult: unit.parseResult }]);
  const emission = await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits();
  const files = new Map<string, string>();
  for (const file of [...emission.files, ...shared.files]) files.set(file.targetPath, file.content);
  return { files, ledger: emission.ledger };
}

describe("bigint boundary conversions (sub/mul mixed operands)", () => {
  it("converts int operands through the Number boundary for int-float subtraction", async () => {
    const { files, ledger } = await translate(
      bigintTranslator,
      "def blend(a: int, f: float) -> float:\n    return a - f\n",
    );
    expect(files.get("mod.ts")).toContain("__ctrans_toFloat(a) - f");
    const entry = ledger.find((item) => item.rule === "py.sub-mixed→js.float-boundary");
    expect(entry?.warnings).toContain("CTW-NUM-BIGINT-FLOAT-BOUNDARY");
  });

  it("converts int operands through the Number boundary for int-float multiplication", async () => {
    const { files, ledger } = await translate(
      bigintTranslator,
      "def scale(a: int, f: float) -> float:\n    return a * f\n",
    );
    expect(files.get("mod.ts")).toContain("__ctrans_toFloat(a) * f");
    const entry = ledger.find((item) => item.rule === "py.mul-mixed→js.float-boundary");
    expect(entry?.decision).toBe("semantic");
  });
});

describe("hoisted unpack elements (nested-block first bindings)", () => {
  it("hoists an unpack leaf first bound inside a nested block", async () => {
    const { files } = await translate(
      tsTranslator,
      "def pick(flag, pair):\n    if flag:\n        x, y = pair\n    return x\n",
    );
    const module = files.get("mod.ts")!;
    // The leaf x is hoisted (unknown type — mixed fresh/existing path).
    expect(module).toContain("let x: unknown;");
  });
});

describe("self-field truthiness (expression provability through fields)", () => {
  it("keeps the truthy helper for string self-fields used in conditions", async () => {
    const { files } = await translate(
      tsTranslator,
      "class C:\n    def __init__(self) -> None:\n        self.name = 'x'\n\n    def check(self) -> bool:\n        return bool(self.name)\n",
    );
    const module = files.get("mod.ts")!;
    expect(module).toContain("__ctrans_truthy(this.name)");
  });
});

describe("registry module emission (JS target stripping)", () => {
  it("emits the stripped __ctrans_math.js for JavaScript targets", async () => {
    const { files } = await translate(
      jsTranslator,
      "import math\n\ndef f(x: float) -> float:\n    return math.floor(x)\n",
    );
    const mathModule = files.get("__ctrans_math.js");
    expect(mathModule).toBeDefined();
    expect(mathModule).toContain("export function floor");
    expect(mathModule).not.toContain(": number"); // types stripped
  });
});

describe("import-form variants on mapped modules", () => {
  it("aliases renamed from-imports on a registry-mapped module", async () => {
    const { files } = await translate(
      tsTranslator,
      "from math import floor as f\n\ndef g(x: float) -> int:\n    return f(x)\n",
    );
    expect(files.get("mod.ts")).toContain('import { floor as f } from "./__ctrans_math.ts";');
  });

  it("namespace-imports a registry-mapped module", async () => {
    const { files } = await translate(
      tsTranslator,
      "import json\n\ndef dump(v) -> str:\n    return json.dumps(v)\n",
    );
    const module = files.get("mod.ts")!;
    expect(module).toContain('import * as json from "./__ctrans_math'.replace("math", "json"));
    expect(module).toContain("json.dumps(v)");
    expect(files.get("__ctrans_json.ts")).toBeDefined();
  });
});
