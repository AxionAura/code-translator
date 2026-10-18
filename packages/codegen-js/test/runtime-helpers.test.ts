// Runtime helper semantics (D-016/D-022): the emitted __ctrans_runtime module must
// reproduce Python behavior for the divergences it wraps — asserted by executing the
// generated runtime (TypeScript and the type-stripped JavaScript variant) and probing
// Python-divergent edges (floor division signs, NaN truthiness, code-point iteration,
// KeyError/IndexError surfaces, class-vs-function construction).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { renderRuntime } from "../src/translator.js";
import { helperClosure, RUNTIME_HELPERS } from "../src/helpers.js";

// Generated under the package tree so vitest's module graph can import them.
const TS_DIR = join(import.meta.dirname, ".tmp-runtime-ts");
const JS_DIR = join(import.meta.dirname, ".tmp-runtime-js");

interface RuntimeModule {
  __ctrans_floorDiv: (a: number, b: number) => number;
  __ctrans_mod: (a: number, b: number) => number;
  __ctrans_truthy: (v: unknown) => boolean;
  __ctrans_eq: (a: unknown, b: unknown) => boolean;
  __ctrans_contains: (c: unknown, i: unknown) => boolean;
  __ctrans_slice: <T>(v: T, s?: unknown, e?: unknown, st?: unknown) => unknown;
  __ctrans_index: (v: unknown, k: unknown) => unknown;
  __ctrans_toInt: (v: unknown) => number;
  __ctrans_str: (v: unknown) => string;
  __ctrans_print: (...args: unknown[]) => void;
  __ctrans_range: (...args: unknown[]) => number[];
  __ctrans_add: (a: unknown, b: unknown) => unknown;
  __ctrans_iter: (v: unknown) => unknown[];
  __ctrans_call: (fn: unknown, ...args: unknown[]) => unknown;
  __ctrans_callMethod: (receiver: unknown, name: string, ...args: unknown[]) => unknown;
  __ctrans_getattr: (o: unknown, n: string) => unknown;
  __ctrans_setattr: (o: unknown, n: string, v: unknown) => void;
  __ctrans_lt: (a: unknown, b: unknown) => boolean;
}

beforeAll(() => {
  // The FULL helper closure: a translated unit's runtime only contains its own
  // required subset; these assertions pin the complete set's behavior.
  const allHelpers = helperClosure(Object.keys(RUNTIME_HELPERS)).helpers;
  mkdirSync(TS_DIR, { recursive: true });
  mkdirSync(JS_DIR, { recursive: true });
  writeFileSync(join(TS_DIR, "__ctrans_runtime.ts"), renderRuntime("typescript", allHelpers, true));
  writeFileSync(join(JS_DIR, "__ctrans_runtime.ts"), renderRuntime("javascript", allHelpers, true));
});

afterAll(() => {
  rmSync(TS_DIR, { recursive: true, force: true });
  rmSync(JS_DIR, { recursive: true, force: true });
});

