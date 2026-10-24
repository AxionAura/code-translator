// Round-trip property test (roadmap M7 WS H): Python → TypeScript (M4 pipeline)
// → Python (M7 codegen-py) on the supported subset. The round-tripped module
// executes in the sandbox next to the ORIGINAL Python source with the same call
// harness — the JSON results must match. Both sides must EXIT SUCCESSFULLY with
// non-empty output: an empty-vs-empty comparison proves nothing. The workload
// uses real Python list/loop semantics (append/len/for) so the SOURCE side
// executes natively; known-lossy constructs are excluded by construction.
import { detectCapabilities, SandboxRunner } from "@axion-ct/sandbox";
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph, type AnalyzedUnit } from "@axion-ct/core";
import { createPythonBridgeParser, type PythonBridgeParser } from "@axion-ct/parser-py";
import { createOxcJsParser, type OxcJsParser } from "@axion-ct/parser-js";
import { createPyToJsTranslator } from "@axion-ct/codegen-js";
import { createJsToPyTranslator } from "@axion-ct/codegen-py";

// The round-trip workload: constructs BOTH directions support with matching
// semantics (dynamic arithmetic, conditionals, counting loops, list append/len,
// string upper/slice, classes with constructor/methods).
const WORKLOAD_PY = `
def stats(values):
    total = 0
    for value in values:
        total = total + value
    return {"total": total, "count": len(values), "first": values[0]}


def classify(items):
    doubled = []
    for item in items:
        doubled.append(item * 2)
    big = []
    for item in doubled:
        if item > 10:
            big.append(item)
    big.append(len(doubled))
    return big


def label(name, count):
    if count == 1:
        suffix = "item"
    else:
        suffix = "items"
    return name + ": " + str(count) + " " + suffix


class Accumulator:
    def __init__(self, base):
        self.total = base

    def add(self, amount):
        self.total = self.total + amount
        return self.total


def word_ops(text):
    return [text.upper(), text[1:3]]


def remain(value):
    return [value % 7, -value % 7]
`;

const CASES_PY = [
  "stats([3, 5, 8])",
  "classify([1, 6, 9])",
  "label('box', 3)",
  "str(Accumulator(4).add(6))",
  "word_ops('a,b,c')",
  "remain(-9)",
];

let py: PythonBridgeParser;
let js: OxcJsParser;
let capabilities: Awaited<ReturnType<typeof detectCapabilities>>;

beforeAll(async () => {
  py = await createPythonBridgeParser();
  js = await createOxcJsParser();
  capabilities = await detectCapabilities();
});

