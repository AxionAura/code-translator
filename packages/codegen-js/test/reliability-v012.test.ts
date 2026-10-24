// v0.1.2 reliability regressions (forward directions). These tests are written
// before the fixes: number-mode zero-to-negative-power, runtime-integer risk
// disclosure, and unresolved-call provenance must be honest and executable.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@axion-ct/core";
import { createPythonBridgeParser, type PythonBridgeParser } from "@axion-ct/parser-py";
import { createRegistryLookup } from "@axion-ct/registry";
import { createPyToJsTranslator, type PyToJsTranslator } from "../src/index.js";
import { renderRuntime } from "../src/translator.js";
import { helperClosure, RUNTIME_HELPERS } from "../src/helpers.js";

let py: PythonBridgeParser;
let numberTs: PyToJsTranslator;
let numberJs: PyToJsTranslator;
let bigintTs: PyToJsTranslator;

beforeAll(async () => {
  py = await createPythonBridgeParser();
  numberTs = await createPyToJsTranslator("typescript", { registry: createRegistryLookup() });
  numberJs = await createPyToJsTranslator("javascript", { registry: createRegistryLookup() });
  bigintTs = await createPyToJsTranslator("typescript", {
    registry: createRegistryLookup(),
    intMode: "bigint",
  });
});

async function translate(
  translator: PyToJsTranslator,
  source: string,
): Promise<{
  files: Map<string, string>;
  ledger: Awaited<ReturnType<PyToJsTranslator["translateUnit"]>>["ledger"];
}> {
  const filename = "mod.py";
  const parseResult = await py.parse(source, { filename });
  const unit = { filename, parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename, parseResult }]);
  const emission = await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits();
  const files = new Map<string, string>();
  for (const file of [...emission.files, ...shared.files]) files.set(file.targetPath, file.content);
  return { files, ledger: emission.ledger };
}

function materialize(files: ReadonlyMap<string, string>, directory: string): string {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  for (const [path, content] of files) writeFileSync(join(directory, path), content, "utf8");
  return directory;
}

async function importModule(directory: string, path: string): Promise<Record<string, unknown>> {
  return (await import(join(directory, path))) as Record<string, unknown>;
}

