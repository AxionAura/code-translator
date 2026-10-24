// Executed behavior regressions for the generated Python runtime helpers
// (F-H1/F-M1/F-M2 remediation). The generated __ctrans_runtime.py is materialized
// with a harness and executed inside @axion-ct/sandbox — never on the host — and
// both stdout and the process exit status are asserted. Results are rendered with
// repr() so int/float distinctions (2 vs 2.0) and NaN/Infinity spellings are
// directly visible, which JSON encoding would blur or reject.
import { detectCapabilities, SandboxRunner, type SandboxCapabilities } from "@axion-ct/sandbox";
import { beforeAll, describe, expect, it } from "vitest";

import { renderPyRuntime, RUNTIME_HELPERS } from "../src/helpers.js";

let capabilities: SandboxCapabilities;

beforeAll(async () => {
  capabilities = await detectCapabilities();
});

async function runHelperHarness(harnessBody: string): Promise<{ stdout: string; stderr: string }> {
  const runner = new SandboxRunner({ capabilities });
  const helpers = Object.keys(RUNTIME_HELPERS);
  const result = await runner.run({
    argv: ["python3", "harness.py"],
    files: [
      { path: "__ctrans_runtime.py", content: renderPyRuntime(helpers) },
      { path: "harness.py", content: harnessBody },
    ],
    timeoutMs: 60000,
    stdoutCapBytes: 1024 * 1024,
    stderrCapBytes: 1024 * 1024,
    requireNetworkIsolation: true,
  });
  if (result.outcome !== "completed") {
    throw new Error(`sandbox run ${result.outcome}: ${result.stderr.slice(0, 500)}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`harness exited ${String(result.exitCode)}: ${result.stderr.slice(0, 800)}`);
  }
  return { stdout: result.stdout.trim(), stderr: result.stderr };
}

// One repr(result) per line — Python repr distinguishes 2 from 2.0 and prints
// nan/inf/-inf exactly like the JS String() spellings the helpers must match.
function reprHarness(
  imports: readonly string[],
  expressions: readonly string[],
  options: { json?: boolean } = {},
): string {
  const lines = ["import json", `from __ctrans_runtime import ${imports.join(", ")}`];
  if (options.json) lines.push("import math");
  lines.push("results = []");
  for (const expression of expressions) lines.push(`results.append(${expression})`);
  lines.push(
    options.json
      ? `print(json.dumps(results).replace('NaN', 'nan').replace('Infinity', 'inf').replace('-Infinity', '-inf'))`
      : "print('\\n'.join(repr(result) for result in results))",
  );
  return lines.join("\n");
}

describe("__ctrans_js_mod executed semantics (F-H1)", () => {
  it("preserves integer results for integer operands (JS % truncates toward zero)", async () => {
    const { stdout } = await runHelperHarness(
      reprHarness(
        ["__ctrans_js_mod"],
        [
          "__ctrans_js_mod(5, 3)",
          "__ctrans_js_mod(-9, 7)",
          "__ctrans_js_mod(9, -7)",
          "__ctrans_js_mod(-9, -7)",
          "__ctrans_js_mod(7, 7)",
          "__ctrans_js_mod(0, 5)",
          "__ctrans_js_mod(-4, 2)",
        ],
      ),
    );
    // JS: 5%3=2, -9%7=-2, 9%-7=2, -9%-7=-2, 7%7=0, 0%5=0, -4%2=-0 (String: "0").
    expect(stdout.split("\n")).toEqual(["2", "-2", "2", "-2", "0", "0", "0"]);
  });

  it("keeps str() and JSON rendering free of float artifacts for int operands", async () => {
    const { stdout } = await runHelperHarness(
      [
        "import json",
        "from __ctrans_runtime import __ctrans_js_mod",
        "value = __ctrans_js_mod(-9, 7)",
        "print(str(value))",
        "print(json.dumps(value))",
        "print(json.dumps({'k': __ctrans_js_mod(5, 3)}))",
      ].join("\n"),
    );
    expect(stdout.split("\n")).toEqual(["-2", "-2", '{"k": 2}']);
  });

  it("preserves float semantics and the zero-divisor NaN", async () => {
    const { stdout } = await runHelperHarness(
      reprHarness(
        ["__ctrans_js_mod"],
        [
          "__ctrans_js_mod(5.5, 2.0)",
          "__ctrans_js_mod(-5.5, 2.0)",
          "__ctrans_js_mod(5, 0)",
          "__ctrans_js_mod(5.0, 0.0)",
          "__ctrans_js_mod(float('nan'), 2)",
          "__ctrans_js_mod(5, float('nan'))",
        ],
      ),
    );
    expect(stdout.split("\n")).toEqual(["1.5", "-1.5", "nan", "nan", "nan", "nan"]);
  });
});

describe("__ctrans_js_number executed semantics (F-M1)", () => {
  it("matches JS Number() on the documented string subset", async () => {
    const { stdout } = await runHelperHarness(
      reprHarness(
        ["__ctrans_js_number"],
        [
          "__ctrans_js_number('0X1F')",
          "__ctrans_js_number('0x1f')",
          "__ctrans_js_number('-0x1f')",
          "__ctrans_js_number('+0x10')",
          "__ctrans_js_number('0b101')",
          "__ctrans_js_number('-0b101')",
          "__ctrans_js_number('0o17')",
          "__ctrans_js_number('0o0')",
          "__ctrans_js_number('42')",
          "__ctrans_js_number(' 42 ')",
          "__ctrans_js_number('3.5')",
          "__ctrans_js_number('.5')",
          "__ctrans_js_number('5.')",
          "__ctrans_js_number('1e3')",
          "__ctrans_js_number('-1.5e-2')",
          "__ctrans_js_number('')",
          "__ctrans_js_number('  ')",
          "__ctrans_js_number('inf')",
          "__ctrans_js_number('INFINITY')",
          "__ctrans_js_number('1_0')",
          "__ctrans_js_number('12px')",
          "__ctrans_js_number('0x')",
          "__ctrans_js_number('-0x')",
          "__ctrans_js_number('1.2.3')",
        ],
      ),
    );
    expect(stdout.split("\n")).toEqual([
      "31",
      "31",
      "-31",
      "16",
      "5",
      "-5",
      "15",
      "0",
      "42",
      "42",
      "3.5",
      "0.5",
      "5",
      "1000",
      "-0.015",
      "0",
      "0",
      "nan",
      "nan",
      "nan",
      "nan",
      "nan",
      "nan",
      "nan",
    ]);
  });

  it("maps null, booleans, and numbers like JS Number()", async () => {
    const { stdout } = await runHelperHarness(
      reprHarness(
        ["__ctrans_js_number"],
        [
          "__ctrans_js_number(None)",
          "__ctrans_js_number(True)",
          "__ctrans_js_number(False)",
          "__ctrans_js_number(7)",
          "__ctrans_js_number(-2.5)",
          "__ctrans_js_number()",
        ],
      ),
    );
    expect(stdout.split("\n")).toEqual(["0", "1", "0", "7", "-2.5", "0"]);
  });
});

describe("__ctrans_js_div executed semantics (F-M2)", () => {
  it("preserves signed infinity for signed-zero divisors", async () => {
    const { stdout } = await runHelperHarness(
      reprHarness(
        ["__ctrans_js_div"],
        [
          "__ctrans_js_div(1, 0)",
          "__ctrans_js_div(1, -0.0)",
          "__ctrans_js_div(-1, 0)",
          "__ctrans_js_div(-1, -0.0)",
          "__ctrans_js_div(0, 0)",
          "__ctrans_js_div(0, -0.0)",
          "__ctrans_js_div(0.0, 0.0)",
        ],
      ),
    );
    // Python repr: inf/-inf; 0/-0 with zero numerators is NaN in JS.
    expect(stdout.split("\n")).toEqual(["inf", "-inf", "-inf", "inf", "nan", "nan", "nan"]);
  });

  it("keeps ordinary and non-finite division behavior", async () => {
    const { stdout } = await runHelperHarness(
      reprHarness(
        ["__ctrans_js_div"],
        [
          "__ctrans_js_div(10, 4)",
          "__ctrans_js_div(-10, 4)",
          "__ctrans_js_div(1, float('inf'))",
          "__ctrans_js_div(-1, float('inf'))",
          "__ctrans_js_div(float('inf'), 2)",
          "__ctrans_js_div(float('inf'), float('inf'))",
          "__ctrans_js_div(float('nan'), 2)",
        ],
      ),
    );
    expect(stdout.split("\n")).toEqual(["2.5", "-2.5", "0.0", "-0.0", "inf", "nan", "nan"]);
  });
});
