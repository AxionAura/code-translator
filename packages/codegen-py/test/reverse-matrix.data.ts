// Reverse-direction ConstructMatrix (roadmap M7 WS H): JS/TS sources → Python
// targets. Each entry pins the emitted-Python fragments, the ledger decision
// class, and (for unsupported) the marker. This is the documented support surface
// for the codegen-py lowering; language-support.md §2 TS/JS→Py column is the
// contract these entries verify.
export interface ReverseMatrixEntry {
  readonly id: string;
  readonly language: "javascript" | "typescript";
  readonly source: string;
  readonly expectedContains: readonly string[];
  readonly expectedNotContains?: readonly string[];
  // The rule fragment and decision class of the PRIMARY mapping (asserted).
  readonly rule?: string;
  readonly decision: "deterministic" | "semantic" | "ambiguous" | "unsupported";
  // Unsupported entries only assert the marker + decision (no S1 guarantee needed
  // — markers are comments and the module still parses).
  readonly unsupported?: boolean;
}

export const REVERSE_MATRIX: readonly ReverseMatrixEntry[] = [
  // ---- values & literals ---------------------------------------------------------
  {
    id: "literals",
    language: "javascript",
    source:
      "export const a = 3;\nexport const b = 3.5;\nexport const c = 'text';\nexport const d = true;\nexport const e = null;\n",
    expectedContains: ["a = 3", "b = 3.5", 'c = "text"', "d = True", "e = None"],
    decision: "semantic",
  },
  {
    id: "template-literal",
    language: "javascript",
    source: "export function f(name) {\n  return `hello ${name}!`;\n}\n",
    expectedContains: ['f"hello {__ctrans_str_js(name)}!"'],
    rule: "js.template→py.fstring",
    decision: "deterministic",
  },
  {
    id: "null-undefined-collapse",
    language: "javascript",
    source: "export const x = null;\n",
    expectedContains: ["x = None"],
    rule: "js.null→py.None",
    decision: "semantic",
  },
  // ---- operators -----------------------------------------------------------------
  {
    id: "native-arithmetic",
    language: "javascript",
    source: "export function f(a, b) {\n  return a * b + a - b;\n}\n",
    expectedContains: ["__ctrans_js_add(a * b, a) - b"],
    rule: "js.+→py.js_add",
    decision: "semantic",
  },
  {
    id: "js-remainder-helper",
    language: "javascript",
    source: "export function f(a, b) {\n  return a % b;\n}\n",
    expectedContains: ["__ctrans_js_mod(a, b)"],
    rule: "js.%→py.js_mod",
    decision: "semantic",
  },
  {
    id: "strict-equality",
    language: "javascript",
    source: "export function f(a, b) {\n  return a === b;\n}\n",
    expectedContains: ["a == b"],
    rule: "js.===→py.==",
    decision: "semantic",
  },
  {
    id: "in-operator",
    language: "javascript",
    source: "export function f(k, obj) {\n  return k in obj;\n}\n",
    expectedContains: ["__ctrans_js_in(k, obj)"],
    rule: "js.in→py.js_in",
    decision: "semantic",
  },
  {
    id: "instanceof",
    language: "javascript",
    source: "export function f(x) {\n  return x instanceof Error;\n}\n",
    expectedContains: ["__ctrans_js_instanceof(x, Error)"],
    rule: "js.instanceof→py.js_instanceof",
    decision: "semantic",
  },
  {
    id: "typeof",
    language: "javascript",
    source: "export function f(x) {\n  return typeof x;\n}\n",
    expectedContains: ["__ctrans_typeof(x)"],
    rule: "js.typeof→py.typeof",
    decision: "semantic",
  },
  {
    id: "optional-chaining",
    language: "javascript",
    source: "export function f(obj) {\n  return obj?.name;\n}\n",
    expectedContains: ['__ctrans_opt_attr(obj, "name")'],
    rule: "js.?.→py.opt_attr",
    decision: "semantic",
  },
  // ---- statements ----------------------------------------------------------------
  {
    id: "if-elif-else",
    language: "javascript",
    source:
      "export function grade(score) {\n  if (score >= 90) {\n    return 'A';\n  } else if (score >= 80) {\n    return 'B';\n  } else {\n    return 'F';\n  }\n}\n",
    expectedContains: ["if ", "elif score >= 80:", "else:"],
    decision: "deterministic",
  },
  {
    id: "counting-for",
    language: "javascript",
    source:
      "export function total(n) {\n  let sum = 0;\n  for (let i = 0; i < n; i++) {\n    sum += i;\n  }\n  return sum;\n}\n",
    expectedContains: ["for i in range(0, n):", "sum = sum + i"],
    rule: "js.for→py.range",
    decision: "semantic",
  },
  {
    id: "for-of",
    language: "javascript",
    source:
      "export function joinAll(xs) {\n  let out = '';\n  for (const x of xs) {\n    out += x;\n  }\n  return out;\n}\n",
    expectedContains: ["for x in xs:"],
    rule: "js.for-of→py.for-in",
    decision: "deterministic",
  },
  {
    id: "while",
    language: "javascript",
    source: "export function countdown(n) {\n  while (n > 0) {\n    n -= 1;\n  }\n  return n;\n}\n",
    expectedContains: ["while n > 0:", "n = n - 1"],
    decision: "deterministic",
  },
  {
    id: "switch-no-fallthrough",
    language: "javascript",
    source:
      "export function pick(mode) {\n  switch (mode) {\n    case 'a':\n      return 1;\n    case 'b':\n      return 2;\n    default:\n      return 0;\n  }\n}\n",
    expectedContains: ['== "a"', "elif", "else:"],
    rule: "js.switch→py.if-elif",
    decision: "semantic",
  },
  {
    id: "switch-fallthrough-unsupported",
    language: "javascript",
    source:
      "export function f(x) {\n  switch (x) {\n    case 1:\n    case 2:\n      return 'low';\n    default:\n      return 'high';\n  }\n}\n",
    expectedContains: ["# ctrans: unsupported case fallthrough"],
    rule: "js.SwitchCase→unsupported",
    decision: "unsupported",
  },
  {
    id: "try-catch-finally",
    language: "javascript",
    source:
      "export function f(xs, i) {\n  try {\n    return xs[i];\n  } catch (error) {\n    return error;\n  } finally {\n    return 'done';\n  }\n}\n",
    expectedContains: ["try:", "except Exception as error:", "finally:"],
    rule: "js.catch→py.except-Exception",
    decision: "semantic",
  },
  {
    id: "throw-non-error",
    language: "javascript",
    source: "export function f(x) {\n  throw x;\n}\n",
    expectedContains: ["raise RuntimeError(x)"],
    rule: "js.throw-non-error→py.RuntimeError",
    decision: "semantic",
  },
  {
    id: "destructure-array",
    language: "javascript",
    source: "export function f(pair) {\n  const [a, b] = pair;\n  return a + b;\n}\n",
    expectedContains: ["a, b = pair"],
    decision: "deterministic",
  },
  {
    id: "destructure-object",
    language: "javascript",
    source: "export function f(point) {\n  const { x, y } = point;\n  return x + y;\n}\n",
    expectedContains: ["__ctrans_js_get(", '"x")', '"y")', "_ctrans_tmp"],
    rule: "js.obj-destructure→py.key-reads",
    decision: "semantic",
  },
  // ---- functions & classes --------------------------------------------------------
  {
    id: "default-params",
    language: "javascript",
    source: "export function greet(name, greeting = 'hi') {\n  return `${greeting} ${name}`;\n}\n",
    expectedContains: ['def greet(name, greeting="hi"):'],
    decision: "deterministic",
  },
  {
    id: "rest-params",
    language: "javascript",
    source: "export function sum(...values) {\n  return values.length;\n}\n",
    expectedContains: ["def sum(*values):", "len(values)"],
    decision: "deterministic",
  },
  {
    id: "generator",
    language: "javascript",
    source:
      "export function* counter(n) {\n  for (let i = 0; i < n; i++) {\n    yield i;\n  }\n}\n",
    expectedContains: ["def counter(n):", "yield i"],
    rule: "js.function→py.def",
    decision: "deterministic",
  },
  {
    id: "yield-from",
    language: "javascript",
    source:
      "export function* inner() {\n  yield 1;\n}\nexport function* outer() {\n  yield* inner();\n}\n",
    expectedContains: ["yield from inner()"],
    decision: "deterministic",
  },
  {
    id: "async-await",
    language: "javascript",
    source: "export async function load(url) {\n  return url;\n}\n",
    expectedContains: ["async def load(url):"],
    decision: "deterministic",
  },
  {
    id: "class-methods-this",
    language: "javascript",
    source:
      "export class Point {\n  constructor(x, y) {\n    this.x = x;\n    this.y = y;\n  }\n  sum() {\n    return this.x + this.y;\n  }\n}\n",
    expectedContains: [
      "class Point:",
      "def __init__(self, x, y):",
      "self.x = x",
      "def sum(self):",
      "__ctrans_js_add(self.x, self.y)",
    ],
    rule: "js.class→py.class",
    decision: "deterministic",
  },
  {
    id: "class-inheritance-super",
    language: "javascript",
    source:
      "export class A {\n  constructor() {\n    this.v = 1;\n  }\n}\nexport class B extends A {\n  constructor() {\n    super();\n    this.w = 2;\n  }\n}\n",
    expectedContains: ["class B(A):", "super().__init__()", "self.w = 2"],
    decision: "deterministic",
  },
  {
    id: "getter-property",
    language: "javascript",
    source:
      "export class Box {\n  constructor() {\n    this.v = 1;\n  }\n  get value() {\n    return this.v;\n  }\n}\n",
    expectedContains: ["@property", "def value(self):"],
    rule: "js.getter→py.property",
    decision: "semantic",
  },
  {
    id: "static-method",
    language: "javascript",
    source: "export class Util {\n  static make() {\n    return 1;\n  }\n}\n",
    expectedContains: ["@staticmethod", "def make():"],
    decision: "deterministic",
  },
  {
    id: "private-field",
    language: "javascript",
    source: "export class C {\n  #hidden = 1;\n  reveal() {\n    return this.#hidden;\n  }\n}\n",
    expectedContains: ["self._hidden = 1", "return self._hidden"],
    rule: "js.#field→py._name",
    decision: "semantic",
  },
  {
    id: "new-expression",
    language: "javascript",
    source: "export function f() {\n  return new Error('boom');\n}\n",
    expectedContains: ['Error("boom")'],
    rule: "js.new→py.constructor",
    decision: "deterministic",
  },
  // ---- collections & methods -------------------------------------------------------
  {
    id: "array-map-filter",
    language: "javascript",
    source: "export function f(xs) {\n  return xs.map((x) => x * 2).filter((x) => x > 2);\n}\n",
    expectedContains: ["__ctrans_js_filter(__ctrans_js_map(xs, lambda x: x * 2), lambda x: x > 2)"],
    decision: "semantic",
  },
  {
    id: "array-reduce",
    language: "javascript",
    source: "export function f(xs) {\n  return xs.reduce((sum, x) => sum + x, 0);\n}\n",
    expectedContains: ["__ctrans_js_reduce(xs,"],
    decision: "semantic",
  },
  {
    id: "array-join-length",
    language: "javascript",
    source: "export function f(xs) {\n  return xs.join(', ') + String(xs.length);\n}\n",
    expectedContains: ["__ctrans_js_join(xs, ", "len(xs)", "__ctrans_str_js("],
    decision: "semantic",
  },
  {
    id: "object-literal-keys",
    language: "javascript",
    source: "export function keysOf(o) {\n  return Object.keys(o);\n}\n",
    expectedContains: ["__ctrans_js_object_keys(o)"],
    rule: "js.Object.keys→py.object_keys",
    decision: "semantic",
  },
  {
    id: "string-methods",
    language: "javascript",
    source:
      "export function f(s) {\n  return [s.toUpperCase(), s.trim(), s.replace('a', 'b')];\n}\n",
    expectedContains: ["s.upper()", "s.strip()", 's.replace("a", "b", 1)'],
    rule: "js.replace→py.replace-first",
    decision: "semantic",
  },
  {
    id: "string-split",
    language: "javascript",
    source: "export function f(s) {\n  return s.split(',');\n}\n",
    expectedContains: ["__ctrans_js_split(s"],
    decision: "semantic",
  },
  {
    id: "dynamic-property-access",
    language: "javascript",
    source: "export function f(o, key) {\n  return o[key];\n}\n",
    expectedContains: ["__ctrans_js_get(o, key)"],
    rule: "js.member→py.js_get",
    decision: "semantic",
  },
  {
    id: "object-spread",
    language: "javascript",
    source: "export function merge(a, b) {\n  return { ...a, ...b };\n}\n",
    expectedContains: ["{**a, **b}"],
    decision: "deterministic",
  },
  {
    id: "spread-call",
    language: "javascript",
    source: "export function f(fn, args) {\n  return fn(...args);\n}\n",
    expectedContains: ["fn(*args)"],
    decision: "deterministic",
  },
  // ---- modules -------------------------------------------------------------------
  {
    id: "external-import-verbatim",
    language: "javascript",
    source: "import express from 'express';\nexport function f() {\n  return express;\n}\n",
    expectedContains: ["import express", "express = express"],
    rule: "js.import→py.import-external",
    decision: "semantic",
  },
  {
    id: "export-default",
    language: "javascript",
    source: "export default function main() {\n  return 1;\n}\n",
    expectedContains: ["def main():", "default = main"],
    rule: "js.export-default→py.default-binding",
    decision: "semantic",
  },
  // ---- TS-specific surface ---------------------------------------------------------
  {
    id: "ts-annotations-erased",
    language: "typescript",
    source: "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    expectedContains: ["def add(a, b):", "__ctrans_js_add(a, b)"],
    expectedNotContains: [": number"],
    decision: "deterministic",
  },
  {
    id: "ts-interface-erased",
    language: "typescript",
    source: "export interface Shape {\n  area(): number;\n}\n",
    expectedContains: [],
    expectedNotContains: ["interface"],
    rule: "erased",
    decision: "deterministic",
  },
  {
    id: "ts-type-alias-erased",
    language: "typescript",
    source: "export type Id = string;\n",
    expectedContains: [],
    expectedNotContains: ["type Id"],
    rule: "erased",
    decision: "deterministic",
  },
  {
    id: "ts-enum-unsupported",
    language: "typescript",
    source: "export enum Color {\n  Red = 1,\n  Green = 2,\n}\n",
    expectedContains: ["# ctrans: unsupported enum"],
    rule: "js.TSEnumDeclaration→unsupported",
    decision: "unsupported",
  },
  {
    id: "ts-namespace-unsupported",
    language: "typescript",
    source: "export namespace Store {\n  export const value = 1;\n}\n",
    expectedContains: ["# ctrans: unsupported namespace"],
    rule: "js.TSModuleDeclaration→unsupported",
    decision: "unsupported",
  },
  {
    id: "ts-as-erased",
    language: "typescript",
    source: "export const n = '42' as unknown as number;\n",
    expectedContains: ['n = "42"'],
    expectedNotContains: [" as number", " as unknown"],
    decision: "deterministic",
  },
  {
    id: "ts-non-null-erased",
    language: "typescript",
    source: "export function f(x?: number) {\n  return x!;\n}\n",
    expectedContains: ["return x"],
    expectedNotContains: ["!;"],
    decision: "deterministic",
  },
  {
    id: "parameter-property-unsupported",
    language: "typescript",
    source: "export class C {\n  constructor(public name: string) {}\n}\n",
    expectedContains: ["# ctrans: unsupported parameter property"],
    rule: "js.TSParameterProperty→unsupported",
    decision: "unsupported",
  },
];
