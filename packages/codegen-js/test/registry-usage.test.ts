// Registry v1 usage tests (docs/dependency-mapping.md §5): every mapped builtin
// and method exercised through REAL translated code, executed, and compared with
// Python's observable semantics. A registry claim without a passing usage test is
// a bug — these tests are that proof.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@ctrans/core";
import { createPythonBridgeParser, type PythonBridgeParser } from "@ctrans/parser-py";
import { createRegistryLookup } from "@ctrans/registry";
import { createPyToJsTranslator, type PyToJsTranslator } from "../src/translator.js";

let py: PythonBridgeParser;
let translator: PyToJsTranslator;

const OUT_DIR = join(import.meta.dirname, ".tmp-registry-usage");

beforeAll(async () => {
  py = await createPythonBridgeParser();
  translator = await createPyToJsTranslator("typescript", { registry: createRegistryLookup() });
  mkdirSync(OUT_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true });
});

// Loose callable view over the translated module (test boundary: the functions'
// signatures are dynamic; `unknown` + casts here, never `any`).
type LooseModule = Record<string, (...args: unknown[]) => unknown>;

let usageCounter = 0;

async function translateAndWrite(source: string, name?: string): Promise<LooseModule> {
  const moduleName = name ?? `mod${(usageCounter += 1)}`;
  const parseResult = await py.parse(source, { filename: `${moduleName}.py` });
  const unit = { filename: `${moduleName}.py`, parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename: unit.filename, parseResult: unit.parseResult }]);
  const emission = await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits();
  const files = new Map<string, string>();
  for (const file of [...emission.files, ...shared.files]) files.set(file.targetPath, file.content);
  // S1: the emitted output must re-parse.
  const { createOxcSyntaxValidator: makeValidator } = await import("@ctrans/parser-js");
  const validator = await makeValidator();
  const s1 = await validator.validate(
    [...files.entries()].map(([path, content]) => ({
      path,
      content,
      language: "typescript" as const,
    })),
  );
  expect(s1.status, s1.details.join("; ")).toBe("pass");
  // Per-module directory: ESM caches by resolved URL, so sharing
  // __ctrans_runtime.ts across tests would reuse the FIRST test's helper set.
  const dir = join(OUT_DIR, moduleName);
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of files) writeFileSync(join(dir, path), content);
  return (await import(join(dir, `${moduleName}.ts`))) as LooseModule;
}

function fn(mod: LooseModule, name: string): (...args: unknown[]) => unknown {
  const entry = mod[name];
  if (entry === undefined) throw new Error(`translated module is missing ${name}`);
  return entry;
}

