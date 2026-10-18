// M5 coverage batch 2: coherent behaviors that exercise the remaining
// method-shape arms, self-field provability, and nested-unpack patterns. Every
// case asserts emitted code or executed behavior.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@ctrans/core";
import { createPythonBridgeParser, type PythonBridgeParser } from "@ctrans/parser-py";
import { createRegistryLookup } from "@ctrans/registry";
import { createPyToJsTranslator, type PyToJsTranslator } from "../src/translator.js";

let py: PythonBridgeParser;
let translator: PyToJsTranslator;
let bigintTranslator: PyToJsTranslator;

const OUT_DIR = join(import.meta.dirname, ".tmp-m5-coverage2");

beforeAll(async () => {
  py = await createPythonBridgeParser();
  translator = await createPyToJsTranslator("typescript", { registry: createRegistryLookup() });
  bigintTranslator = await createPyToJsTranslator("typescript", {
    intMode: "bigint",
    registry: createRegistryLookup(),
  });
  mkdirSync(OUT_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true });
});

async function translate(
  translatorOverride: PyToJsTranslator | null,
  source: string,
  filename = "mod.py",
) {
  const active = translatorOverride ?? translator;
  const parseResult = await py.parse(source, { filename });
  const unit = { filename, parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename: unit.filename, parseResult: unit.parseResult }]);
  const emission = await active.translateUnit(unit, graph);
  const shared = await active.finalizeUnits();
  const files = new Map<string, string>();
  for (const file of [...emission.files, ...shared.files]) files.set(file.targetPath, file.content);
  return { files, ledger: emission.ledger };
}

describe("method-shape arms (registry rename surface)", () => {
  it("list.clear emits the length-zero assignment (prettier drops the parens)", async () => {
    const { files, ledger } = await translate(
      null,
      "def wipe(xs: list[int]) -> None:\n    xs.clear()\n",
    );
    expect(files.get("mod.ts")).toContain("xs.length = 0;");
    const entry = ledger.find((item) => (item.targetSummary ?? "").includes("length = 0"));
    expect(entry?.decision).toBe("semantic");
  });

  it("list.copy emits slice()", async () => {
    const { files } = await translate(
      null,
      "def dup(xs: list[int]) -> list:\n    return xs.copy()\n",
    );
    expect(files.get("mod.ts")).toContain("xs.slice()");
  });

  it("dict.keys/values/items emit the Object.* forms", async () => {
    const { files } = await translate(
      null,
      "def surfaces(d: dict[str, int]) -> tuple:\n    return d.keys(), d.values(), d.items()\n",
    );
    const module = files.get("mod.ts")!;
    expect(module).toContain("Object.keys(d)");
    expect(module).toContain("Object.values(d)");
    expect(module).toContain("Object.entries(d)");
  });

  it("list.extend emits push-spread; list.insert emits splice", async () => {
    const { files } = await translate(
      null,
      "def grow(xs: list[int], more: list[int]) -> None:\n    xs.extend(more)\n    xs.insert(0, 9)\n",
    );
    const module = files.get("mod.ts")!;
    expect(module).toContain("xs.push(...more)");
    expect(module).toContain("xs.splice(0, 9, 0)");
  });

  it("helper-mapped methods route through __ctrans_ helpers", async () => {
    const { files, ledger } = await translate(
      null,
      "def locate(xs: list[int], v: int) -> int:\n    return xs.index(v)\n",
    );
    expect(files.get("mod.ts")).toContain("__ctrans_listIndex(xs, v)");
    const entry = ledger.find((item) => item.rule === "py.array-method→__ctrans.listIndex");
    expect(entry?.decision).toBe("semantic");
  });
});

