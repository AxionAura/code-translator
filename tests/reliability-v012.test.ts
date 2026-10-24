// v0.1.2 reliability behavior regressions. Generated source/target code executes
// only through @axion-ct/sandbox. These tests compare observable output and error
// categories, not merely generated syntax.
import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph, runPipeline } from "@axion-ct/core";
import { createPyToJsTranslator } from "@axion-ct/codegen-js";
import { createJsToPyTranslator } from "@axion-ct/codegen-py";
import {
  createOxcJsParser,
  createOxcSyntaxValidator,
  OracleTypeValidator,
} from "@axion-ct/parser-js";
import { createPythonBridgeParser } from "@axion-ct/parser-py";
import { detectCapabilities, SandboxRunner, type SandboxCapabilities } from "@axion-ct/sandbox";

let capabilities: SandboxCapabilities;

beforeAll(async () => {
  capabilities = await detectCapabilities();
});

async function runSandbox(
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
    requireNetworkIsolation: true,
  });
  if (result.outcome !== "completed") {
    throw new Error(`sandbox run ${result.outcome}: ${result.stderr.slice(0, 500)}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `sandbox run exited ${String(result.exitCode)}: ${result.stderr.slice(0, 1000)}`,
    );
  }
  return result.stdout.trim();
}

async function translatePython(source: string): Promise<Map<string, string>> {
  const parser = await createPythonBridgeParser();
  const filename = "mod.py";
  const parseResult = await parser.parse(source, { filename });
  const translator = await createPyToJsTranslator("javascript");
  const unit = { filename, parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename, parseResult }]);
  const emission = await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits();
  const files = new Map<string, string>();
  for (const file of [...emission.files, ...shared.files]) files.set(file.targetPath, file.content);
  return files;
}

async function translateJavaScript(source: string): Promise<Map<string, string>> {
  const parser = await createOxcJsParser();
  const filename = "mod.js";
  const parseResult = await parser.parse(source, { filename, language: "javascript" });
  const translator = createJsToPyTranslator();
  const unit = { filename, parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename, parseResult }]);
  const emission = await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits();
  const files = new Map<string, string>();
  for (const file of [...emission.files, ...shared.files]) files.set(file.targetPath, file.content);
  return files;
}

function filesRecord(files: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries([...files.entries()]);
}

describe("v0.1.2 executable numeric behavior", () => {
  it("preserves Python zero-to-negative-power behavior in generated JavaScript", async () => {
    if (capabilities.networkIsolation !== "enforced") {
      console.log("[skip] enforced isolation unavailable; behavior assertion skipped");
      return;
    }
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
    const pythonHarness = [
      "from mod import zero_int, zero_float, negative_zero_float, positive_control",
      "for name, call in [('zero_int', zero_int), ('zero_float', zero_float), ('negative_zero_float', negative_zero_float), ('positive_control', positive_control)]:",
      "    try:",
      "        print(f'{name}:pass:{call()}')",
      "    except Exception as error:",
      "        print(f'{name}:error:{type(error).__name__}')",
    ].join("\n");
    const jsHarness = [
      'import { zero_int, zero_float, negative_zero_float, positive_control } from "./mod.js";',
      "const calls = [",
      '  ["zero_int", zero_int],',
      '  ["zero_float", zero_float],',
      '  ["negative_zero_float", negative_zero_float],',
      '  ["positive_control", positive_control],',
      "];",
      "for (const [name, call] of calls) {",
      "  try {",
      "    console.log(`${name}:pass:${String(call())}`);",
      "  } catch (error) {",
      "    console.log(`${name}:error:${error?.constructor?.name ?? 'Error'}`);",
      "  }",
      "}",
    ].join("\n");
    const generated = await translatePython(source);
    const expected = await runSandbox({ "mod.py": source, "harness.py": pythonHarness }, [
      "python3",
      "harness.py",
    ]);
    const actual = await runSandbox({ ...filesRecord(generated), "harness.mjs": jsHarness }, [
      process.execPath,
      "harness.mjs",
    ]);
    expect(actual).toBe(expected);
    expect(actual).toContain("zero_int:error:ZeroDivisionError");
    expect(actual).toContain("zero_float:error:ZeroDivisionError");
    expect(actual).toContain("negative_zero_float:error:ZeroDivisionError");
    expect(actual).toContain("positive_control:pass:0.25");
  }, 180000);

  it("preserves tested JavaScript numeric semantics in generated Python", async () => {
    if (capabilities.networkIsolation !== "enforced") {
      console.log("[skip] enforced isolation unavailable; behavior assertion skipped");
      return;
    }
    const source = [
      "export function div(a, b) {",
      "  return a / b;",
      "}",
      "export function rem(a, b) {",
      "  return a % b;",
      "}",
      "export function loose(a, b) {",
      "  return a == b;",
      "}",
      "export function numberNull() {",
      "  return Number(null);",
      "}",
      "export function constantNaN() {",
      "  return NaN;",
      "}",
      "export function constantInfinity() {",
      "  return Infinity;",
      "}",
      "export function mathPowZero() {",
      "  return Math.pow(0, -1);",
      "}",
      "export function mathSignNaN() {",
      "  return Math.sign(NaN);",
      "}",
      "export function mathLogZero() {",
      "  return Math.log(0);",
      "}",
      "export function mathSqrtNegative() {",
      "  return Math.sqrt(-1);",
      "}",
    ].join("\n");
    const jsHarness = [
      'import * as mod from "./mod.js";',
      "const values = [",
      "  mod.div(1, 0),",
      "  mod.div(-1, 0),",
      "  mod.div(0, 0),",
      "  mod.rem(1, 0),",
      '  mod.loose("", 0),',
      "  mod.numberNull(),",
      "  mod.constantNaN(),",
      "  mod.constantInfinity(),",
      "  mod.mathPowZero(),",
      "  mod.mathSignNaN(),",
      "  mod.mathLogZero(),",
      "  mod.mathSqrtNegative(),",
      "];",
      "console.log(values.map(String).join('\\n'));",
    ].join("\n");
    const pythonHarness = [
      "import math",
      "from pkg.mod import div, rem, loose, numberNull, constantNaN, constantInfinity, mathPowZero, mathSignNaN, mathLogZero, mathSqrtNegative",
      "values = [",
      "    div(1, 0),",
      "    div(-1, 0),",
      "    div(0, 0),",
      "    rem(1, 0),",
      '    loose("", 0),',
      "    numberNull(),",
      "    constantNaN(),",
      "    constantInfinity(),",
      "    mathPowZero(),",
      "    mathSignNaN(),",
      "    mathLogZero(),",
      "    mathSqrtNegative(),",
      "]",
      "def render(value):",
      "    if isinstance(value, bool):",
      "        return 'true' if value else 'false'",
      "    if isinstance(value, float) and math.isnan(value):",
      "        return 'NaN'",
      "    if value == math.inf:",
      "        return 'Infinity'",
      "    if value == -math.inf:",
      "        return '-Infinity'",
      "    return str(value)",
      "print('\\n'.join(render(value) for value in values))",
    ].join("\n");
    const generated = await translateJavaScript(source);
    const packageFiles: Record<string, string> = {
      "pkg/__init__.py": "",
      "harness.py": pythonHarness,
    };
    for (const [path, content] of generated) packageFiles[`pkg/${path}`] = content;
    const expected = await runSandbox({ "mod.js": source, "harness.mjs": jsHarness }, [
      process.execPath,
      "harness.mjs",
    ]);
    const actual = await runSandbox(packageFiles, ["python3", "harness.py"]);
    expect(actual).toBe(expected);
    expect(expected.split("\n")).toEqual([
      "Infinity",
      "-Infinity",
      "NaN",
      "NaN",
      "true",
      "0",
      "NaN",
      "Infinity",
      "Infinity",
      "NaN",
      "-Infinity",
      "NaN",
    ]);
  }, 180000);
});

describe("v0.1.2 console behavior", () => {
  it("maps basic console output and error streams", async () => {
    if (capabilities.networkIsolation !== "enforced") {
      console.log("[skip] enforced isolation unavailable; behavior assertion skipped");
      return;
    }
    const source = [
      "export function emit(value) {",
      "  console.log('hello', value);",
      "  console.info('info', value);",
      "  console.warn('warn', value);",
      "  console.error('error', value);",
      "}",
    ].join("\n");
    const jsHarness = 'import { emit } from "./mod.js";\nemit(42);\n';
    const pythonHarness = "from pkg.mod import emit\nemit(42)\n";
    const generated = await translateJavaScript(source);
    const packageFiles: Record<string, string> = {
      "pkg/__init__.py": "",
      "harness.py": pythonHarness,
    };
    for (const [path, content] of generated) packageFiles[`pkg/${path}`] = content;

    const runner = new SandboxRunner({ capabilities });
    const sourceResult = await runner.run({
      argv: [process.execPath, "harness.mjs"],
      files: [
        { path: "mod.js", content: source },
        { path: "harness.mjs", content: jsHarness },
      ],
      timeoutMs: 60000,
      stdoutCapBytes: 1024 * 1024,
      stderrCapBytes: 1024 * 1024,
      requireNetworkIsolation: true,
    });
    const targetResult = await runner.run({
      argv: ["python3", "harness.py"],
      files: Object.entries(packageFiles).map(([path, content]) => ({ path, content })),
      timeoutMs: 60000,
      stdoutCapBytes: 1024 * 1024,
      stderrCapBytes: 1024 * 1024,
      requireNetworkIsolation: true,
    });
    expect(sourceResult.outcome).toBe("completed");
    expect(targetResult.outcome).toBe("completed");
    expect(targetResult.stdout).toBe(sourceResult.stdout);
    expect(targetResult.stderr).toBe(sourceResult.stderr);
    expect(targetResult.stdout).toContain("hello 42");
    expect(targetResult.stdout).toContain("info 42");
    expect(targetResult.stderr).toContain("warn 42");
    expect(targetResult.stderr).toContain("error 42");
  }, 180000);
});

describe("v0.1.2 generator version consistency", () => {
  it("uses the same authoritative version in headers and reports", async () => {
    const cliManifest = JSON.parse(
      readFileSync(new URL("../apps/cli/package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const coreManifest = JSON.parse(
      readFileSync(new URL("../packages/core/package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(coreManifest.version).toBe(cliManifest.version);

    const parser = await createPythonBridgeParser();
    const filename = "mod.py";
    const parseResult = await parser.parse("x = 1\n", { filename });
    const target = "typescript";
    const result = await runPipeline(
      [{ filename, parseResult }],
      {
        target,
        intMode: "number",
        translateUnit: await createPyToJsTranslator(target),
        validateSyntax: await createOxcSyntaxValidator(),
        validateTypes: new OracleTypeValidator(),
      },
      {
        sourceImports: new Map([[filename, []]]),
        mappedModules: new Set(),
        unsupportedModules: new Set(),
      },
    );
    expect(result.report.generator.version).toBe(cliManifest.version);
    const module = result.emittedFiles.find((file) => file.targetPath.endsWith(".ts"));
    expect(module?.content).toContain(`Generated by Code Translator ${cliManifest.version}`);
  });
});
