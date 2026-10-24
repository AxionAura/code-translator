// Reverse-direction behavior evidence (roadmap M7 WS H): for each new direction,
// the SOURCE and the GENERATED module execute under `@axion-ct/sandbox` with the
// same call harness, and their JSON results must match. Source JS and TS execute
// via node (TS through Node's own type stripping — the reference erasure);
// generated Python executes via python3; generated TS executes via node stripping.
// Both sides must EXIT SUCCESSFULLY with non-empty output: an empty-vs-empty
// comparison proves nothing, so exit codes and stdout are asserted separately.
import { detectCapabilities, SandboxRunner } from "@axion-ct/sandbox";
import { beforeAll, describe, expect, it } from "vitest";

import { createOxcJsParser, type OxcJsParser } from "@axion-ct/parser-js";
import { analyzeModule, buildModuleGraph, type AnalyzedUnit } from "@axion-ct/core";
import { createJsToPyTranslator } from "@axion-ct/codegen-py";
import { JsToTsTranslator, TsToJsTranslator } from "@axion-ct/codegen-js";

let js: OxcJsParser;

beforeAll(async () => {
  js = await createOxcJsParser();
});

async function translate(
  direction: "ts-to-js" | "js-to-ts" | "js-to-py",
  source: string,
  filename: string,
): Promise<Map<string, string>> {
  const language = filename.endsWith(".ts") ? "typescript" : "javascript";
  const parseResult = await js.parse(source, { filename, language });
  const unit: AnalyzedUnit = { filename, parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename, parseResult }]);
  const translator =
    direction === "ts-to-js"
      ? new TsToJsTranslator()
      : direction === "js-to-ts"
        ? new JsToTsTranslator()
        : createJsToPyTranslator();
  const emission = await translator.translateUnit(unit, graph);
  const files = new Map<string, string>();
  const shared = translator.finalizeUnits ? await translator.finalizeUnits() : null;
  for (const file of [...emission.files, ...(shared ? shared.files : [])]) {
    files.set(file.targetPath, file.content);
  }
  return files;
}