describe("v0.1.2 forward numeric reliability", () => {
  it("executes number-mode zero-to-negative-power as Python's ZeroDivisionError", async () => {
    const source = [
      "def zero_int():",
      "    return 0 ** -1",
      "",
      "def zero_float():",
      "    return 0.0 ** -1",
      "",
      "def negative_zero_float():",
      "    return (-0.0) ** -1",
      "",
      "def positive_control():",
      "    return 2 ** -2",
      "",
    ].join("\n");
    const directory = materialize(
      (await translate(numberTs, source)).files,
      join(import.meta.dirname, ".tmp-reliability-forward-ts"),
    );
    try {
      const mod = await importModule(directory, "mod.ts");
      const zeroInt = mod["zero_int"] as () => number;
      const zeroFloat = mod["zero_float"] as () => number;
      const negativeZeroFloat = mod["negative_zero_float"] as () => number;
      const positiveControl = mod["positive_control"] as () => number;

      for (const operation of [zeroInt, zeroFloat, negativeZeroFloat]) {
        let error: unknown;
        try {
          operation();
        } catch (caught) {
          error = caught;
        }
        expect(error, "expected generated code to throw").toBeInstanceOf(Error);
        expect((error as Error).name).toBe("ZeroDivisionError");
      }
      expect(positiveControl()).toBe(0.25);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the same zero-power exception in JavaScript output and bigint mode", async () => {
    const jsFiles = await translate(numberJs, "def zero():\n    return 0 ** -1\n");
    const jsDirectory = materialize(
      jsFiles.files,
      join(import.meta.dirname, ".tmp-reliability-forward-js"),
    );
    const bigFiles = await translate(bigintTs, "def zero():\n    return 0 ** -1\n");
    const bigDirectory = materialize(
      bigFiles.files,
      join(import.meta.dirname, ".tmp-reliability-forward-big"),
    );
    try {
      const jsMod = await importModule(jsDirectory, "mod.js");
      const bigMod = await importModule(bigDirectory, "mod.ts");
      expect(() => (jsMod["zero"] as () => number)()).toThrowError(
        expect.objectContaining({ name: "ZeroDivisionError" }),
      );
      expect(() => (bigMod["zero"] as () => bigint)()).toThrowError(
        expect.objectContaining({ name: "ZeroDivisionError" }),
      );
    } finally {
      rmSync(jsDirectory, { recursive: true, force: true });
      rmSync(bigDirectory, { recursive: true, force: true });
    }
  });

  it("makes the generated __ctrans_pow helper itself preserve the exception", async () => {
    const helpers = helperClosure(Object.keys(RUNTIME_HELPERS)).helpers;
    const directory = join(import.meta.dirname, ".tmp-reliability-runtime");
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "__ctrans_runtime.ts"),
      renderRuntime("typescript", helpers, true),
      "utf8",
    );
    try {
      const runtime = (await import(join(directory, "__ctrans_runtime.ts"))) as {
        __ctrans_pow: (base: unknown, exponent: unknown) => number;
      };
      for (const base of [0, 0.0, -0.0]) {
        expect(() => runtime.__ctrans_pow(base, -1)).toThrowError(
          expect.objectContaining({ name: "ZeroDivisionError" }),
        );
      }
      expect(runtime.__ctrans_pow(2, -2)).toBe(0.25);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("v0.1.2 runtime integer risk disclosure", () => {
  it("warns when an untyped runtime integer power cannot be proven safe", async () => {
    const { ledger } = await translate(numberTs, "def pow2(n):\n    return 2 ** n\n");
    const pow = ledger.find((entry) => entry.sourceKind === "py.BinOp(Pow)");
    expect(pow).toBeDefined();
    expect(pow?.decision).toBe("semantic");
    expect(pow?.warnings).toContain("CTW-NUM-INT-RUNTIME-UNCERTAIN");
  });

  it("does not warn for provable floats, safe constants, or bigint mode", async () => {
    const floatOperation = await translate(numberTs, "def scale(n: float):\n    return 2.0 ** n\n");
    const safeConstant = await translate(numberTs, "x = 2 ** 10\n");
    const exactBigint = await translate(bigintTs, "def pow2(n):\n    return 2 ** n\n");
    for (const { ledger } of [floatOperation, safeConstant, exactBigint]) {
      expect(ledger.some((entry) => entry.warnings.includes("CTW-NUM-INT-RUNTIME-UNCERTAIN"))).toBe(
        false,
      );
    }
  });

  it("preserves v0.1.1 constant-boundary behavior", async () => {
    const safe = await translate(numberTs, "x = 2 ** 53 - 1\n");
    const unsafe = await translate(numberTs, "x = 2 ** 53 + 1\n");
    expect(
      safe.ledger.some((entry) => entry.warnings.includes("CTW-NUM-INT-ARBITRARY-PRECISION")),
    ).toBe(false);
    expect(
      unsafe.ledger.some((entry) => entry.warnings.includes("CTW-NUM-INT-ARBITRARY-PRECISION")),
    ).toBe(true);
  });
});

describe("v0.1.2 unresolved-call provenance", () => {
  it("keeps a genuine same-unit forward reference deterministic and unwarned", async () => {
    const { ledger } = await translate(
      numberTs,
      "def first():\n    return second()\n\ndef second():\n    return 1\n",
    );
    const forward = ledger.find((entry) => entry.targetSummary === "second()");
    expect(forward?.decision).toBe("deterministic");
    expect(forward?.warnings).not.toContain("CTW-CALL-UNRESOLVED");
  });

  it("does not present a genuinely unresolved call as deterministic", async () => {
    const { files, ledger } = await translate(
      numberTs,
      "def caller():\n    return missing_function()\n",
    );
    const unresolved = ledger.find((entry) => entry.targetSummary === "missing_function()");
    expect(unresolved).toBeDefined();
    expect(unresolved?.decision).not.toBe("deterministic");
    expect(unresolved?.warnings).toContain("CTW-CALL-UNRESOLVED");
    expect(files.get("mod.ts")).toContain("missing_function()");
  });
});

describe("v0.1.2 generator version provenance", () => {
  it("uses the package version in generated module headers", async () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, "../package.json"), "utf8"),
    ) as {
      version: string;
    };
    const { files } = await translate(numberTs, "x = 1\n");
    expect(files.get("mod.ts")).toContain(`Generated by Code Translator ${manifest.version}`);
    expect(files.get("mod.ts")).not.toContain("Code Translator 0.0.0");
  });
});