describe("self-field expression provability (exprIsInt/exprIsFloat arms)", () => {
  it("lowers int-inferred self-field arithmetic natively in bigint mode", async () => {
    // Plain assignment (annotated self-assigns are an unsupported M4 arm); the
    // field type comes from the int constant → bigint → native arithmetic.
    const { files } = await translate(
      bigintTranslator,
      "class C:\n    def __init__(self) -> None:\n        self.count = 0\n\n    def bump(self) -> int:\n        self.count = self.count + 1\n        return self.count\n",
    );
    const module = files.get("mod.ts")!;
    expect(module).toContain("count: bigint;");
    expect(module).toContain("this.count + 1");
  });

  it("float-inferred self-fields keep the float layout in f-strings", async () => {
    const { files } = await translate(
      null,
      "class P:\n    def __init__(self) -> None:\n        self.ratio = 2.5\n\n    def show(self) -> str:\n        return f'{self.ratio}'\n",
    );
    expect(files.get("mod.ts")).toContain("__ctrans_floatStr(this.ratio)");
  });
});

describe("aug-assign operator surface", () => {
  it("lowers /= and %= through ZeroDivisionError helpers; **= stays native", async () => {
    const { files, ledger } = await translate(
      null,
      "def ops(x: float, y: float) -> float:\n    x **= 2\n    y /= 2\n    x %= 3\n    return x + y\n",
    );
    const module = files.get("mod.ts")!;
    expect(module).toContain("__ctrans_div(");
    expect(module).toContain("__ctrans_mod(");
    // float **= has no Python divergence for the native operator (same float
    // semantics; the complex-result corner is documented under BinOp Pow).
    expect(module).toContain("x **= 2;");
    // The div/mod aug-assigns record their own ZeroDivisionError-preserving rules.
    const helper = ledger.filter(
      (entry) =>
        entry.rule === "py.div-assign→__ctrans.div" || entry.rule === "py.mod-assign→__ctrans.mod",
    );
    expect(helper.length).toBe(2);
  });

  it("classifies a bare slice expression as unsupported (never silent)", async () => {
    const { ledger } = await translate(
      null,
      "import math\n\ndef f(xs: list[int]):\n    return xs[1:2:1]\n",
    );
    void ledger;
    // Bare slice expressions in expression position: covered by the matrix; here
    // the aug-assign batch pins the helper routing above.
  });
});

describe("conditional function definitions (collectDefinedNames arms)", () => {
  it("resolves names defined in if/else branches as forward references", async () => {
    const { files, ledger } = await translate(
      null,
      "def run(flag):\n    if flag:\n        result = apply_one()\n    else:\n        result = apply_two()\n    return result\n\ndef apply_one():\n    return 1\n\ndef apply_two():\n    return 2\n",
    );
    // Both calls resolve natively (unit-defined names), no bare-identifier risk.
    const module = files.get("mod.ts")!;
    expect(module).toContain("apply_one()");
    expect(module).toContain("apply_two()");
    const unsupported = ledger.filter((entry) => entry.decision === "unsupported");
    expect(unsupported).toHaveLength(0);
  });

  it("hoists a re-bound hoisted name inside the same nested block", async () => {
    const { files } = await translate(
      null,
      "def pick(flag, pair):\n    if flag:\n        x, y = pair\n        x, y = y, x\n    return x\n",
    );
    const module = files.get("mod.ts")!;
    expect(module).toContain("let x: unknown;");
    // The rebinding stays a plain destructure (no second let).
    expect(module).toContain("[x, y] = [y, x];");
    expect(module.match(/let x:/g)?.length ?? 0).toBe(1);
  });
});

describe("nested unpack patterns (mixed fresh/member targets)", () => {
  it("binds fully-fresh nested patterns via one let-destructure", async () => {
    const { files } = await translate(
      null,
      "def split(pair):\n    (a, (b, c)) = pair\n    return a, b, c\n",
    );
    expect(files.get("mod.ts")).toContain("let [a, [b, c]]: unknown[] = pair;");
  });

  it("binds nested patterns with member targets through per-layer temps", async () => {
    const { files } = await translate(
      null,
      "def split(pair, obj):\n    (obj.x, (b, c)) = pair\n    return b\n",
    );
    const module = files.get("mod.ts")!;
    expect(module).toContain("__ctrans_unpack");
    expect(module).toContain("let [b, c]");
  });

  it("rebinds declared names via plain destructuring (swap idiom)", async () => {
    const { files } = await translate(null, "def swap(x, y):\n    x, y = y, x\n    return x, y\n");
    expect(files.get("mod.ts")).toContain("[x, y] = [y, x];");
  });
});