// Runs a file inside the sandbox; a crashing or silent process is a test
// failure, never an (empty === empty) equivalence.
async function runInSandbox(
  capabilities: Awaited<ReturnType<typeof detectCapabilities>>,
  files: Readonly<Record<string, string>>,
  argv: readonly string[],
  requireIsolation: boolean,
): Promise<string> {
  const runner = new SandboxRunner({ capabilities });
  const result = await runner.run({
    argv: [...argv],
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    timeoutMs: 60000,
    stdoutCapBytes: 1024 * 1024,
    stderrCapBytes: 1024 * 1024,
    ...(requireIsolation ? { requireNetworkIsolation: true } : {}),
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

// The shared call harness: every case calls one exported function with fixed
// arguments and stringifies the result. Identical on both sides (modulo syntax).
interface HarnessCase {
  readonly expression: string; // JS expression calling the export
  readonly python: string; // Python expression calling the same export
}

function harnessJs(moduleName: string, cases: readonly HarnessCase[]): string {
  const body = cases.map((entry) => `results.push(${entry.expression});`).join("\n");
  return [
    `import * as mod from "./${moduleName}";`,
    "const results = [];",
    body,
    "console.log(JSON.stringify(results));",
  ].join("\n");
}

// Python emits compact JSON (no spaces) so its output is byte-comparable with
// JSON.stringify; key order and int/float spellings stay part of the check.
function harnessPy(moduleName: string, cases: readonly HarnessCase[]): string {
  const body = cases.map((entry) => `results.append(${entry.python})`).join("\n");
  return [
    `import json`,
    `from ${moduleName} import *`,
    "results = []",
    body,
    "print(json.dumps(results, separators=(',', ':')))",
  ].join("\n");
}

const WORKLOAD_JS = `
export function stats(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return { total: total, count: values.length, first: values[0] };
}

export function label(name, count) {
  const suffix = count === 1 ? "item" : "items";
  return name + ": " + String(count) + " " + suffix;
}

export function remain(value) {
  return [value % 7, value % -7, -value % 7];
}

export function classify(items) {
  const doubled = items.map((x) => x * 2);
  const big = doubled.filter((x) => x > 10);
  big.push(doubled.length);
  return big;
}

export class Accumulator {
  total = 0;
  constructor(base) {
    this.total = base;
  }
  add(amount) {
    this.total += amount;
    return this.total;
  }
}

export function truthy(value) {
  if (value) {
    return "yes";
  }
  return "no";
}

export function wordOps(text) {
  return [text.toUpperCase(), text.slice(1, 3), text.split(",")];
}
`;

// A genuinely typed variant of the same workload for TS→JS: annotations,
// as-casts, and union types exercise real erasure on both sides.
const WORKLOAD_TS = `
export function stats(values: number[]): { total: number; count: number; first: number } {
  const total: number = values.reduce((sum: number, value: number): number => sum + value, 0);
  return { total: total, count: values.length, first: values[0] as number };
}

export function label(name: string, count: number): string {
  const suffix: string = count === 1 ? "item" : "items";
  return name + ": " + String(count) + " " + suffix;
}

export function remain(value: number): number[] {
  return [value % 7, value % -7, -value % 7];
}

export function classify(items: number[]): number[] {
  const doubled: number[] = items.map((x: number): number => x * 2);
  const big: number[] = doubled.filter((x: number): boolean => x > 10);
  big.push(doubled.length);
  return big;
}

export class Accumulator {
  total: number = 0;
  constructor(base: number) {
    this.total = base;
  }
  add(amount: number): number {
    this.total += amount;
    return this.total;
  }
}

export function truthy(value: number | string): string {
  if (value) {
    return "yes";
  }
  return "no";
}

export function wordOps(text: string): (string | string[])[] {
  return [text.toUpperCase(), text.slice(1, 3), text.split(",")];
}

export function typedArea(s: { w: number }): number {
  const area: number = (s.w * s.w) as number;
  return area;
}
`;

const WORKLOAD_CASES: readonly HarnessCase[] = [
  { expression: "mod.stats([3, 5, 8])", python: "stats([3, 5, 8])" },
  { expression: "mod.label('box', 3)", python: "label('box', 3)" },
  { expression: "mod.remain(-9)", python: "remain(-9)" },
  { expression: "mod.classify([1, 6, 9])", python: "classify([1, 6, 9])" },
  { expression: "String(new mod.Accumulator(4).add(6))", python: "str(Accumulator(4).add(6))" },
  {
    expression: "mod.truthy(0) + mod.truthy('') + mod.truthy(3)",
    python: "truthy(0) + truthy('') + truthy(3)",
  },
  { expression: "mod.wordOps('a,b,c')", python: "wordOps('a,b,c')" },
];

describe("reverse-direction behavior differentials (WS H)", () => {
  let capabilities: Awaited<ReturnType<typeof detectCapabilities>>;

  beforeAll(async () => {
    capabilities = await detectCapabilities();
  });

  it("JS → Python: source JS and generated Python agree on the workload", async () => {
    const files = await translate("js-to-py", WORKLOAD_JS, "workload.js");
    const sourceOut = await runInSandbox(
      capabilities,
      { "harness.mjs": harnessJs("workload.js", WORKLOAD_CASES), "workload.js": WORKLOAD_JS },
      [process.execPath, "harness.mjs"],
      false,
    );
    const targetFiles: Record<string, string> = {
      "harness.py": harnessPy("workload", WORKLOAD_CASES),
    };
    for (const [path, content] of files) targetFiles[path] = content;
    const targetOut = await runInSandbox(
      capabilities,
      targetFiles,
      ["python3", "harness.py"],
      true,
    );
    expect(targetOut).toBe(sourceOut);
  }, 180000);

  it("TS → JS: source TS (Node-stripped) and generated JS agree on the workload", async () => {
    const files = await translate("ts-to-js", WORKLOAD_TS, "workload.ts");
    const cases = [
      ...WORKLOAD_CASES,
      { expression: "String(mod.typedArea({ w: 7 }))", python: "str(typedArea({ 'w': 7 }))" },
    ];
    const sourceOut = await runInSandbox(
      capabilities,
      // The source harness imports the TS source; Node 24 executes it by type
      // stripping (D-022's reference erasure).
      { "harness.mjs": harnessJs("workload.ts", cases), "workload.ts": WORKLOAD_TS },
      [process.execPath, "--experimental-strip-types", "harness.mjs"],
      false,
    );
    const targetFiles: Record<string, string> = {
      // The generated tree contains workload.js, so the target harness imports
      // that module name.
      "harness.mjs": harnessJs("workload.js", cases),
    };
    for (const [path, content] of files) targetFiles[path] = content;
    const targetOut = await runInSandbox(
      capabilities,
      targetFiles,
      [process.execPath, "harness.mjs"],
      false,
    );
    expect(targetOut).toBe(sourceOut);
  }, 180000);

  it("JS → TS: emitted TS (Node-stripped) executes identically to the source JS", async () => {
    const files = await translate("js-to-ts", WORKLOAD_JS, "workload.js");
    const harness = harnessJs("workload.ts", WORKLOAD_CASES);
    const sourceOut = await runInSandbox(
      capabilities,
      { "harness.mjs": harnessJs("workload.js", WORKLOAD_CASES), "workload.js": WORKLOAD_JS },
      [process.execPath, "harness.mjs"],
      false,
    );
    const targetFiles: Record<string, string> = { "harness.mjs": harness };
    for (const [path, content] of files) targetFiles[path] = content;
    const targetOut = await runInSandbox(
      capabilities,
      targetFiles,
      // The emitted TS executes through Node's type stripping (runtime-neutral
      // annotations + assertions are erased, so behavior must be identical).
      [process.execPath, "--experimental-strip-types", "harness.mjs"],
      false,
    );
    expect(targetOut).toBe(sourceOut);
  }, 180000);
});