describe("registry builtins: executed semantics", () => {
  // Python reference outputs:
  //   sorted([3, 1, 2]) = [1, 2, 3]; sorted(["b", "A", "c"]) = ["A", "b", "c"]
  //     (code-point order); sorted(["😀", "é"]) = ["é", "😀"]? NO — code points
  //     U+00E9 < U+1F600, so ["é", "😀"]. JS default sort would give ["😀","é"].
  //   list("ab") = ["a", "b"]; list() = []
  //   min([3, 1, 2]) = 1; max([3, 1, 2]) = 3
  //   min([]) raises ValueError; max([]) raises ValueError
  //   list(reversed([1, 2, 3])) = [3, 2, 1]
  //   list(zip([1, 2], ["a", "b"])) = [(1, "a"), (2, "b")]; zip truncates shortest
  //   abs(-5) = 5; bool(0) = False; bool([]) = False
  //   next(gen) walks the generator; exhaustion raises StopIteration
  //   list(enumerate(["a", "b"])) = [(0, "a"), (1, "b")]
  it("sorted: stable ascending with code-point string order and mixed TypeError", async () => {
    const mod = (await translateAndWrite(
      [
        "def sort_nums(xs):",
        "    return sorted(xs)",
        "",
        "def sort_strs(xs):",
        "    return sorted(xs)",
        "",
        "def sort_mixed(xs):",
        "    return sorted(xs)",
        "",
      ].join("\n"),
    )) as LooseModule;
    expect(fn(mod, "sort_nums")([3, 1, 2])).toEqual([1, 2, 3]);
    expect(fn(mod, "sort_strs")(["b", "A", "c"])).toEqual(["A", "b", "c"]);
    // Python: 'é' (U+00E9) < '😀' (U+1F600) by code points — JS default sort is
    // UTF-16-based and would produce the opposite order for these two.
    expect(fn(mod, "sort_strs")(["😀", "é"])).toEqual(["é", "😀"]);
    expect(() => fn(mod, "sort_mixed")([1, "a"])).toThrow(/not supported between/);
  });

  it("list/min/max: materialization, extremes, and ValueError on empty", async () => {
    const mod = (await translateAndWrite(
      [
        "def to_list(v):",
        "    return list(v)",
        "",
        "def smallest(xs):",
        "    return min(xs)",
        "",
        "def largest(xs):",
        "    return max(xs)",
        "",
      ].join("\n"),
    )) as LooseModule;
    expect(fn(mod, "to_list")("ab")).toEqual(["a", "b"]);
    expect(fn(mod, "to_list")(undefined)).toEqual([]); // list() -> fresh empty array
    expect(fn(mod, "smallest")([3, 1, 2])).toBe(1);
    expect(fn(mod, "largest")([3, 1, 2])).toBe(3);
    expect(() => fn(mod, "smallest")([])).toThrow("empty sequence");
    expect(() => fn(mod, "largest")([])).toThrow("empty sequence");
  });

  it("reversed/zip/enumerate/next: iteration semantics with documented materialization", async () => {
    const mod = (await translateAndWrite(
      [
        "def flip(xs):",
        "    return list(reversed(xs))",
        "",
        "def pairs(a, b):",
        "    return list(zip(a, b))",
        "",
        "def indexed(xs):",
        "    return list(enumerate(xs))",
        "",
        "def first_two(gen):",
        "    return [next(gen), next(gen)]",
        "",
      ].join("\n"),
    )) as LooseModule;
    expect(fn(mod, "flip")([1, 2, 3])).toEqual([3, 2, 1]);
    expect(fn(mod, "pairs")([1, 2, 3], ["a", "b"])).toEqual([
      [1, "a"],
      [2, "b"],
    ]); // truncates
    expect(fn(mod, "indexed")(["a", "b"])).toEqual([
      [0, "a"],
      [1, "b"],
    ]);
    function* gen(): Generator<number> {
      yield 10;
      yield 20;
    }
    expect(fn(mod, "first_two")(gen())).toEqual([10, 20]);
  });

  it("abs/bool: scalar conversions", async () => {
    const mod = (await translateAndWrite(
      [
        "def magnitude(v):",
        "    return abs(v)",
        "",
        "def to_bool(v):",
        "    return bool(v)",
        "",
      ].join("\n"),
    )) as LooseModule;
    expect(fn(mod, "magnitude")(-5)).toBe(5);
    expect(fn(mod, "to_bool")(0)).toBe(false);
    expect(fn(mod, "to_bool")([])).toBe(false);
    expect(fn(mod, "to_bool")("x")).toBe(true);
  });
});

