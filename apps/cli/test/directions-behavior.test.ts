// Reverse-direction behavior evidence (roadmap M7 WS H): for each new direction,
// the SOURCE and the GENERATED module execute under `@axion-ct/sandbox` with the
// same call harness, and their JSON results must match. Source JS and TS execute
// via node (TS through Node's own type stripping — the reference erasure);
// generated Python executes via python3; generated TS executes via node stripping.
// Nothing executes on the host outside the sandbox.
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
  await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits!();
  const files = new Map<string, string>();
  for (const file of [...(await translator.translateUnit(unit, graph)).files, ...shared.files]) {
    files.set(file.targetPath, file.content);
  }
  return files;
}

// Runs a file inside the sandbox and returns stdout.
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
  return result.stdout.trim();
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

function harnessPy(moduleName: string, cases: readonly HarnessCase[]): string {
  const body = cases.map((entry) => `results.append(${entry.python})`).join("\n");
  return [
    `import json`,
    `from ${moduleName} import *`,
    "results = []",
    body,
    "print(json.dumps(results))",
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

const WORKLOAD_CASES: readonly HarnessCase[] = [
  { expression: "mod.stats([3, 5, 8])", python: "stats([3, 5, 8])" },
  { expression: "mod.label('box', 3)", python: "label('box', 3)" },
  { expression: "mod.remain(-9)", python: "remain(-9)" },
  { expression: "mod.classify([1, 6, 9])", python: "classify([1, 6, 9])" },
  { expression: "String(new Accumulator(4).add(6))", python: "str(Accumulator(4).add(6))" },
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
    const targetOut = await runInSandbox(
      capabilities,
      {
        "harness.py": harnessPy("workload", WORKLOAD_CASES),
        ...(Object.fromEntries(
          [...files.entries()].map(([path, content]) => [path, content]),
        ) as Record<string, string>),
      },
      ["python3", "harness.py"],
      true,
    );
    expect(targetOut).toBe(sourceOut);
  }, 180000);

  it("TS → JS: source TS (Node-stripped) and generated JS agree on the workload", async () => {
    const workloadTs = WORKLOAD_JS.replace(/: (?!:)/g, "");
    // A typed variant exercises real erasure (annotations, as-casts).
    const typed = `export function typedArea(s: { w: number }): number {\n  const area: number = (s.w * s.w) as number;\n  return area;\n}\n${workloadTs}`;
    const files = await translate("ts-to-js", typed, "workload.ts");
    const harness = harnessJs("workload.js", [
      ...WORKLOAD_CASES,
      { expression: "String(mod.typedArea({ w: 7 }))", python: "str(typedArea({ 'w': 7 }))" },
    ]);
    const sourceOut = await runInSandbox(
      capabilities,
      { "harness.mjs": harness, "workload.ts": typed },
      // Node 24 executes TS by type stripping (D-022's reference erasure).
      [process.execPath, "--experimental-strip-types", "harness.mjs"],
      false,
    );
    const targetOut = await runInSandbox(
      capabilities,
      {
        "harness.mjs": harness,
        ...(Object.fromEntries(files.entries()) as Record<string, string>),
      },
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
    const targetOut = await runInSandbox(
      capabilities,
      {
        // The emitted TS executes through Node's type stripping (runtime-neutral
        // annotations + assertions are erased, so behavior must be identical).
        "harness.mjs": harness,
        "workload.ts": files.get("workload.ts")!,
      },
      [process.execPath, "--experimental-strip-types", "harness.mjs"],
      false,
    );
    expect(targetOut).toBe(sourceOut);
  }, 180000);
});
