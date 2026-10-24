// v0.1.2 reliability regressions (JS/TS → Python). Written before implementation:
// reverse Math/discrete numeric mappings must import consistently, preserve tested
// JavaScript scalar behavior, map a narrow console subset, and carry accurate
// provenance for unknown calls.
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@axion-ct/core";
import { createOxcJsParser, type OxcJsParser } from "@axion-ct/parser-js";
import { createJsToPyTranslator } from "../src/index.js";
import { renderPyRuntime } from "../src/helpers.js";

let js: OxcJsParser;

beforeAll(async () => {
  js = await createOxcJsParser();
});

async function emit(
  source: string,
  language: "javascript" | "typescript" = "javascript",
): Promise<{
  module: string;
  runtime: string;
  ledger: Awaited<ReturnType<ReturnType<typeof createJsToPyTranslator>["translateUnit"]>>["ledger"];
}> {
  const filename = language === "typescript" ? "mod.ts" : "mod.js";
  const parseResult = await js.parse(source, { filename, language });
  const unit = { filename, parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename, parseResult }]);
  const translator = createJsToPyTranslator();
  const emission = await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits!();
  const module = shared.files.find((file) => file.targetPath === "mod.py")?.content ?? "";
  const runtime =
    shared.files.find((file) => file.targetPath === "__ctrans_runtime.py")?.content ?? "";
  return { module, runtime, ledger: emission.ledger };
}

describe("v0.1.2 reverse Math reliability", () => {
  it("defines and imports the same Math dispatcher symbol", async () => {
    const { module, runtime } = await emit(
      "export function floorValue(value) {\n  return Math.floor(value);\n}\n",
    );
    expect(module).toContain("_ctrans_math_entry(");
    expect(module).toContain(
      "from .__ctrans_runtime import __ctrans_math_entry as _ctrans_math_entry",
    );
    expect(runtime).toContain("def __ctrans_math_entry(");
    expect(runtime).not.toContain("_ctrans_math_entry = _ctrans_math_call");
  });

  it("uses tested JavaScript edge semantics for Math operations", async () => {
    const { module } = await emit(
      [
        "export function powZero() {",
        "  return Math.pow(0, -1);",
        "}",
        "export function signNaN() {",
        "  return Math.sign(NaN);",
        "}",
        "export function logZero() {",
        "  return Math.log(0);",
        "}",
        "export function sqrtNegative() {",
        "  return Math.sqrt(-1);",
        "}",
      ].join("\n"),
    );
    expect(module).toContain("_ctrans_math_entry(");
    const pow = module.match(/_ctrans_math_entry\("pow",\s*([^)]*)\)/);
    const sign = module.match(/_ctrans_math_entry\("sign",\s*([^)]*)\)/);
    expect(pow?.[1]).toContain("0, -1");
    expect(sign?.[1]).toContain("_ctrans_nan(");
    expect(module).toContain('_ctrans_math_entry("log", 0)');
    expect(module).toContain('_ctrans_math_entry("sqrt", -1)');
  });
});

describe("v0.1.2 reverse numeric semantics", () => {
  it("routes division and remainder through JavaScript-semantics helpers", async () => {
    const { module, runtime } = await emit(
      "export function arithmetic(a, b) {\n  return [a / b, a % b];\n}\n",
    );
    expect(module).toContain("_ctrans_js_div(a, b)");
    expect(module).toContain("_ctrans_js_mod(a, b)");
    expect(runtime).toContain("def __ctrans_js_div(");
    expect(runtime).toContain("def __ctrans_js_mod(");
  });

  it("lowers NaN and Infinity to executable numeric constants", async () => {
    const { module } = await emit(
      "export function specials() {\n  return [NaN, Infinity, -Infinity];\n}\n",
    );
    expect(module).toContain("_ctrans_nan()");
    expect(module).toContain("_ctrans_infinity()");
    expect(module).toContain("-_ctrans_infinity()");
    expect(module).not.toMatch(/\bNaN\b/);
    expect(module).not.toMatch(/(?<!-)\bInfinity\b/);
  });

  it("maps Number() through a tested scalar conversion helper", async () => {
    const { module, runtime } = await emit(
      "export function convert(value) {\n  return Number(value);\n}\n",
    );
    expect(module).toContain("_ctrans_js_number(value)");
    expect(runtime).toContain("def __ctrans_js_number(");
  });

  it("maps loose equality through a JavaScript helper instead of Python ==", async () => {
    const { module, runtime } = await emit("export function loose(a, b) {\n  return a == b;\n}\n");
    expect(module).toContain("_ctrans_js_loose_eq(a, b)");
    expect(module).not.toMatch(/return\s+a\s*==\s*b/);
    expect(runtime).toContain("def __ctrans_js_loose_eq(");
  });
});

