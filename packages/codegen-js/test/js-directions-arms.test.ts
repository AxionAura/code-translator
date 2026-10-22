// Arm-coverage driver for the reverse JS↔TS directions (roadmap M7): one large
// workload through BOTH translators so every lowering arm is exercised and its
// output re-parses (S1) — plus strict S2 for the TS output (honest types).
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@axion-ct/core";
import {
  createOxcJsParser,
  createOxcSyntaxValidator,
  OracleTypeValidator,
  type OxcJsParser,
} from "@axion-ct/parser-js";
import { JsToTsTranslator, TsToJsTranslator } from "../src/js-directions.js";

let js: OxcJsParser;

beforeAll(async () => {
  js = await createOxcJsParser();
});

async function emitBoth(
  source: string,
  filename: string,
): Promise<{ jsOut: string | undefined; tsOut: string | undefined }> {
  const language = filename.endsWith(".ts") ? "typescript" : "javascript";
  const parseResult = await js.parse(source, { filename, language });
  const unit = { filename, parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename, parseResult }]);
  const tsToJs = new TsToJsTranslator();
  await tsToJs.translateUnit(unit, graph);
  const jsFiles = new Map<string, string>();
  for (const file of (await tsToJs.finalizeUnits()).files)
    jsFiles.set(file.targetPath, file.content);
  const jsToTs = new JsToTsTranslator();
  await jsToTs.translateUnit(unit, graph);
  const tsFiles = new Map<string, string>();
  for (const file of (await jsToTs.finalizeUnits()).files)
    tsFiles.set(file.targetPath, file.content);
  return {
    jsOut: jsFiles.get(filename.replace(/\.ts$/, ".js")),
    tsOut: tsFiles.get(filename.replace(/\.js$/, ".ts")),
  };
}

async function assertS1(
  files: readonly { path: string; content: string }[],
  language: "javascript" | "typescript",
): Promise<void> {
  const validator = await createOxcSyntaxValidator();
  const result = await validator.validate(files.map((file) => ({ ...file, language })));
  expect(result.status, result.details.join("; ")).toBe("pass");
}

const CONTROL_FLOW = `
export function control(n, xs, obj) {
  do {
    n -= 1;
  } while (n > 0);
  let out = 0;
  for (let i = 10; i >= 0; i -= 2) {
    out += i;
  }
  for (const key in obj) {
    out += 1;
  }
  switch (n) {
    case 0:
      out = out + 100;
      break;
    case 1:
    case 2:
      out = out + 200;
      break;
    default:
      out = out + 300;
  }
  const seq = (out += 1, out > 0 ? 'pos' : 'neg');
  const logical = out > 0 && n > 0 || obj.count ?? 0;
  const updated = out++;
  void updated;
  const chained = obj?.meta?.depth;
  void chained;
  if (out > 1000) {
    return 'big';
  } else if (out > 100) {
    return 'mid';
  }
  label: while (true) {
    void xs;
    break label;
  }
  return seq + logical;
}
`;

describe("arm coverage: control flow", () => {
  it("TS → JS lowers every control-flow arm and stays S1-valid", async () => {
    const { jsOut } = await emitBoth(CONTROL_FLOW, "control.ts");
    expect(jsOut).toBeDefined();
    expect(jsOut).toContain("do {");
    expect(jsOut).toContain("for (let i = 10; i >= 0; i -= 2)");
    expect(jsOut).toContain("switch (n)");
    expect(jsOut).toContain("obj?.meta");
    expect(jsOut).toContain("break label");
    await assertS1([{ path: "control.js", content: jsOut! }], "javascript");
  });

  it("JS → TS annotates the same arms and passes strict S2", async () => {
    const { tsOut } = await emitBoth(CONTROL_FLOW.replace(/: (?!:)/g, ""), "control.js");
    expect(tsOut).toBeDefined();
    await assertS1([{ path: "control.ts", content: tsOut! }], "typescript");
    const s2 = await new OracleTypeValidator().validate([{ path: "control.ts", content: tsOut! }]);
    expect(s2.status, s2.details.join("; ")).toBe("pass");
  });
});

const EXPRESSIONS = `
export const REGEX = /ab+c/gi;
export function expressions(alpha, beta) {
  const tpl = \`x=\${alpha} y=\${beta}\`;
  const tagged = String.raw\`raw\`;
  void tagged;
  const spread = [...alpha, ...beta];
  const call = Math.max(...spread);
  const awaited = (async () => await Promise.resolve(call))();
  void awaited;
  const generator = function* () {
    yield 1;
    yield* [2, 3];
  };
  void generator;
  const fn = function named(alpha, beta) {
    return alpha;
  };
  void fn;
  const partial = beta?.call(alpha, 1, 2);
  void partial;
  const str = tpl + REGEX.test('abbc');
  return [str, spread.length, call];
}
export class Widget extends Object {
  static instances = 0;
  #id = Widget.instances++;
  constructor(name) {
    super();
    this.name = name;
  }
  get label() {
    return this.name;
  }
  set label(value) {
    this.name = value;
  }
  static make() {
    return new Widget('w');
  }
}
`;

describe("arm coverage: expressions & classes", () => {
  it("TS → JS lowers template/regex/spread/generator/class arms", async () => {
    const { jsOut } = await emitBoth(EXPRESSIONS, "expr.ts");
    expect(jsOut).toContain("const REGEX = /ab+c/gi;");
    expect(jsOut).toContain("const tpl = `x=${alpha} y=${beta}`;");
    expect(jsOut).toContain("[...alpha, ...beta]");
    expect(jsOut).toContain("function* ()");
    expect(jsOut).toContain("yield* [2, 3]");
    expect(jsOut).toContain("static instances = 0");
    expect(jsOut).toContain("#id");
    expect(jsOut).toContain("get label()");
    expect(jsOut).toContain("set label(value)");
    expect(jsOut).toContain("super()");
    await assertS1([{ path: "expr.js", content: jsOut! }], "javascript");
  });

  it("JS → TS lowers the same arms with honest types", async () => {
    const { tsOut } = await emitBoth(EXPRESSIONS.replace(/: (?!:)/g, ""), "expr.js");
    expect(tsOut).toContain("const REGEX: RegExp = /ab+c/gi;");
    await assertS1([{ path: "expr.ts", content: tsOut! }], "typescript");
    const s2 = await new OracleTypeValidator().validate([{ path: "expr.ts", content: tsOut! }]);
    expect(s2.status, s2.details.join("; ")).toBe("pass");
  });
});
