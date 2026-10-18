// M5 string semantics (WS B) and Python float formatting (WS D): the runtime
// helpers must reproduce Python's observable behavior for code-point strings and
// float str() — verified by executing the generated runtime and comparing against
// the Python reference outputs recorded inline.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { renderRuntime } from "../src/translator.js";
import { helperClosure, RUNTIME_HELPERS } from "../src/helpers.js";

const TS_DIR = join(import.meta.dirname, ".tmp-m5-runtime-ts");

interface RuntimeModule {
  __ctrans_len: (v: unknown) => number;
  __ctrans_index: (v: unknown, k: unknown) => unknown;
  __ctrans_lt: (a: unknown, b: unknown) => boolean;
  __ctrans_lte: (a: unknown, b: unknown) => boolean;
  __ctrans_gt: (a: unknown, b: unknown) => boolean;
  __ctrans_str: (v: unknown) => string;
  __ctrans_floatStr: (v: number) => string;
  __ctrans_slice: <T>(v: T, s?: unknown, e?: unknown, st?: unknown) => unknown;
  __ctrans_iter: (v: unknown) => unknown[];
}

beforeAll(() => {
  const allHelpers = helperClosure(Object.keys(RUNTIME_HELPERS)).helpers;
  mkdirSync(TS_DIR, { recursive: true });
  writeFileSync(join(TS_DIR, "__ctrans_runtime.ts"), renderRuntime("typescript", allHelpers, true));
});

afterAll(() => {
  rmSync(TS_DIR, { recursive: true, force: true });
});

const loadRuntime = async (): Promise<RuntimeModule> =>
  import(join(TS_DIR, "__ctrans_runtime.ts")) as unknown as Promise<RuntimeModule>;

describe("WS B: code-point string semantics", () => {
  // Python reference: len("a😀b𠮷c") == 5 (UTF-16 .length would be 7);
  // "a😀b𠮷c"[2] == "b" (UTF-16 [] yields a lone surrogate); s[-1] == "c";
  // "😀" < "€" is False in Python (U+1F600 > U+20AC) but True under UTF-16 units;
  // "a" < "A" is False (code points: 'a' = U+0061 > 'A' = U+0041);
  // "a😀b𠮷c"[1:4] == "😀b𠮷".
  it("measures string length in code points", async () => {
    const runtime = await loadRuntime();
    expect(runtime.__ctrans_len("a😀b𠮷c")).toBe(5);
    expect(runtime.__ctrans_len("")).toBe(0);
    expect(runtime.__ctrans_len("héllo")).toBe(5);
    expect(runtime.__ctrans_len([1, 2, 3])).toBe(3);
  });

  it("indexes strings by code point including negative indices", async () => {
    const runtime = await loadRuntime();
    expect(runtime.__ctrans_index("a😀b𠮷c", 2)).toBe("b");
    expect(runtime.__ctrans_index("a😀b𠮷c", 1)).toBe("😀");
    expect(runtime.__ctrans_index("a😀b𠮷c", -1)).toBe("c");
    expect(() => runtime.__ctrans_index("abc", 3)).toThrow("index out of range");
  });

  it("compares strings by code point order", async () => {
    const runtime = await loadRuntime();
    expect(runtime.__ctrans_lt("😀", "€")).toBe(false); // UTF-16 units would say true
    expect(runtime.__ctrans_lt("a", "A")).toBe(false);
    expect(runtime.__ctrans_lt("A", "a")).toBe(true);
    expect(runtime.__ctrans_lte("abc", "abd")).toBe(true);
    expect(runtime.__ctrans_gt("abd", "abc")).toBe(true);
    // Prefix ordering: shorter string is less.
    expect(runtime.__ctrans_lt("ab", "abc")).toBe(true);
  });

  it("slices by code points (existing slice helper semantics)", async () => {
    const runtime = await loadRuntime();
    expect(runtime.__ctrans_slice("a😀b𠮷c", 1, 4)).toBe("😀b𠮷");
  });
});

describe("WS D: Python float str()", () => {
  it("matches Python repr for the characterized value set", async () => {
    const runtime = await loadRuntime();
    const cases: ReadonlyArray<[number, string]> = [
      [100.0, "100.0"],
      [-0.0, "-0.0"],
      [0.0, "0.0"],
      [0.1, "0.1"],
      [1e16, "1e+16"],
      [1e15, "1000000000000000.0"],
      [1e21, "1e+21"],
      [1e-4, "0.0001"],
      [1e-5, "1e-05"],
      [1.5e-7, "1.5e-07"],
      [1e-300, "1e-300"],
      [1.5e300, "1.5e+300"],
      [2.5, "2.5"],
      [-2.5, "-2.5"],
      [123456789.123, "123456789.123"],
      [5e-324, "5e-324"],
      [1.7976931348623157e308, "1.7976931348623157e+308"],
      [3.141592653589793, "3.141592653589793"],
      [0.1 + 0.2, "0.30000000000000004"],
    ];
    for (const [value, expected] of cases) {
      expect(runtime.__ctrans_floatStr(value), String(value)).toBe(expected);
    }
    expect(runtime.__ctrans_floatStr(Number.NaN)).toBe("nan");
    expect(runtime.__ctrans_floatStr(Number.POSITIVE_INFINITY)).toBe("inf");
    expect(runtime.__ctrans_floatStr(Number.NEGATIVE_INFINITY)).toBe("-inf");
  });

  it("applies Python spellings through str() and f-string interpolation", async () => {
    const runtime = await loadRuntime();
    // Python: str(True) = "True", str(None) = "None", str(0.1) = "0.1",
    // str(100.0) = "100.0" at float-typed sites (number-mode limitation: dynamic
    // integral numbers print int-like — documented).
    expect(runtime.__ctrans_str(true)).toBe("True");
    expect(runtime.__ctrans_str(undefined)).toBe("None");
    expect(runtime.__ctrans_str(0.1)).toBe("0.1");
    expect(runtime.__ctrans_str(1.5e-7)).toBe("1.5e-07");
    expect(runtime.__ctrans_str(100)).toBe("100");
  });
});
