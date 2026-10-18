import { beforeAll, describe, expect, it } from "vitest";

import type { ParseResult } from "../src/parse-result.js";
import { analyzeModule } from "../src/semantic.js";
import { parseJs } from "./helpers.js";

let parse: (
  source: string,
  filename?: string,
  language?: "javascript" | "typescript",
) => Promise<ParseResult>;

beforeAll(async () => {
  parse = async (source: string, filename?: string, language?: "javascript" | "typescript") =>
    await parseJs(source, filename, language);
});

function findSymbol(model: ReturnType<typeof analyzeModule>, name: string) {
  return Object.values(model.symbols).filter((symbol) => symbol.name === name);
}

describe("javascript semantic analysis", () => {
  it("hoists var to the function scope while let stays block-scoped", async () => {
    const source = [
      "function f() {",
      "  { var hoisted = 1; }",
      "  { let local = 2; }",
      "  return hoisted + local;",
      "}",
      "",
    ].join("\n");
    const model = analyzeModule(await parse(source, "f.js"));
    const hoisted = findSymbol(model, "hoisted");
    expect(hoisted).toHaveLength(1);
    const fnScope = model.scopes[hoisted[0]!.scopeId];
    expect(fnScope?.kind).toBe("function");
    expect(fnScope?.name).toBe("f");
    expect(hoisted[0]!.languageFlags["isVar"]).toBe(true);
    // `local` lives in its block scope; the read at function level stays unresolved.
    const local = findSymbol(model, "local");
    expect(local).toHaveLength(1);
    expect(local[0]!.scopeId).not.toBe(hoisted[0]!.scopeId);
    expect(model.unresolvedReferences.some((entry) => entry.name === "local")).toBe(true);
  });

  it("models block-scope shadowing", async () => {
    const source = "let x = 1;\n{\n  let x = 2;\n  use(x);\n}\n";
    const model = analyzeModule(await parse(source));
    const xs = findSymbol(model, "x");
    expect(xs).toHaveLength(2);
    const inner = xs.find((symbol) => symbol.scopeId !== model.rootScopeId)!;
    const reads = inner.references.filter((reference) => reference.context === "read");
    expect(reads).toHaveLength(1); // use(x) inside the block sees the inner binding
  });

  it("gives catch clauses their own parameter scope", async () => {
    const source = "try {\n  risky();\n} catch (error) {\n  log(error);\n}\n";
    const model = analyzeModule(await parse(source));
    const errors = findSymbol(model, "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe("parameter");
    const scope = model.scopes[errors[0]!.scopeId];
    expect(scope?.kind).toBe("catch");
    expect(errors[0]!.references).toHaveLength(1);
  });

  it("binds for-of const declarations in the loop scope", async () => {
    const source = "for (const item of items) {\n  use(item);\n}\n";
    const model = analyzeModule(await parse(source));
    const items = findSymbol(model, "item");
    expect(items).toHaveLength(1);
    const reads = items[0]!.references.filter((reference) => reference.context === "read");
    expect(reads).toHaveLength(1);
  });

  it("resolves closures through function scopes", async () => {
    const source = [
      "function outer() {",
      "  const x = 1;",
      "  return function inner() {",
      "    return x;",
      "  };",
      "}",
      "",
    ].join("\n");
    const model = analyzeModule(await parse(source));
    const xs = findSymbol(model, "x");
    expect(xs).toHaveLength(1);
    const reads = xs[0]!.references.filter((reference) => reference.context === "read");
    expect(reads).toHaveLength(1);
    expect(reads[0]!.scopeId).not.toBe(xs[0]!.scopeId);
  });

  it("records import bindings and export status", async () => {
    const source = [
      "import def, { named as alias } from './m.js';",
      "export const visible = 1;",
      "const hidden = 2;",
      "",
    ].join("\n");
    const model = analyzeModule(await parse(source, "mod.js"));
    const def = findSymbol(model, "def")[0]!;
    expect(def.kind).toBe("import");
    expect(def).toMatchObject({
      imported: true,
      importSpecifier: "./m.js",
      mutability: "readonly",
    });
    const alias = findSymbol(model, "alias")[0]!;
    expect(alias.importedName).toBe("named");
    const visible = findSymbol(model, "visible")[0]!;
    expect(visible.exported).toBe(true);
    expect(visible.kind).toBe("constant");
    expect(visible.mutability).toBe("readonly");
    expect(findSymbol(model, "hidden")[0]!.exported).toBe(false);
  });

  it("class scopes hold methods and properties; declarations keep value namespaces", async () => {
    const source = [
      "class Box {",
      "  size = 1;",
      "  static KIND = 'box';",
      "  area() { return this.size; }",
      "}",
      "",
    ].join("\n");
    const model = analyzeModule(await parse(source));
    const box = findSymbol(model, "Box")[0]!;
    expect(box.kind).toBe("class");
    const size = findSymbol(model, "size")[0]!;
    const area = findSymbol(model, "area")[0]!;
    expect(size.kind).toBe("property");
    expect(area.kind).toBe("method");
    expect(area.scopeId).toBe(size.scopeId);
    expect(model.scopes[size.scopeId]?.kind).toBe("class");
  });

  it("types TS annotations, unions, and type namespaces explicitly", async () => {
    const source = [
      "export interface Shape { area(): number }",
      "export type Label = 'small' | 'large';",
      "export function scale(n: number, k: number): number { return n * k; }",
      "const configured: { size: number } = { size: 1 };",
      "function identity<T>(value: T): T { return value; }",
      "",
    ].join("\n");
    const model = analyzeModule(await parse(source, "mod.ts", "typescript"));
    const shape = findSymbol(model, "Shape")[0]!;
    expect(shape.kind).toBe("type");
    expect(shape.namespace).toBe("type");
    const label = findSymbol(model, "Label")[0]!;
    expect(label.type).toMatchObject({
      type: {
        kind: "union",
        members: [
          { kind: "literal", value: "small" },
          { kind: "literal", value: "large" },
        ],
      },
      origin: "explicit",
      confidence: "exact",
    });
    const n = findSymbol(model, "n")[0]!;
    expect(n.type).toMatchObject({ type: { kind: "number" }, origin: "explicit" });
    const configured = findSymbol(model, "configured")[0]!;
    expect(configured.type).toMatchObject({ type: { kind: "object" } });
    const t = Object.values(model.symbols).find((symbol) => symbol.kind === "typeParameter");
    expect(t?.name).toBe("T");
    expect(t?.namespace).toBe("type");
  });

  it("infers JS literals and stays honest about dynamic values", async () => {
    const source =
      "const n = 42;\nconst s = `hi ${n}`;\nconst xs = [1, 2];\nconst dyn = compute();\nlet later;\n";
    const model = analyzeModule(await parse(source));
    expect(findSymbol(model, "n")[0]!.type).toMatchObject({
      type: { kind: "number", numberKind: "int" },
      confidence: "exact",
    });
    expect(findSymbol(model, "s")[0]!.type).toMatchObject({ type: { kind: "string" } });
    expect(findSymbol(model, "xs")[0]!.type).toMatchObject({
      type: { kind: "array", elementType: { kind: "number", numberKind: "int" } },
    });
    expect(findSymbol(model, "dyn")[0]!.type).toMatchObject({
      type: { kind: "unknown" },
      confidence: "unknown",
    });
    expect(findSymbol(model, "later")[0]!.type).toBeNull();
  });

  it("treats unresolved globals as ordinary (no diagnostics), recorded honestly", async () => {
    const source = "console.log(x);\n";
    const model = analyzeModule(await parse(source));
    expect(model.unresolvedReferences.map((entry) => entry.name).sort()).toEqual(["console", "x"]);
    expect(model.diagnostics).toEqual([]);
  });

  it("records enum and namespace declarations", async () => {
    const source = ["enum Color { Red }", "namespace App { export const v = 1; }", ""].join("\n");
    const model = analyzeModule(await parse(source, "mod.ts", "typescript"));
    const color = findSymbol(model, "Color")[0]!;
    expect(color.kind).toBe("enum");
    expect(color.namespace).toBe("both");
    const app = findSymbol(model, "App")[0]!;
    expect(app.kind).toBe("namespace");
  });

  it("attaches TS annotation types to parameters (D-002 shared algebra)", async () => {
    const source = [
      "export function f(",
      "  a: string,",
      "  b: number,",
      "  c: boolean,",
      "  d: bigint,",
      "  e: Array<number>,",
      "  g: [string, number],",
      "  h: string | number,",
      "  i: string & number,",
      "  j?: string,",
      "  k: Promise<number>,",
      "  l: Widget,",
      "  m: { nested: true },",
      "): string | undefined {",
      "  return undefined;",
      "}",
      "",
    ].join("\n");
    const model = analyzeModule(await parse(source, "f.ts", "typescript"));
    const param = (name: string) => findSymbol(model, name)[0]?.type?.type;
    expect(param("a")).toMatchObject({ kind: "string" });
    expect(param("b")).toMatchObject({ kind: "number" });
    expect(param("c")).toMatchObject({ kind: "boolean" });
    expect(param("d")).toMatchObject({ kind: "bigint" });
    // Generic type arguments are not followed by the M3 analyzer (instance surface only).
    expect(param("e")).toMatchObject({ kind: "instance", className: "Array" });
    expect(param("g")).toMatchObject({
      kind: "tuple",
      elements: [{ kind: "string" }, { kind: "number" }],
    });
    expect(param("h")).toMatchObject({
      kind: "union",
      members: [{ kind: "string" }, { kind: "number" }],
    });
    expect(param("i")).toMatchObject({ kind: "intersection" });
    // Optional parameters are declared `j: string` without initializer; the J~? scan
    // marks them plain here — the type itself still maps.
    expect(param("j")).toMatchObject({ kind: "string" });
    expect(param("k")).toMatchObject({ kind: "instance", className: "Promise" });
    expect(param("l")).toMatchObject({ kind: "instance", className: "Widget" });
    expect(param("m")).toMatchObject({ kind: "object" });
    // Function symbols carry null (params are annotated per-name).
    expect(findSymbol(model, "f")[0]!.type).toBeNull();
  });

  it("maps literal-type annotations and keyword variants honestly", async () => {
    const source = [
      "export function g(a: 'lit', b: unknown, c: any, d: void, e: never, f: object, h: symbol, i: null, j: undefined) {",
      "  return j;",
      "}",
      "",
    ].join("\n");
    const model = analyzeModule(await parse(source, "g.ts", "typescript"));
    const param = (name: string) => findSymbol(model, name)[0]?.type?.type;
    expect(param("a")).toEqual({ kind: "literal", value: "lit" });
    expect(param("b")).toEqual({ kind: "unknown" });
    expect(param("c")).toEqual({ kind: "any" });
    expect(param("d")).toEqual({ kind: "void" });
    expect(param("e")).toEqual({ kind: "never" });
    expect(param("f")).toEqual({ kind: "object" });
    expect(param("h")).toEqual({ kind: "symbol" });
    expect(param("i")).toEqual({ kind: "null" });
    expect(param("j")).toEqual({ kind: "undefined" });
  });

  it("infers literal expression types honestly (dynamic sums stay unknown)", async () => {
    const source = [
      "const n = 5;",
      "const s = 'text';",
      "const flag = true;",
      "const nil = null;",
      "const big = 1n;",
      "const dyn = n + 1;",
      "",
    ].join("\n");
    const model = analyzeModule(await parse(source, "mod.js"));
    const type = (name: string) => findSymbol(model, name)[0]?.type?.type?.kind;
    expect(type("n")).toBe("number");
    expect(type("s")).toBe("literal"); // string literals infer as literal types
    expect(type("flag")).toBe("literal"); // bool literals also literalKind
    expect(type("nil")).toBe("null");
    expect(type("big")).toBe("literal"); // bigint literals carry literalKind bigint
    expect(type("dyn")).toBe("unknown");
  });

  it("resolves qualified type references through TSQualifiedName chains", async () => {
    const source = ["export function f(v: App.Widget) {", "  return v;", "}", ""].join("\n");
    const model = analyzeModule(await parse(source, "f.ts", "typescript"));
    const param = findSymbol(model, "v")[0]?.type?.type;
    expect(param).toMatchObject({ kind: "instance", className: "App.Widget" });
  });
});
