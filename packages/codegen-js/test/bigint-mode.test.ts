// D-006 bigint mode (intMode=bigint): Python ints lower to JS bigint literals and
// bigint-annotated parameters; arithmetic on provable ints emits native bigint
// operators; int/float mixes cross the documented Number boundary; `/` always
// produces a Python float. Behavior is pinned by executing generated programs and
// comparing against Python's observable results (see the reference outputs inline).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@ctrans/core";
import { createPythonBridgeParser, type PythonBridgeParser } from "@ctrans/parser-py";
import { createRegistryLookup } from "@ctrans/registry";
import { createPyToJsTranslator, type PyToJsTranslator } from "../src/translator.js";

let py: PythonBridgeParser;
let tsTranslator: PyToJsTranslator;
let jsTranslator: PyToJsTranslator;

beforeAll(async () => {
  py = await createPythonBridgeParser();
  tsTranslator = await createPyToJsTranslator("typescript", { intMode: "bigint" });
  jsTranslator = await createPyToJsTranslator("javascript", { intMode: "bigint" });
});

async function translate(
  translator: PyToJsTranslator,
  target: "typescript" | "javascript",
  source: string,
  filename = "mod.py",
): Promise<{
  files: Map<string, string>;
  ledger: Awaited<ReturnType<PyToJsTranslator["translateUnit"]>>["ledger"];
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

const EXT = ".ts";

describe("intMode=bigint: emission", () => {
  it("emits integer literals as bigint literals with deterministic provenance", async () => {
    const { files, ledger } = await translate(
      tsTranslator,
      "typescript",
      "x = 42\nbig = 12345678901234567890123456789\n",
    );
    const module = files.get(`mod${EXT}`)!;
    expect(module).toContain("export let x = 42n;");
    expect(module).toContain("export let big = 12345678901234567890123456789n;");
    const entry = ledger.find((item) => item.rule === "py.int→js.bigint");
    expect(entry?.decision).toBe("deterministic");
  });

  it("maps int annotations to bigint (parameters, returns, fields) without precision warnings", async () => {
    const { files, ledger } = await translate(
      tsTranslator,
      "typescript",
      "def add(a: int, b: int) -> int:\n    return a + b\n",
    );
    const module = files.get(`mod${EXT}`)!;
    expect(module).toContain("function add(a: bigint, b: bigint): bigint");
    expect(module).toContain("return a + b;");
    const precision = ledger.filter((item) =>
      item.warnings.includes("CTW-NUM-INT-ARBITRARY-PRECISION"),
    );
    expect(precision).toHaveLength(0);
  });

  it("keeps float literals as numbers and true division through the helper", async () => {
    const { files } = await translate(
      tsTranslator,
      "typescript",
      "def ratio(a: int, b: int) -> float:\n    return a / b\n",
    );
    const module = files.get(`mod${EXT}`)!;
    expect(module).toContain("function ratio(a: bigint, b: bigint): number");
    expect(module).toContain("__ctrans_div(a, b)");
  });

  it("warns and converts across the documented Number boundary for int/float mixes", async () => {
    const { files, ledger } = await translate(
      tsTranslator,
      "typescript",
      "def blend(a: int, f: float) -> float:\n    return a + f\n",
    );
    const module = files.get(`mod${EXT}`)!;
    expect(module).toContain("__ctrans_toFloat(a) + f");
    const entry = ledger.find((item) => item.rule === "py.add-mixed→js.float-boundary");
    expect(entry?.decision).toBe("semantic");
    expect(entry?.warnings).toContain("CTW-NUM-BIGINT-FLOAT-BOUNDARY");
  });

  it("emits exact native bitwise operators for provable ints (no int32 warning)", async () => {
    const { files, ledger } = await translate(
      tsTranslator,
      "typescript",
      "def bits(a: int, b: int) -> int:\n    return (a | b) & (a ^ b)\n",
    );
    const module = files.get(`mod${EXT}`)!;
    expect(module).toContain("(a | b) & (a ^ b);");
    const bitwise = ledger.filter((item) => item.warnings.includes("CTW-NUM-BITWISE"));
    expect(bitwise).toHaveLength(0);
  });

  it("keeps unary minus native for provable int operands", async () => {
    const { files } = await translate(
      await createPyToJsTranslator("typescript", { intMode: "bigint" }),
      "typescript",
      "def negate(a: int) -> int:\n    return -a\n",
    );
    expect(files.get("mod.ts")).toContain("return -a;"); // prettier strips redundant parens
  });

  it("routes range and int() through bigint helpers in bigint mode", async () => {
    // An UNANNOTATED n cannot prove the C-style bounds, so range materializes
    // through the bigint helper; annotated bounds use the exact C-style counter.
    const { files } = await translate(
      tsTranslator,
      "typescript",
      "def total(n) -> int:\n    t = 0\n    for i in range(n):\n        t = t + i\n    return int(t)\n",
    );
    const module = files.get(`mod${EXT}`)!;
    expect(module).toContain("__ctrans_rangeBig(n)");
    expect(module).toContain("__ctrans_toIntBig(t)");
  });

  it("JavaScript targets emit bigint literals with no type annotations", async () => {
    const { files } = await translate(
      jsTranslator,
      "javascript",
      "x = 42\n\ndef add(a, b):\n    return a + b\n",
    );
    const module = files.get("mod.js")!;
    expect(module).toContain("export let x = 42n;");
    expect(module).not.toContain(": bigint");
  });
});

describe("intMode=bigint: executed behavior vs Python", () => {
  // Python reference (3.14): fib(200) = 280571172992510140037611932413038677189525;
  // floor_mod(-7,3) = [-3,2,-21,-10,-4]; 2**100 = 1267650600228229401496703205376;
  // (3*10**25)//7 = 4285714285714285714285714; (-10**25)//7 = -1428571428571428571428572.
  const workflow = [
    "def fib(n: int) -> int:",
    "    a, b = 0, 1",
    "    i = 0",
    "    while i < n:",
    "        a, b = b, a + b",
    "        i += 1",
    "    return a",
    "",
    "def floor_mod(a: int, b: int) -> list:",
    "    return [a // b, a % b]",
    "",
    "def scaled(x: int, y: int) -> int:",
    "    return (x * 10 ** 25) // y",
    "",
    "def bits(a: int, b: int) -> int:",
    "    return (a | b) & (a ^ b)",
    "",
    "def str_big(v: int) -> str:",
    '    return f"value={v}"',
    "",
  ].join("\n");

  it("executes the generated TypeScript with Python-identical results", async () => {
    const { files } = await translate(tsTranslator, "typescript", workflow);
    // Strict S2 must pass in bigint mode (bigint arithmetic is natively sound).
    const { OracleTypeValidator: Validator } = await import("@ctrans/parser-js");
    const s2 = await new Validator().validate(
      [...files.entries()]
        .filter(([path]) => path.endsWith(".ts"))
        .map(([path, content]) => ({ path, content })),
    );
    expect(s2.status, s2.details.join("; ")).toBe("pass");
    const dir = join(import.meta.dirname, ".tmp-bigint-ts");
    mkdirSync(dir, { recursive: true });
    for (const [path, content] of files) writeFileSync(join(dir, path), content);
    try {
      const generated = (await import(join(dir, "mod.ts"))) as {
        fib: (n: number | bigint) => bigint;
        floor_mod: (a: number | bigint, b: number | bigint) => bigint[];
        scaled: (x: number | bigint, y: number | bigint) => bigint;
        bits: (a: number | bigint, b: number | bigint) => bigint;
        str_big: (v: number | bigint) => string;
      };
      expect(generated.fib(200n)).toBe(280571172992510140037611932413038677189525n);
      expect(generated.floor_mod(-7n, 3n)).toEqual([-3n, 2n]);
      expect(generated.floor_mod(7n, -3n)).toEqual([-3n, -2n]);
      expect(generated.scaled(3n, 7n)).toBe(4285714285714285714285714n);
      expect(generated.bits(10n ** 30n, 6n)).toBe(1000000000000000000000000000006n);
      expect(generated.str_big(2n ** 100n)).toBe("value=1267650600228229401496703205376");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("executes the generated JavaScript (type-stripped runtime) identically", async () => {
    const { files } = await translate(jsTranslator, "javascript", workflow);
    const { createOxcSyntaxValidator: makeValidator } = await import("@ctrans/parser-js");
    const s1 = await makeValidator().then((validator) =>
      validator.validate(
        [...files.entries()].map(([path, content]) => ({
          path,
          content,
          language: "javascript" as const,
        })),
      ),
    );
    expect(s1.status, s1.details.join("; ")).toBe("pass");
    const dir = join(import.meta.dirname, ".tmp-bigint-js");
    mkdirSync(dir, { recursive: true });
    for (const [path, content] of files) writeFileSync(join(dir, path), content);
    try {
      const generated = (await import(join(dir, "mod.js"))) as {
        fib: (n: number | bigint) => bigint;
        scaled: (x: number | bigint, y: number | bigint) => bigint;
      };
      expect(generated.fib(200n)).toBe(280571172992510140037611932413038677189525n);
      expect(generated.scaled(3n, 7n)).toBe(4285714285714285714285714n);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps Python true division a float for bigint operands", async () => {
    const { files } = await translate(
      tsTranslator,
      "typescript",
      "def ratio(a: int, b: int):\n    return a / b\n",
    );
    const dir = join(import.meta.dirname, ".tmp-bigint-div");
    mkdirSync(dir, { recursive: true });
    for (const [path, content] of files) writeFileSync(join(dir, path), content);
    try {
      const generated = (await import(join(dir, "mod.ts"))) as {
        ratio: (a: number | bigint, b: number | bigint) => number;
      };
      expect(generated.ratio(10n, 2n)).toBe(5); // Python: 5.0 (a float, not bigint 5n)
      expect(typeof generated.ratio(10n, 2n)).toBe("number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves default number-mode behavior and warnings alongside bigint mode", async () => {
    const numberMode = await translate(
      await createPyToJsTranslator("typescript", { registry: createRegistryLookup() }),
      "typescript",
      "def add(a: int, b: int) -> int:\n    return a + b\n",
    );
    const module = numberMode.files.get(`mod${EXT}`)!;
    expect(module).toContain("function add(a: number, b: number): number");
    const precision = numberMode.ledger.filter((item) =>
      item.warnings.includes("CTW-NUM-INT-ARBITRARY-PRECISION"),
    );
    expect(precision.length).toBeGreaterThan(0);
  });

  it("runs the S1 validator on bigint-mode TypeScript output", async () => {
    const { files } = await translate(tsTranslator, "typescript", "x = 2 ** 64\n");
    const { createOxcSyntaxValidator: makeValidator } = await import("@ctrans/parser-js");
    const s1 = await makeValidator().then((validator) =>
      validator.validate(
        [...files.entries()].map(([path, content]) => ({
          path,
          content,
          language: "typescript" as const,
        })),
      ),
    );
    expect(s1.status).toBe("pass");
  });
});
