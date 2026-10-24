// Reverse-direction execution regressions (audit round 2, findings F2/F3/F4):
// translated modules execute under `@axion-ct/sandbox` next to the executed JS
// source with identical harnesses; both sides must exit 0 with non-empty
// stdout (an empty-vs-empty comparison proves nothing). Covers super-call
// argument forwarding, instance-method dispatch on constructed class
// instances, callback arity for array-method helpers, and the preserved
// dict/list/string method routing.
import { detectCapabilities, SandboxRunner } from "@axion-ct/sandbox";
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph, type AnalyzedUnit } from "@axion-ct/core";
import { createOxcJsParser, type OxcJsParser } from "@axion-ct/parser-js";
import { createJsToPyTranslator } from "../src/index.js";

let js: OxcJsParser;
let capabilities: Awaited<ReturnType<typeof detectCapabilities>>;

beforeAll(async () => {
  js = await createOxcJsParser();
  capabilities = await detectCapabilities();
});

async function translateFiles(source: string): Promise<Map<string, string>> {
  const parseResult = await js.parse(source, { filename: "mod.js", language: "javascript" });
  const unit: AnalyzedUnit = { filename: "mod.js", parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename: "mod.js", parseResult }]);
  const translator = createJsToPyTranslator();
  const emission = await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits!();
  const files = new Map<string, string>();
  for (const file of [...emission.files, ...shared.files]) files.set(file.targetPath, file.content);
  return files;
}