describe("__ctrans_runtime semantics (TypeScript variant)", () => {
  // Lazy: the runtime file is generated in beforeAll.
  const loadRuntime = async (): Promise<RuntimeModule> =>
    import(join(TS_DIR, "__ctrans_runtime.ts")) as unknown as Promise<RuntimeModule>;

  it("floorDiv floors toward negative infinity", async () => {
    const { __ctrans_floorDiv: floorDiv } = await loadRuntime();
    expect(floorDiv(7, 2)).toBe(3);
    expect(floorDiv(-7, 2)).toBe(-4);
    expect(floorDiv(7, -2)).toBe(-4);
    expect(() => floorDiv(1, 0)).toThrow("division by zero");
  });

  it("mod takes the divisor's sign", async () => {
    const { __ctrans_mod: mod } = await loadRuntime();
    expect(mod(-7, 2)).toBe(1);
    expect(mod(7, -2)).toBe(-1);
    expect(mod(7, 3)).toBe(1);
  });

  it("truthy applies Python rules (NaN truthy, [] and {} falsy)", async () => {
    const { __ctrans_truthy: truthy } = await loadRuntime();
    expect(truthy(Number.NaN)).toBe(true);
    expect(truthy([])).toBe(false);
    expect(truthy({})).toBe(false);
    expect(truthy("")).toBe(false);
    expect(truthy(new Set())).toBe(false);
    expect(truthy([1])).toBe(true);
    expect(truthy("a")).toBe(true);
    expect(truthy(0n)).toBe(false);
  });

  it("eq compares sequences elementwise", async () => {
    const { __ctrans_eq: eq } = await loadRuntime();
    expect(eq([1, [2, 3]], [1, [2, 3]])).toBe(true);
    expect(eq([1, 2], [1, 3])).toBe(false);
    expect(eq("a", "a")).toBe(true);
    expect(eq(2, 3)).toBe(false);
  });

  it("contains uses == semantics on sequences and keys on mappings", async () => {
    const { __ctrans_contains: contains } = await loadRuntime();
    expect(contains("hello", "ell")).toBe(true);
    expect(contains([[1], [2]], [2])).toBe(true);
    expect(contains({ key: 1 }, "key")).toBe(true);
    expect(contains(new Set([3]), 3)).toBe(true);
    expect(contains([2, 3], 1)).toBe(false);
  });

  it("slice reproduces negative bounds and steps", async () => {
    const { __ctrans_slice: slice } = await loadRuntime();
    expect(slice("abcdef", undefined, undefined, 2)).toBe("ace");
    expect(slice("abcdef", -2)).toBe("ef");
    expect(slice([1, 2, 3, 4, 5], undefined, 0, -1)).toEqual([5, 4, 3, 2]);
    expect(slice("abcdef", 1, 3)).toBe("bc");
    expect(slice([1, 2, 3, 4], 1, 3)).toEqual([2, 3]);
    expect(() => slice("abc", undefined, undefined, 0)).toThrow("slice step cannot be zero");
  });

  it("index raises IndexError/KeyError like Python", async () => {
    const { __ctrans_index: index } = await loadRuntime();
    expect(index([10, 20], -1)).toBe(20);
    expect(index({ k: 7 }, "k")).toBe(7);
    expect(() => index([1], 5)).toThrow("index out of range");
    // The KeyError/AttributeError surfaces are the class names (Python except-matching).
    try {
      index({ a: 1 }, "b");
      expect.unreachable("expected KeyError");
    } catch (error) {
      expect((error as { name: string }).name).toBe("KeyError");
    }
  });

  it("toInt truncates numbers and validates strings like Python", async () => {
    const { __ctrans_toInt: toInt } = await loadRuntime();
    expect(toInt("42")).toBe(42);
    expect(toInt(-4.7)).toBe(-4);
    expect(toInt(true)).toBe(1);
    expect(() => toInt("4.5")).toThrow("invalid literal for int()");
  });

  it("str uses Python spellings", async () => {
    const { __ctrans_str: str } = await loadRuntime();
    expect(str(true)).toBe("True");
    expect(str(null)).toBe("None");
    expect(str(undefined)).toBe("None");
    expect(str([1, "a"])).toBe("[1, 'a']");
    expect(str(3)).toBe("3");
  });

  it("print joins with spaces via str()", async () => {
    const { __ctrans_print: print } = await loadRuntime();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      print("value:", 3, true);
      expect(log).toHaveBeenCalledWith("value: 3 True");
    } finally {
      log.mockRestore();
    }
  });

  it("range validates integers and supports negative steps", async () => {
    const { __ctrans_range: range } = await loadRuntime();
    expect(range(4)).toEqual([0, 1, 2, 3]);
    expect(range(2, 5)).toEqual([2, 3, 4]);
    expect(range(5, 0, -2)).toEqual([5, 3, 1]);
    expect(() => range(2.5)).toThrow("integer");
    expect(() => range(0, 1, 0)).toThrow("must not be zero");
  });

  it("add concatenates sequences and rejects str+number", async () => {
    const { __ctrans_add: add } = await loadRuntime();
    expect(add([1], [2, 3])).toEqual([1, 2, 3]);
    expect(add("ab", "cd")).toBe("abcd");
    expect(add(2, 3)).toBe(5);
    expect(() => add("a", 1)).toThrow("can only concatenate str");
  });

  it("iter yields code points for strings and keys for mappings", async () => {
    const { __ctrans_iter: iter } = await loadRuntime();
    expect([...iter("a🎄b")]).toEqual(["a", "🎄", "b"]);
    expect(iter({ a: 1, b: 2 })).toEqual(["a", "b"]);
    expect([...iter(new Set(["x"]))]).toEqual(["x"]);
    expect(() => iter(3)).toThrow("not iterable");
  });

  it("call constructs classes and calls functions", async () => {
    const { __ctrans_call: call } = await loadRuntime();
    const { __ctrans_callMethod: callMethod } = await loadRuntime();
    const { __ctrans_getattr: getattr } = await loadRuntime();
    const { __ctrans_setattr: setattr } = await loadRuntime();
    class Widget {
      value: number;
      constructor(v: number) {
        this.value = v;
      }
      double(): number {
        return this.value * 2;
      }
    }
    const widget = call(Widget, 21) as Widget;
    expect(widget instanceof Widget).toBe(true);
    expect(getattr(widget, "value")).toBe(21);
    expect(callMethod(widget, "double")).toBe(42);
    setattr(widget, "value", 5);
    expect(getattr(widget, "value")).toBe(5);
    expect(() => call(3)).toThrow("not callable");
    try {
      getattr(widget, "missing");
      expect.unreachable("expected AttributeError");
    } catch (error) {
      expect((error as { name: string }).name).toBe("AttributeError");
    }
    expect(() => callMethod(1, "nope")).toThrow();
  });

  it("comparisons raise the Python TypeError for mixed types", async () => {
    const { __ctrans_lt: lt } = await loadRuntime();
    expect(lt(1, 2)).toBe(true);
    expect(lt("a", "b")).toBe(true);
    expect(() => lt("a", 1)).toThrow("not supported between");
  });
});

describe("__ctrans_runtime semantics (type-stripped JavaScript variant)", () => {
  it("behaves identically for the flagship divergences", async () => {
    // The generated "js" file is the Node-type-stripped form of the same sources:
    // no type annotations survive, and behavior matches the TS variant.
    const runtime = import(
      join(JS_DIR, "__ctrans_runtime.ts")
    ) as unknown as Promise<RuntimeModule>;
    const {
      __ctrans_floorDiv: floorDiv,
      __ctrans_mod: mod,
      __ctrans_truthy: truthy,
    } = await runtime;
    expect(floorDiv(-7, 2)).toBe(-4);
    expect(mod(-7, 2)).toBe(1);
    expect(truthy(Number.NaN)).toBe(true);
  });
});
