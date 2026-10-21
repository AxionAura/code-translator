// Supported-surface sweep (roadmap M7): broad construct battery through the
// JS/TS → Python translator. Every entry must (a) emit Python that the bridge
// re-parses (S1), and (b) carry ledger provenance. Exercises the full supported
// arm set mechanically.
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@ctrans/core";
import { createOxcJsParser, type OxcJsParser } from "@ctrans/parser-js";
import { createJsToPyTranslator } from "../src/index.js";

let js: OxcJsParser;

beforeAll(async () => {
  js = await createOxcJsParser();
});

const SUPPORTED_BATTERY: readonly { readonly id: string; readonly source: string }[] = [
  {
    id: "literals",
    source:
      "export const a = 3;\nexport const b = 3.5;\nexport const c = true;\nexport const d = null;\n",
  },
  { id: "template", source: "export const greeting = `hi ${'x'} ${1}`;\n" },
  {
    id: "array-object",
    source: "export const xs = [1, [2], 'three'];\nexport const o = { a: 1, 'b': 2, [3]: 3 };\n",
  },
  {
    id: "arithmetic-native",
    source: "export function f(a, b) {\n  return a * 2 + 10 - b / 4;\n}\n",
  },
  { id: "update-expr-stmt", source: "export function f(n) {\n  n++;\n  void n;\n}\n" },
  {
    id: "logical-mixed",
    source: "export function f(a, b, c) {\n  return (a && b) || (c ?? 1);\n}\n",
  },
  { id: "conditional", source: "export function f(x) {\n  return x > 1 ? 'a' : 'b';\n}\n" },
  {
    id: "do-while",
    source: "export function f(n) {\n  do {\n    n -= 1;\n  } while (n > 0);\n  return n;\n}\n",
  },
  {
    id: "for-in",
    source:
      "export function keys(o) {\n  let n = 0;\n  for (const k in o) {\n    n += 1;\n  }\n  return n;\n}\n",
  },
  {
    id: "switch",
    source:
      "export function f(x) {\n  switch (x) {\n    case 1:\n      return 'a';\n    default:\n      return 'b';\n  }\n}\n",
  },
  { id: "sequence", source: "export function f(a) {\n  return (a += 1, a * 2);\n}\n" },
  {
    id: "try-finally",
    source: "export function f() {\n  try {\n    return 1;\n  } finally {\n    return 2;\n  }\n}\n",
  },
  { id: "throw-error", source: "export function f() {\n  throw new Error('boom');\n}\n" },
  {
    id: "nested-destructure",
    source: "export function f(o) {\n  const [a, [b]] = o;\n  return a + b;\n}\n",
  },
  {
    id: "obj-destructure-default",
    source: "export function f(o) {\n  const { a = 3 } = o;\n  return a;\n}\n",
  },
  { id: "generators", source: "export function* g() {\n  yield 1;\n  yield* [2];\n}\n" },
  { id: "await-expr", source: "export async function f(p) {\n  return await p;\n}\n" },
  { id: "spread-call", source: "export function f(fn, args) {\n  return fn(...args);\n}\n" },
  { id: "object-spread", source: "export function merge(a, b) {\n  return { ...a, ...b };\n}\n" },
  { id: "optional-call-chain", source: "export function f(o) {\n  return o?.run?.(1);\n}\n" },
  { id: "computed-access", source: "export function f(o, key) {\n  return o[key];\n}\n" },
  {
    id: "dynamic-index-write",
    source: "export function f(o, key, v) {\n  o[key] = v;\n  return o;\n}\n",
  },
  {
    id: "json-surface",
    source: "export function round(v) {\n  return JSON.parse(JSON.stringify(v));\n}\n",
  },
  {
    id: "string-methods",
    source:
      "export function f(s) {\n  return [s.trim(), s.toLowerCase(), s.toUpperCase(), s.startsWith('a')];\n}\n",
  },
  {
    id: "array-methods",
    source:
      "export function f(xs) {\n  return xs.filter((x) => x > 1).map((x) => x + 1).concat([9]).slice(0, 2);\n}\n",
  },
  {
    id: "dict-methods",
    source:
      "export function f(o) {\n  return [o.has('a'), o.get('a'), o.keys(), o.values(), o.entries()];\n}\n",
  },
  { id: "delete-stmt", source: "export function f(o) {\n  delete o.a;\n  return o;\n}\n" },
  { id: "typeof-void", source: "export function f(x) {\n  return [typeof x, void 0];\n}\n" },
  {
    id: "getter-setter",
    source:
      "export class Box {\n  constructor() {\n    this.v = 1;\n  }\n  get value() {\n    return this.v;\n  }\n  set value(v) {\n    this.v = v;\n  }\n}\n",
  },
  {
    id: "class-static-method",
    source: "export class U {\n  static make() {\n    return new U();\n  }\n}\n",
  },
  {
    id: "class-inheritance",
    source:
      "export class B extends Error {\n  constructor(m) {\n    super(m);\n    this.code = 1;\n  }\n}\n",
  },
  { id: "new-expression", source: "export function f() {\n  return new Map();\n}\n" },
  {
    id: "instanceof-in",
    source: "export function f(x, o) {\n  return [x instanceof Error, 'a' in o];\n}\n",
  },
  { id: "export-import", source: "import express from 'express';\nexport const app = express;\n" },
  { id: "star-reexport", source: "export * from './other.js';\n" },
  { id: "default-export-expr", source: "export default 42;\n" },
  { id: "empty-statement", source: "export function f() {\n  ;\n  return 1;\n}\n" },
  {
    id: "continue-break",
    source:
      "export function f(xs) {\n  let n = 0;\n  for (const x of xs) {\n    if (x < 0) {\n      continue;\n    }\n    if (x > 10) {\n      break;\n    }\n    n += 1;\n  }\n  return n;\n}\n",
  },
];

describe("supported-surface sweep (JS/TS → Python)", () => {
  for (const entry of SUPPORTED_BATTERY) {
    it(`${entry.id}: emits parseable Python with provenance`, async () => {
      const parseResult = await js.parse(entry.source, {
        filename: "mod.js",
        language: "javascript",
      });
      const unit = { filename: "mod.js", parseResult, model: analyzeModule(parseResult) };
      const graph = buildModuleGraph([{ filename: "mod.js", parseResult }]);
      const translator = createJsToPyTranslator();
      await translator.translateUnit(unit, graph);
      const shared = await translator.finalizeUnits!();
      const output = shared.files.find((file) => file.targetPath === "mod.py");
      expect(output, `${entry.id}: no module emitted`).toBeDefined();
      // S1: the bridge is the reference grammar — the emitted module re-parses.
      const { createPythonBridgeParser } = await import("@ctrans/parser-py");
      const bridge = await createPythonBridgeParser();
      try {
        await bridge.parse(output!.content, { filename: "out.py" });
      } catch (error) {
        throw new Error(
          `S1 failed for ${entry.id}: ${error instanceof Error ? error.message : String(error)}\n${output!.content}`,
        );
      }
      expect(shared.ledger.length, `${entry.id}: no ledger provenance`).toBeGreaterThan(0);
    });
  }
});