describe("registry methods: executed semantics", () => {
  it("list methods: append/pop/index/count/remove/insert/extend/reverse/copy/clear", async () => {
    const mod = (await translateAndWrite(
      [
        "def append_and_pop(xs):",
        "    xs.append(9)",
        "    top = xs.pop()",
        "    return xs, top",
        "",
        "def find_index(xs, v):",
        "    return xs.index(v)",
        "",
        "def count_of(xs, v):",
        "    return xs.count(v)",
        "",
        "def drop_one(xs, v):",
        "    xs.remove(v)",
        "    return xs",
        "",
        "def insert_at(xs, i, v):",
        "    xs.insert(i, v)",
        "    return xs",
        "",
        "def extend_with(xs, more):",
        "    xs.extend(more)",
        "    return xs",
        "",
        "def in_place_reverse(xs):",
        "    xs.reverse()",
        "    return xs",
        "",
        "def shallow_copy(xs):",
        "    copied = xs.copy()",
        "    copied.append(99)",
        "    return xs, copied",
        "",
        "def wipe(xs):",
        "    xs.clear()",
        "    return xs",
        "",
      ].join("\n"),
    )) as LooseModule;
    expect(fn(mod, "append_and_pop")([1, 2])).toEqual([[1, 2], 9]);
    expect(fn(mod, "find_index")([5, 7, 7], 7)).toBe(1);
    expect(() => fn(mod, "find_index")([1], 9)).toThrow();
    expect(fn(mod, "count_of")([1, 2, 2, 3], 2)).toBe(2);
    expect(fn(mod, "drop_one")([1, 2, 1], 1)).toEqual([2, 1]); // first == match only
    expect(() => fn(mod, "drop_one")([1], 9)).toThrow();
    expect(fn(mod, "insert_at")([1, 3], 1, 2)).toEqual([1, 2, 3]);
    expect(fn(mod, "extend_with")([1], [2, 3])).toEqual([1, 2, 3]);
    expect(fn(mod, "in_place_reverse")([1, 2])).toEqual([2, 1]);
    const [original, copied] = fn(mod, "shallow_copy")([1]) as [number[], number[]];
    expect(original).toEqual([1]);
    expect(copied).toEqual([1, 99]);
    expect(fn(mod, "wipe")([1, 2])).toEqual([]);
  });

  it("dict methods: get/keys/values/items/pop with KeyError", async () => {
    const mod = (await translateAndWrite(
      [
        "def lookup(d, k):",
        "    return d.get(k)",
        "",
        "def key_set(d):",
        "    return d.keys()",
        "",
        "def value_list(d):",
        "    return d.values()",
        "",
        "def pair_list(d):",
        "    return d.items()",
        "",
        "def pop_key(d, k):",
        "    return d.pop(k)",
        "",
      ].join("\n"),
    )) as LooseModule;
    const d = { a: 1, b: 2 };
    expect(fn(mod, "lookup")(d, "a")).toBe(1);
    expect(fn(mod, "lookup")(d, "z")).toBeUndefined(); // None collapse
    expect(fn(mod, "key_set")(d)).toEqual(["a", "b"]);
    expect(fn(mod, "value_list")(d)).toEqual([1, 2]);
    expect(fn(mod, "pair_list")(d)).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(fn(mod, "pop_key")(d, "a")).toBe(1);
    expect(d).toEqual({ b: 2 });
    expect(() => fn(mod, "pop_key")(d, "z")).toThrow();
  });

  it("str methods: case/trim/search/replace/split/join/capitalize", async () => {
    const mod = (await translateAndWrite(
      [
        "def shout(s):",
        "    return s.upper()",
        "",
        "def quiet(s):",
        "    return s.lower()",
        "",
        "def trimmed(s):",
        "    return s.strip()",
        "",
        "def swapped(s):",
        "    return s.replace('a', 'b')",
        "",
        "def parts(s):",
        "    return s.split(', ')",
        "",
        "def blank_parts(s):",
        "    return s.split()",
        "",
        "def joined(sep, items):",
        "    return sep.join(items)",
        "",
        "def capped(s):",
        "    return s.capitalize()",
        "",
        "def prefixed(s):",
        "    return s.startswith('ab')",
        "",
        "def located(s, sub):",
        "    return s.find(sub)",
        "",
      ].join("\n"),
    )) as LooseModule;
    expect(fn(mod, "shout")("aé")).toBe("AÉ");
    expect(fn(mod, "quiet")("AÉ")).toBe("aé");
    expect(fn(mod, "trimmed")("  pad  ")).toBe("pad");
    expect(fn(mod, "swapped")("banana")).toBe("bbnbnb"); // replaceALL, like Python
    expect(fn(mod, "parts")("a, b, c")).toEqual(["a", "b", "c"]);
    expect(fn(mod, "blank_parts")("  a   b ")).toEqual(["a", "b"]); // whitespace runs
    expect(fn(mod, "joined")("-", ["x", "y"])).toBe("x-y");
    expect(fn(mod, "capped")("hELLO")).toBe("Hello");
    expect(fn(mod, "prefixed")("abc")).toBe(true);
    expect(fn(mod, "located")("hello", "ll")).toBe(2);
    expect(fn(mod, "located")("hello", "z")).toBe(-1);
  });

  it("set methods: add/discard/remove with KeyError", async () => {
    const mod = (await translateAndWrite(
      [
        "def grow(s, v):",
        "    s.add(v)",
        "    return s",
        "",
        "def drop_quiet(s, v):",
        "    s.discard(v)",
        "    return s",
        "",
        "def drop_loud(s, v):",
        "    s.remove(v)",
        "    return s",
        "",
      ].join("\n"),
    )) as LooseModule;
    expect(fn(mod, "grow")(new Set([1]), 2)).toEqual(new Set([1, 2]));
    expect(fn(mod, "drop_quiet")(new Set([1]), 99)).toEqual(new Set([1])); // silent like Python
    expect(fn(mod, "drop_loud")(new Set([1]), 1)).toEqual(new Set());
    expect(() => fn(mod, "drop_loud")(new Set([1]), 99)).toThrow();
  });
});
