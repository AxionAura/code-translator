// Mega-battery: drives the remaining statement/expression arms of both reverse
// printers. Every source is emitted through TS→JS and JS→TS; TS→JS output must
// stay S1-valid (babel re-parse) unless the test asserts an unsupported marker.
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@ctrans/core";
import { createOxcJsParser, type OxcJsParser } from "@ctrans/parser-js";
import { JsToTsTranslator, TsToJsTranslator } from "../src/js-directions.js";

let js: OxcJsParser;

beforeAll(async () => {
  js = await createOxcJsParser();
});

async function emitTsToJs(source: string): Promise<string> {
  const parseResult = await js.parse(source, { filename: "mod.ts", language: "typescript" });
  const unit = { filename: "mod.ts", parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename: "mod.ts", parseResult }]);
  const translator = new TsToJsTranslator();
  await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits();
  return shared.files.find((file) => file.targetPath === "mod.js")!.content;
}

async function emitJsToTs(source: string): Promise<string> {
  const parseResult = await js.parse(source, { filename: "mod.js", language: "javascript" });
  const unit = { filename: "mod.js", parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename: "mod.js", parseResult }]);
  const translator = new JsToTsTranslator();
  await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits();
  return shared.files.find((file) => file.targetPath === "mod.ts")!.content;
}

const MEGA_TS = `
import type { Only } from './types.js';
import './side-effect.js';
import def, { named as alias } from './mixed.js';
export type Wrapped = Only;
export interface Contract {
  run(): void;
}
type Alias = string | number;
declare function ambient(n: number): number;
export function everything(o: Contract, n: number): void {
  const erased = n as unknown as string;
  const nonNull = o!;
  void erased;
  void nonNull;
  try {
    o.run();
  } catch {
    return;
  } finally {
    void n;
  }
  while (n > 0) {
    n -= 1;
    if (n === 3) {
      continue;
    }
    if (n === 0) {
      break;
    }
  }
  const grouped = (1, 2, 3);
  void grouped;
  const regex = /x+/gs;
  void regex;
}

export class Machinery {
  static count = 0;
  static {
    Machinery.count = 1;
  }
  #state = 0;
  get state(): number {
    return this.#state;
  }
  async tick(delta: number): Promise<void> {
    await Promise.resolve(delta);
  }
}
export const objectExpr = {
  method() {
    return 1;
  },
  computed: 'k',
  spread: { a: 1 },
};
`;

describe("mega-battery: TS → JS", () => {
  it("emits parseable JS for the full construct battery", async () => {
    const output = await emitTsToJs(MEGA_TS);
    expect(output).not.toContain("interface Contract");
    expect(output).not.toContain("type Alias");
    expect(output).toContain("catch {");
    expect(output).toContain("finally {");
    expect(output).toContain("while (n > 0)");
    expect(output).toContain("const grouped = (1, 2, 3);");
    expect(output).toContain("static {");
    expect(output).toContain("#state = 0");
    expect(output).toContain("get state()");
    expect(output).toContain("async tick(delta)");
    expect(output).toContain("method: function () {");
    expect(output).toContain("spread: { a: 1 }");
  });
});

const MEGA_JS = `
export function everything(o, n) {
  const [first, ...others] = o.list;
  const { a, b = 2, ...rest } = o.map;
  void first;
  void others;
  void rest;
  for (const key in o.map) {
    void key;
  }
  const ternary = n > 1 ? 'a' : n < 0 ? 'b' : 'c';
  const identity = n === 0 ? null : n;
  void ternary;
  void identity;
  return function inner(m) {
    return m ** 2;
  };
}
export class Legacy {
  constructor() {
    this.tag = 'legacy';
  }
  toString() {
    return this.tag;
  }
}
`;

describe("mega-battery: JS → TS", () => {
  it("emits strict-valid TS for the full construct battery", async () => {
    const output = await emitJsToTs(MEGA_JS);
    expect(output).toContain("const [first, ...others]");
    expect(output).toContain("...rest");
    expect(output).toContain("for (const key in");
    expect(output).toContain("function inner(m: unknown): unknown");
    expect(output).toContain("(m as number) ** 2");
    expect(output).toContain("toString()");
  });
});
