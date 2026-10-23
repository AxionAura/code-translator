// Regression coverage for P0 integer precision safety (D-006). These tests assert
// semantic classification and warnings, not merely that some output is emitted:
// number mode must not present a constant integer computation as deterministic when
// float64 cannot preserve its exact value. Bigint mode remains exact.
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@axion-ct/core";
import { createPythonBridgeParser, type PythonBridgeParser } from "@axion-ct/parser-py";
import { createPyToJsTranslator, type PyToJsTranslator } from "../src/translator.js";

const PRECISION = "CTW-NUM-INT-ARBITRARY-PRECISION";

let py: PythonBridgeParser;
let numberTs: PyToJsTranslator;
let numberJs: PyToJsTranslator;
let bigintTs: PyToJsTranslator;
let bigintJs: PyToJsTranslator;

beforeAll(async () => {
  py = await createPythonBridgeParser();
  numberTs = await createPyToJsTranslator("typescript", { intMode: "number" });
  numberJs = await createPyToJsTranslator("javascript", { intMode: "number" });
  bigintTs = await createPyToJsTranslator("typescript", { intMode: "bigint" });
  bigintJs = await createPyToJsTranslator("javascript", { intMode: "bigint" });
});

async function translate(
  translator: PyToJsTranslator,
  target: "typescript" | "javascript",
  source: string,
): Promise<{
  module: string;
  ledger: Awaited<ReturnType<PyToJsTranslator["translateUnit"]>>["ledger"];
}> {
  const filename = "mod.py";
  const parseResult = await py.parse(source, { filename });
  const unit = { filename, parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename, parseResult }]);
  const emission = await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits();
  const targetPath = target === "typescript" ? "mod.ts" : "mod.js";
  const module = [...emission.files, ...shared.files]
    .filter((file) => file.targetPath === targetPath)
    .at(-1)?.content;
  if (module === undefined) throw new Error(`missing ${targetPath}`);
  return { module, ledger: emission.ledger };
}

function precisionEntries(
  ledger: Awaited<ReturnType<PyToJsTranslator["translateUnit"]>>["ledger"],
) {
  return ledger.filter((entry) => entry.warnings.includes(PRECISION));
}