async function runInSandbox(
  argv: readonly string[],
  filesInput: Readonly<Record<string, string>>,
): Promise<string> {
  const runner = new SandboxRunner({ capabilities });
  const result = await runner.run({
    argv: [...argv],
    files: Object.entries(filesInput).map(([path, content]) => ({ path, content })),
    timeoutMs: 60000,
    stdoutCapBytes: 1024 * 1024,
    stderrCapBytes: 1024 * 1024,
    requireNetworkIsolation: true,
  });
  if (result.outcome !== "completed") {
    throw new Error(`sandbox run ${result.outcome}: ${result.stderr.slice(0, 300)}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `process exited ${String(result.exitCode)} (${argv.join(" ")}): ${result.stderr.slice(0, 1200)}`,
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

interface DifferentialCase {
  readonly expression: string;
  readonly python: string;
}

// Source JS and generated Python execute the same call harness; JSON results
// must match byte-for-byte (compact separators on the Python side).
async function differential(source: string, cases: readonly DifferentialCase[]): Promise<void> {
  const files = await translateFiles(source);
  const harnessJsText = [
    'import * as mod from "./mod.js";',
    "const results = [];",
    ...cases.map((entry) => `results.push(${entry.expression});`),
    "console.log(JSON.stringify(results));",
  ].join("\n");
  const harnessPyText = [
    "import json",
    "from mod import *",
    "results = []",
    ...cases.map((entry) => `results.append(${entry.python})`),
    "print(json.dumps(results, separators=(',', ':')))",
  ].join("\n");
  const sourceOut = await runInSandbox(["node", "harness.mjs"], {
    "harness.mjs": harnessJsText,
    "mod.js": source,
  });
  const targetFiles: Record<string, string> = { "harness.py": harnessPyText };
  for (const [path, content] of files) targetFiles[path] = content;
  const targetOut = await runInSandbox(["python3", "harness.py"], targetFiles);
  expect(targetOut).toBe(sourceOut);
}

describe("reverse execution: super-call arguments (F2)", () => {
  it("forwards constructor arguments to the base initializer", async () => {
    await differential(
      [
        "export class Shape {",
        "  constructor(n) { this.n = n; }",
        "  double() { return this.n * 2; }",
        "}",
        "export class Sq extends Shape {",
        "  constructor(n) { super(n); }",
        "  area() { return this.n * this.n; }",
        "}",
      ].join("\n"),
      [
        { expression: "String(new mod.Sq(21).double())", python: "str(Sq(21).double())" },
        { expression: "String(new mod.Sq(4).area())", python: "str(Sq(4).area())" },
        { expression: "String(new mod.Shape(5).double())", python: "str(Shape(5).double())" },
      ],
    );
  }, 180000);
});

describe("reverse execution: instance method dispatch (F3)", () => {
  it("constructs instances, calls methods, and reads instance state from translated code", async () => {
    await differential(
      [
        "export class Acc {",
        "  constructor(base) { this.total = base; }",
        "  add(v) { this.total = this.total + v; return this.total; }",
        "  snapshot() { return this.total; }",
        "}",
        "export function useAcc(base, v) {",
        "  const a = new Acc(base);",
        "  const first = a.add(v);",
        "  return [first, a.snapshot(), a.total];",
        "}",
      ].join("\n"),
      [
        {
          expression: "JSON.stringify(mod.useAcc(4, 6))",
          python: "json.dumps(useAcc(4, 6), separators=(',', ':'))",
        },
      ],
    );
  }, 180000);

  it("keeps dict, list, and string method routing intact", async () => {
    await differential(
      [
        "export function routing(values, text, mapping) {",
        "  const joined = values.join('-');",
        "  const upper = text.toUpperCase();",
        "  const has = 'k' in mapping;",
        "  const keys = Object.keys(mapping);",
        "  return [joined, upper, has, keys, values.length];",
        "}",
      ].join("\n"),
      [
        {
          expression: "JSON.stringify(mod.routing([1, 2, 3], 'ab', { k: 1, j: 2 }))",
          python: "json.dumps(routing([1, 2, 3], 'ab', {'k': 1, 'j': 2}), separators=(',', ':'))",
        },
      ],
    );
  }, 180000);
});

describe("reverse execution: array-method callback arity (F4)", () => {
  it("delivers one, two, and three map callback parameters like JS", async () => {
    await differential(
      [
        "export function map1(xs) { return xs.map((x) => x * 2); }",
        "export function map2(xs) { return xs.map((x, i) => x + i); }",
        "export function map3(xs) { return xs.map((x, i, a) => x + i + a.length); }",
      ].join("\n"),
      [
        {
          expression: "JSON.stringify(mod.map1([10, 20]))",
          python: "json.dumps(map1([10, 20]), separators=(',', ':'))",
        },
        {
          expression: "JSON.stringify(mod.map2([10, 20]))",
          python: "json.dumps(map2([10, 20]), separators=(',', ':'))",
        },
        {
          expression: "JSON.stringify(mod.map3([10, 20]))",
          python: "json.dumps(map3([10, 20]), separators=(',', ':'))",
        },
      ],
    );
  }, 180000);

  it("delivers two-, three-, and four-parameter reduce callbacks like JS", async () => {
    await differential(
      [
        "export function reduce2(xs) { return xs.reduce((sum, x) => sum + x, 100); }",
        "export function reduce3(xs) { return xs.reduce((sum, x, i) => sum + x + i, 0); }",
        "export function reduce4(xs) { return xs.reduce((sum, x, i, a) => sum + x + i + a.length, 0); }",
        "export function filter1(xs) { return xs.filter((x) => x > 1); }",
        "export function find2(xs) { return xs.find((x, i) => i > 0); }",
      ].join("\n"),
      [
        { expression: "String(mod.reduce2([1, 2, 3]))", python: "str(reduce2([1, 2, 3]))" },
        { expression: "String(mod.reduce3([1, 2, 3]))", python: "str(reduce3([1, 2, 3]))" },
        { expression: "String(mod.reduce4([1, 2, 3]))", python: "str(reduce4([1, 2, 3]))" },
        {
          expression: "JSON.stringify(mod.filter1([1, 2, 3]))",
          python: "json.dumps(filter1([1, 2, 3]), separators=(',', ':'))",
        },
        { expression: "String(mod.find2([5, 6, 7]))", python: "str(find2([5, 6, 7]))" },
      ],
    );
  }, 180000);
});
