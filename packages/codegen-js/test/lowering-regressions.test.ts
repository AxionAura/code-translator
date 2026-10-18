// Regression tests for lowering-fidelity defects found by the independent M4 audit:
// Python-scope binding hoisting, honest classification of unmapped builtins, honest
// strict-typing defaults (never implicit any), open dict records, unpack rebinding,
// and comprehension iteration routing. Each test pins behavior the audit verified
// broken end-to-end (emitted output failed S2 or diverged at runtime).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@ctrans/core";
import { createPythonBridgeParser, type PythonBridgeParser } from "@ctrans/parser-py";
import { createPyToJsTranslator } from "../src/translator.js";

let py: PythonBridgeParser;

beforeAll(async () => {
  py = await createPythonBridgeParser();
});

async function translateTs(source: string, filename = "mod.py") {
  const parseResult = await py.parse(source, { filename });
  const unit = { filename, parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename: unit.filename, parseResult: unit.parseResult }]);
  const translator = await createPyToJsTranslator("typescript");
  const emission = await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits();
  const files = new Map<string, string>();
  for (const file of [...emission.files, ...shared.files]) files.set(file.targetPath, file.content);
  return { files, ledger: emission.ledger };
}

describe("M4 audit regressions: honest lowering", () => {
  it("classifies unmapped Python builtins as unsupported (marker + warning), never as deterministic bare calls", async () => {
    const { files, ledger } = await translateTs("def f(xs):\n    return sorted(xs)\n");
    const entry = ledger.find((item) => item.rule === "py.Call(builtin)→unsupported");
    expect(entry).toBeDefined();
    expect(entry!.decision).toBe("unsupported");
    expect(entry!.warnings.length).toBeGreaterThan(0);
    const module = files.get("mod.ts")!;
    expect(module).toContain("/* ctrans: unsupported");
    expect(module).not.toMatch(/\bsorted\(xs\)/);
  });

  it("keeps genuine forward references native (non-builtin unresolved names still call directly)", async () => {
    const { files, ledger } = await translateTs(
      "def a():\n    return b()\n\ndef b():\n    return 1\n",
    );
    const call = ledger.find((item) => item.targetSummary === "b()");
    expect(call?.decision).toBe("deterministic");
    expect(files.get("mod.ts")).toContain("return b();");
  });

  it("hoists branch-bound variables to the enclosing Python scope", async () => {
    const { files } = await translateTs(
      'def pick(v):\n    if v:\n        msg = "big"\n    else:\n        msg = "small"\n    return msg\n',
    );
    const module = files.get("mod.ts")!;
    expect(module).toContain("let msg: unknown;");
    expect(module).toContain('msg = "big";');
    expect(module).toContain('msg = "small";');
    expect(module).toContain("return msg;");
    expect(module).not.toContain('let msg = "big"');
  });

  it("hoists module-level branch bindings too (exported binding keeps its export)", async () => {
    const { files } = await translateTs(
      'if 1 > 2:\n    flag = "never"\nelse:\n    flag = "fallback"\nprint(flag)\n',
    );
    const module = files.get("mod.ts")!;
    expect(module).toContain("export let flag: unknown;");
    expect(module).not.toContain('export let flag = "');
  });

  it("declares unannotated method and constructor parameters as unknown (never implicit any)", async () => {
    const { files } = await translateTs(
      "class P:\n    def __init__(self, x):\n        self.x = x\n\n    def get(self):\n        return self.x\n",
    );
    const module = files.get("mod.ts")!;
    expect(module).toContain("constructor(x: unknown)");
    expect(module).toContain("x: unknown;");
  });

  it("annotates fresh empty-list bindings as unknown[] (no silent implicit any[])", async () => {
    const { files } = await translateTs("def f():\n    xs = []\n    return len(xs)\n");
    const module = files.get("mod.ts")!;
    expect(module).toContain("let xs: unknown[] = [];");
  });

  it("widens dict literal bindings to open Record types so later key writes type-check", async () => {
    const { files } = await translateTs('d = {"a": 1}\nd["b"] = 2\n');
    const module = files.get("mod.ts")!;
    expect(module).toMatch(/let d: Record<string, number> = /);
    expect(module).toContain('d["b"] = 2;');
  });

  it("declares fresh unpack bindings as unknown so dynamic rebinding stays legal", async () => {
    const { files } = await translateTs(
      "def spin(n):\n    a, b = 0, 1\n    while n > 0:\n        a, b = b, a + b\n        n -= 1\n    return a\n",
    );
    const module = files.get("mod.ts")!;
    expect(module).toContain("let [a, b]: unknown[] = [0, 1];");
  });

  it("routes comprehensions over unknown iterables through __ctrans_iter like for-loops", async () => {
    const { files, ledger } = await translateTs("def f(word):\n    return {c for c in word}\n");
    const module = files.get("mod.ts")!;
    expect(module).toContain("__ctrans_iter(word)");
    const entry = ledger.find((item) => item.rule === "py.setcomp→js.Set(map)");
    expect(entry?.decision).toBe("semantic");
  });

  it("warns when container methods are emitted verbatim (method registry arrives in M5)", async () => {
    const { ledger } = await translateTs(
      "def f(xs: list[int]):\n    xs.append(1)\n    return xs\n",
    );
    const append = ledger.find((item) => item.targetSummary === "xs.append(1)");
    expect(append?.decision).toBe("deterministic");
    expect(append?.warnings).toContain("CTW-METHOD-UNMAPPED");
  });

  // End-to-end: translation + strict S2 (a full tsc program) + execution — needs a
  // generous wall clock under coverage instrumentation.
  it("translates and executes the audited workflow with Python-equivalent results", async () => {
    const source = [
      "def workflow(n, word):",
      "    a, b = 0, 1",
      "    i = 0",
      "    while i < n:",
      "        a, b = b, a + b",
      "        i += 1",
      "    if n % 2 == 0:",
      '        label = "even"',
      "    else:",
      '        label = "odd"',
      "    letters = {c for c in word}",
      "    counts = {}",
      '    counts["seen"] = len(letters)',
      '    return a, label, counts["seen"]',
      "",
    ].join("\n");
    const { files } = await translateTs(source);
    // The generated module must pass strict S2 as well as execute correctly.
    const { OracleTypeValidator } = await import("@ctrans/parser-js");
    const typeValidator = new OracleTypeValidator();
    const s2 = await typeValidator.validate(
      [...files.entries()]
        .filter(([path]) => path.endsWith(".ts"))
        .map(([path, content]) => ({ path, content })),
    );
    expect(s2.status, s2.details.join("; ")).toBe("pass");
    const dir = join(import.meta.dirname, ".tmp-lowering-regressions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mod.ts"), files.get("mod.ts")!);
    writeFileSync(join(dir, "__ctrans_runtime.ts"), files.get("__ctrans_runtime.ts")!);
    try {
      const generated = (await import(join(dir, "mod.ts"))) as {
        workflow: (n: number, word: string) => [number, string, number];
      };
      expect(generated.workflow(7, "banana")).toEqual([13, "odd", 3]);
      expect(generated.workflow(8, "hello")).toEqual([21, "even", 4]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