describe("P0 integer precision in number mode", () => {
  for (const [label, translator, target] of [
    ["TypeScript", () => numberTs, "typescript"],
    ["JavaScript", () => numberJs, "javascript"],
  ] as const) {
    it(`warns and classifies 2 ** 100 as semantic for ${label}`, async () => {
      const { module, ledger } = await translate(translator(), target, "x = 2 ** 100\n");
      expect(module).toContain("2 ** 100");
      expect(precisionEntries(ledger).length).toBeGreaterThan(0);
      const pow = ledger.find((entry) => entry.sourceKind === "py.BinOp(Pow)");
      expect(pow?.decision).toBe("semantic");
      expect(pow?.warnings).toContain(PRECISION);
    });

    it(`does not warn for the safe 2 ** 53 - 1 boundary for ${label}`, async () => {
      const { ledger } = await translate(translator(), target, "x = 2 ** 53 - 1\n");
      expect(precisionEntries(ledger)).toHaveLength(0);
      expect(ledger.every((entry) => entry.decision === "deterministic")).toBe(true);
    });
  }

  it("warns for composed constant arithmetic and unary negation", async () => {
    const cases = [
      "x = 2 ** 53 + 1\n",
      "x = 2 ** 53 - 1 + 1\n",
      "x = 2 ** 53 * 2\n",
      "x = -(2 ** 100)\n",
      "x = 9007199254740993 + 1\n",
    ];
    for (const source of cases) {
      const { ledger } = await translate(numberTs, "typescript", source);
      expect(precisionEntries(ledger).length, source).toBeGreaterThan(0);
      expect(
        ledger.some((entry) => entry.decision === "semantic"),
        source,
      ).toBe(true);
    }
  });

  it("handles the negative safe-integer boundary", async () => {
    const atMinSafe = await translate(numberTs, "typescript", "x = -(2 ** 53) + 1\n");
    expect(precisionEntries(atMinSafe.ledger)).toHaveLength(0);
    const belowMinSafe = await translate(numberTs, "typescript", "x = -(2 ** 53) - 1\n");
    expect(precisionEntries(belowMinSafe.ledger).length).toBeGreaterThan(0);
  });

  it("warns for unsafe constant floor-division and modulo but not safe negatives", async () => {
    for (const source of ["x = (2 ** 100) // 3\n", "x = (2 ** 100 + 1) % 3\n"]) {
      const { ledger } = await translate(numberTs, "typescript", source);
      expect(precisionEntries(ledger).length, source).toBeGreaterThan(0);
    }
    for (const source of ["x = (-7) // 3\n", "x = (-7) % 3\n"]) {
      const { ledger } = await translate(numberTs, "typescript", source);
      expect(precisionEntries(ledger), source).toHaveLength(0);
    }
  });

  it("does not warn for a negative exponent (Python produces a float)", async () => {
    const { ledger } = await translate(numberTs, "typescript", "x = 2 ** -1\n");
    expect(precisionEntries(ledger)).toHaveLength(0);
  });

  it("warns for a very large exponent without materializing it", async () => {
    const { ledger } = await translate(numberTs, "typescript", "x = 2 ** 100001\n");
    expect(precisionEntries(ledger).length).toBeGreaterThan(0);
  });

  it("warns at 2 ** 53 itself but not at 2 ** 53 - 2", async () => {
    const atBoundary = await translate(numberTs, "typescript", "x = 2 ** 53\n");
    expect(precisionEntries(atBoundary.ledger).length).toBeGreaterThan(0);
    const belowBoundary = await translate(numberTs, "typescript", "x = 2 ** 53 - 2\n");
    expect(precisionEntries(belowBoundary.ledger)).toHaveLength(0);
    expect(belowBoundary.ledger.every((entry) => entry.decision === "deterministic")).toBe(true);
  });

  it("warns for a large integer literal itself", async () => {
    const { ledger } = await translate(numberTs, "typescript", "x = 9007199254740993\n");
    expect(precisionEntries(ledger).length).toBeGreaterThan(0);
    expect(ledger.find((entry) => entry.rule === "py.int→js.number")?.decision).toBe("semantic");
  });

  it("analyzes hex integer constants containing the letter e", async () => {
    const { ledger } = await translate(numberTs, "typescript", "x = 0x1e2 ** 100\n");
    expect(precisionEntries(ledger).length).toBeGreaterThan(0);
    expect(ledger.some((entry) => entry.decision === "semantic")).toBe(true);
  });

  it("does not misclassify an integral float literal as an integer", async () => {
    const { ledger } = await translate(numberTs, "typescript", "x = 2.0 ** 100\n");
    expect(precisionEntries(ledger)).toHaveLength(0);
    expect(ledger.every((entry) => entry.decision === "deterministic")).toBe(true);
  });

  it("does not warn for small arithmetic or safe results", async () => {
    for (const source of ["x = 1 + 2\n", "x = (2 ** 10) * 3\n", "x = 2 ** 53 - 1\n"]) {
      const { ledger } = await translate(numberTs, "typescript", source);
      expect(precisionEntries(ledger), source).toHaveLength(0);
    }
  });

  it("leaves an unprovable runtime exponent semantic rather than deterministic", async () => {
    const { ledger } = await translate(numberTs, "typescript", "def pow2(n):\n    return 2 ** n\n");
    const pow = ledger.find((entry) => entry.sourceKind === "py.BinOp(Pow)");
    expect(pow?.rule).toBe("py.pow→__ctrans.pow");
    expect(pow?.decision).toBe("semantic");
    expect(pow?.warnings).not.toContain(PRECISION);
  });
});

describe("P0 integer precision in bigint mode", () => {
  it("keeps an integral float literal as a JS number, not bigint", async () => {
    const { module, ledger } = await translate(bigintTs, "typescript", "x = 2.0\n");
    expect(module).toContain("export let x = 2;");
    expect(module).not.toContain("2n");
    expect(ledger.find((entry) => entry.rule === "py.float→js.number")?.decision).toBe(
      "deterministic",
    );
  });

  it("does not infer an integral float binding as bigint", async () => {
    const { module } = await translate(bigintTs, "typescript", "x = 2.0\ny = x + 1\n");
    expect(module).not.toContain("x + 1n");
    expect(module).toContain("__ctrans_toFloat(1n)");
  });

  for (const [label, translator, target] of [
    ["TypeScript", () => bigintTs, "typescript"],
    ["JavaScript", () => bigintJs, "javascript"],
  ] as const) {
    it(`keeps 2 ** 100 exact, deterministic, and unwarned for ${label}`, async () => {
      const { module, ledger } = await translate(translator(), target, "x = 2 ** 100\n");
      expect(module).toContain("2n ** 100n");
      expect(precisionEntries(ledger)).toHaveLength(0);
      const pow = ledger.find((entry) => entry.sourceKind === "py.BinOp(Pow)");
      expect(pow?.decision).toBe("deterministic");
    });
  }
});