describe("v0.1.2 reverse console mapping", () => {
  it("maps the narrow console surface with one accurate ledger entry per call", async () => {
    const { module, runtime, ledger } = await emit(
      [
        "export function emitLogs(value) {",
        "  console.log('hello', value);",
        "  console.info('info', value);",
        "  console.warn('warn', value);",
        "  console.error('error', value);",
        "}",
      ].join("\n"),
    );
    expect(module).toContain(`_ctrans_console_log("hello", value)`);
    expect(module).toContain(`_ctrans_console_log("info", value)`);
    expect(module).toContain(`_ctrans_console_error("warn", value)`);
    expect(module).toContain(`_ctrans_console_error("error", value)`);
    expect(runtime).toContain("def __ctrans_console_log(");
    expect(runtime).toContain("def __ctrans_console_error(");

    const consoleEntries = ledger.filter((entry) => entry.sourceKind.startsWith("js.console."));
    expect(consoleEntries).toHaveLength(4);
    expect(consoleEntries.every((entry) => entry.decision === "semantic")).toBe(true);
    expect(ledger.filter((entry) => entry.sourceKind === "js.String.method")).toHaveLength(0);
  });
});

describe("v0.1.2 reverse call provenance", () => {
  it("gives a genuinely unresolved direct call honest ledger provenance", async () => {
    const { module, ledger } = await emit(
      "export function caller(value) {\n  return unknownGlobal(value);\n}\n",
    );
    expect(module).toContain("unknownGlobal(value)");
    const call = ledger.find((entry) => entry.sourceKind === "js.CallExpression");
    expect(call).toBeDefined();
    expect(call?.decision).not.toBe("deterministic");
    expect(call?.warnings).toContain("CTW-CALL-UNRESOLVED");
  });

  it("does not duplicate member-call provenance for an unknown receiver method", async () => {
    const { ledger } = await emit(
      "export function invoke(box) {\n  return box.unknownMethod(1);\n}\n",
    );
    const entries = ledger.filter((entry) => entry.sourceKind === "js.CallExpression");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.decision).not.toBe("deterministic");
  });
});

// D-029: runtime imports must resolve in package AND flat layouts, and any
// import of the runtime (named, default, or namespace) must emit the runtime
// file so the import resolves at all.
describe("v0.1.2 runtime import strategy", () => {
  it("binds a namespace import of the runtime to the module object and emits the runtime", async () => {
    const { module, runtime } = await emit(
      'import * as rt from "./__ctrans_runtime.js";\n\nexport function use() {\n  return rt;\n}\n',
    );
    expect(module).toContain("try:");
    expect(module).toContain("from . import __ctrans_runtime as rt");
    expect(module).toContain("except ImportError:");
    expect(module).toContain("import __ctrans_runtime as rt");
    expect(runtime).not.toBe("");
  });

  it("binds a default import of the runtime to the module object and emits the runtime", async () => {
    const { module, runtime } = await emit(
      'import rt from "./__ctrans_runtime.js";\n\nexport function use() {\n  return rt;\n}\n',
    );
    expect(module).toContain("try:");
    expect(module).toContain("from . import __ctrans_runtime as rt");
    expect(module).toContain("import __ctrans_runtime as rt");
    expect(runtime).not.toBe("");
  });

  it("renders the runtime without dying on unknown helper or bridge names", async () => {
    const runtime = renderPyRuntime(["nonexistent_helper"], ["__ctrans_not_a_bridge"]);
    expect(runtime).toContain("Generated by Code Translator");
    expect(runtime).not.toContain("nonexistent_helper");
    expect(runtime).not.toContain("__ctrans_not_a_bridge");
  });
});

// F-L2: JS console.* scans EVERY string-literal argument for printf-style
// directives, not just the first.
describe("v0.1.2 console directive scan", () => {
  it("warns when a directive appears in a non-first argument", async () => {
    const { ledger } = await emit(
      'export function emitLogs(value) {\n  console.log("count:", "%d items", value);\n}\n',
    );
    const consoleEntries = ledger.filter((entry) => entry.sourceKind.startsWith("js.console."));
    expect(consoleEntries).toHaveLength(1);
    expect(consoleEntries[0]?.warnings).toContain("CTW-CONSOLE-FORMAT-DIRECTIVE");
  });

  it("does not warn when no argument carries a directive", async () => {
    const { ledger } = await emit(
      'export function emitLogs(value) {\n  console.log("count:", value);\n}\n',
    );
    const consoleEntries = ledger.filter((entry) => entry.sourceKind.startsWith("js.console."));
    expect(consoleEntries[0]?.warnings).toEqual([]);
  });
});