async function runInSandbox(
  files: Readonly<Record<string, string>>,
  argv: readonly string[],
): Promise<string> {
  const runner = new SandboxRunner({ capabilities });
  const result = await runner.run({
    argv: [...argv],
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    timeoutMs: 60000,
    stdoutCapBytes: 1024 * 1024,
    stderrCapBytes: 1024 * 1024,
  });
  if (result.outcome !== "completed") {
    throw new Error(`sandbox run ${result.outcome}: ${result.stderr.slice(0, 300)}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `process exited ${String(result.exitCode)} (${argv.join(" ")}): ${result.stderr.slice(0, 2000)}`,
    );
  }
  const stdout = result.stdout.trim();
  if (stdout === "") {
    throw new Error(
      `process produced no output (${argv.join(" ")}); empty stdout cannot count as agreement`,
    );
  }
  return stdout;
}

function harnessPy(moduleName: string): string {
  return [
    "import json",
    `from ${moduleName} import *`,
    "results = []",
    ...CASES_PY.map((entry) => `results.append(${entry})`),
    "print(json.dumps(results))",
  ].join("\n");
}

describe("round-trip: Python → TypeScript → Python (roadmap M7 WS H)", () => {
  it("preserves observable behavior on the doubly-supported subset", async () => {
    // Leg 1: Python → TypeScript (M4).
    const pyParse = await py.parse(WORKLOAD_PY, { filename: "workload.py" });
    const unit: AnalyzedUnit = {
      filename: "workload.py",
      parseResult: pyParse,
      model: analyzeModule(pyParse),
    };
    const pyGraph = buildModuleGraph([{ filename: "workload.py", parseResult: pyParse }]);
    const tsTranslator = await createPyToJsTranslator("typescript");
    await tsTranslator.translateUnit(unit, pyGraph);
    const tsFiles = new Map<string, string>();
    for (const file of (await tsTranslator.finalizeUnits()).files)
      tsFiles.set(file.targetPath, file.content);
    const tsSource = tsFiles.get("workload.ts")!;

    // Leg 2: TypeScript → Python (M7). The TS parse MUST succeed for the leg to
    // be valid — a forward-emission bug surfaces here as a parse failure.
    const tsParse = await js.parse(tsSource, { filename: "workload.ts", language: "typescript" });
    expect(tsParse.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const tsUnit: AnalyzedUnit = {
      filename: "workload.ts",
      parseResult: tsParse,
      model: analyzeModule(tsParse),
    };
    const tsGraph = buildModuleGraph([{ filename: "workload.ts", parseResult: tsParse }]);
    const pyTranslator = createJsToPyTranslator();
    await pyTranslator.translateUnit(tsUnit, tsGraph);
    const pyFiles = new Map<string, string>();
    for (const file of (await pyTranslator.finalizeUnits()).files)
      pyFiles.set(file.targetPath, file.content);
    const roundTripped = pyFiles.get("workload.py")!;
    const runtimePy = pyFiles.get("__ctrans_runtime.py")!;

    // Original Python (source side) in the sandbox.
    const sourceOut = await runInSandbox(
      { "harness.py": harnessPy("workload"), "workload.py": WORKLOAD_PY },
      ["python3", "harness.py"],
    );
    // Round-tripped Python (target side) in the sandbox.
    const targetOut = await runInSandbox(
      {
        "harness.py": harnessPy("workload"),
        "workload.py": roundTripped,
        "__ctrans_runtime.py": runtimePy,
      },
      ["python3", "harness.py"],
    );
    expect(targetOut).toBe(sourceOut);
  }, 240000);

  // Audit round-2 F1 regression: comparisons (`<`), exponentiation (`**`),
  // range(), sum(), and print() all lower to codegen-js helpers whose names
  // leg 2 imports — every imported bridge name must be defined and executed.
  it("preserves behavior across the runtime-bridge helper surface (compare/pow/range/sum/print)", async () => {
    const BRIDGE_WORKLOAD = `
def below(limit, values):
    total = 0
    for v in values:
        if v < limit:
            total = total + v ** 2
    return total


def squares(n):
    out = []
    for i in range(n):
        out.append(i * i)
    print("squares", sum(out))
    return out


def describe(label, values):
    total = sum(values)
    return label + ": " + str(total / 4)
`;
    const BRIDGE_CASES = ["below(10, [1, 9, 4])", "squares(4)", "describe('n', [2, 6])"];
    const bridgeHarness = (moduleName: string): string =>
      [
        "import json",
        `from ${moduleName} import *`,
        "results = []",
        ...BRIDGE_CASES.map((entry) => `results.append(${entry})`),
        "print(json.dumps(results, separators=(',', ':')))",
      ].join("\n");

    const pyParse = await py.parse(BRIDGE_WORKLOAD, { filename: "workload.py" });
    const unit: AnalyzedUnit = {
      filename: "workload.py",
      parseResult: pyParse,
      model: analyzeModule(pyParse),
    };
    const pyGraph = buildModuleGraph([{ filename: "workload.py", parseResult: pyParse }]);
    const tsTranslator = await createPyToJsTranslator("typescript");
    await tsTranslator.translateUnit(unit, pyGraph);
    const tsFiles = new Map<string, string>();
    for (const file of (await tsTranslator.finalizeUnits()).files)
      tsFiles.set(file.targetPath, file.content);
    const tsSource = tsFiles.get("workload.ts")!;
    const tsParse = await js.parse(tsSource, { filename: "workload.ts", language: "typescript" });
    expect(tsParse.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const tsUnit: AnalyzedUnit = {
      filename: "workload.ts",
      parseResult: tsParse,
      model: analyzeModule(tsParse),
    };
    const tsGraph = buildModuleGraph([{ filename: "workload.ts", parseResult: tsParse }]);
    const pyTranslator = createJsToPyTranslator();
    await pyTranslator.translateUnit(tsUnit, tsGraph);
    const pyFiles = new Map<string, string>();
    for (const file of (await pyTranslator.finalizeUnits()).files)
      pyFiles.set(file.targetPath, file.content);
    const roundTripped = pyFiles.get("workload.py")!;
    const runtimePy = pyFiles.get("__ctrans_runtime.py")!;

    // Source side. print() inside squares() writes to stdout on both sides, so
    // the comparison covers printed output too, not just return values.
    const sourceOut = await runInSandbox(
      { "harness.py": bridgeHarness("workload"), "workload.py": BRIDGE_WORKLOAD },
      ["python3", "harness.py"],
    );
    const targetOut = await runInSandbox(
      {
        "harness.py": bridgeHarness("workload"),
        "workload.py": roundTripped,
        "__ctrans_runtime.py": runtimePy,
      },
      ["python3", "harness.py"],
    );
    expect(targetOut).toBe(sourceOut);
  }, 240000);
});
