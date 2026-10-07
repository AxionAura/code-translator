import { beforeAll, describe, expect, it } from "vitest";

import type { ParseResult } from "../src/parse-result.js";
import { analyzeModule } from "../src/semantic.js";
import { parsePython } from "./helpers.js";

let parse: (source: string, filename?: string) => Promise<ParseResult>;

beforeAll(async () => {
  parse = async (source: string, filename?: string) => await parsePython(source, filename);
});

function findSymbol(model: ReturnType<typeof analyzeModule>, name: string) {
  const entries = Object.values(model.symbols).filter((symbol) => symbol.name === name);
  return entries;
}

describe("python semantic analysis", () => {
  it("resolves closures: inner references the enclosing function's binding", async () => {
    const source = [
      "def outer():",
      "    x = 1",
      "    def inner():",
      "        return x",
      "    return inner",
      "",
    ].join("\n");
    const model = analyzeModule(await parse(source));
    const xs = findSymbol(model, "x");
    expect(xs).toHaveLength(1);
    const xScope = model.scopes[xs[0]!.scopeId];
    expect(xScope?.kind).toBe("function");
    expect(xScope?.name).toBe("outer");
    // inner's read of x resolves to outer's x (closure capture).
    // The reference from inner's scope is attached to outer's x symbol.
    const xReads = xs[0]!.references.filter((reference) => reference.context === "read");
    expect(xReads.length).toBe(1);
    expect(xReads[0]!.scopeId).not.toBe(xs[0]!.scopeId); // read from the nested scope
  });

  it("keeps shadowed bindings apart", async () => {
    const source = ["x = 1", "def f():", "    x = 2", "    return x", ""].join("\n");
    const model = analyzeModule(await parse(source));
    const xs = findSymbol(model, "x");
    expect(xs).toHaveLength(2);
    const fnLocal = xs.find((symbol) => model.scopes[symbol.scopeId]?.name === "f")!;
    const moduleLevel = xs.find((symbol) => symbol.scopeId === model.rootScopeId)!;
    expect(fnLocal.type).toMatchObject({ type: { kind: "number", numberKind: "int" } });
    expect(moduleLevel.type).toMatchObject({ type: { kind: "number", numberKind: "int" } });
  });

  it("resolves global writes to the module binding", async () => {
    const source = ["g = 0", "def bump():", "    global g", "    g = 5", ""].join("\n");
    const model = analyzeModule(await parse(source));
    const gs = findSymbol(model, "g");
    expect(gs).toHaveLength(1);
    expect(gs[0]!.scopeId).toBe(model.rootScopeId);
    const writes = gs[0]!.references.filter((reference) => reference.context === "write");
    expect(writes).toHaveLength(2); // module init + the `global g` write inside bump
    expect(writes.some((reference) => reference.scopeId !== model.rootScopeId)).toBe(true);
  });

  it("resolves nonlocal writes to the enclosing function binding", async () => {
    const source = [
      "def outer():",
      "    count = 0",
      "    def inc():",
      "        nonlocal count",
      "        count = count + 1",
      "    return inc",
      "",
    ].join("\n");
    const model = analyzeModule(await parse(source));
    const counts = findSymbol(model, "count");
    expect(counts).toHaveLength(1);
    const writes = counts[0]!.references.filter((reference) => reference.context === "write");
    expect(writes.length).toBeGreaterThanOrEqual(1);
  });

  it("models class-scope invisibility to methods explicitly", async () => {
    const source = [
      "class C:",
      "    attr = 1",
      "",
      "    def m(self):",
      "        return attr",
      "",
    ].join("\n");
    const model = analyzeModule(await parse(source));
    const classScope = Object.values(model.scopes).find((scope) => scope.kind === "class");
    expect(classScope?.notes).toContain("python: class-body scope is not visible to methods");
    // `attr` inside m is NOT visible through the class scope — it stays unresolved
    // (exactly Python's NameError behavior unless a global attr exists).
    const attrs = findSymbol(model, "attr");
    expect(attrs).toHaveLength(1);
    expect(attrs[0]!.scopeId).toBe(classScope?.id);
    const reads = attrs[0]!.references.filter((reference) => reference.context === "read");
    expect(reads).toHaveLength(0); // m's `return attr` did not resolve to the class attribute
    expect(model.unresolvedReferences.some((entry) => entry.name === "attr")).toBe(true);
  });

  it("types annotated parameters and returns explicitly", async () => {
    const source = "def scale(value: float, factor: int) -> float:\n    return value * factor\n";
    const model = analyzeModule(await parse(source));
    const scale = findSymbol(model, "scale")[0]!;
    expect(scale.type).toMatchObject({
      type: { kind: "number", numberKind: "float" },
      origin: "explicit",
    });
    const params = findSymbol(model, "value").concat(findSymbol(model, "factor"));
    expect(params).toHaveLength(2);
    expect(params.map((symbol) => symbol.kind)).toEqual(["parameter", "parameter"]);
    expect(findSymbol(model, "factor")[0]!.type).toMatchObject({
      type: { kind: "number", numberKind: "int" },
      origin: "explicit",
      confidence: "exact",
    });
  });

  it("infers literal and container types conservatively", async () => {
    const source = [
      "n = 42",
      "f = 1.5",
      "s = 'text'",
      "b = True",
      "data = b'ab'",
      "nothing = None",
      "xs = [1, 2, 3]",
      "mapping = {'a': 1, 'b': 2}",
      "label = f'value {n}'",
      "dynamic = compute()",
      "",
    ].join("\n");
    const model = analyzeModule(await parse(source));
    const typeOf = (name: string) => findSymbol(model, name)[0]!.type;
    expect(typeOf("n")).toMatchObject({
      type: { kind: "number", numberKind: "int" },
      origin: "inferred",
      confidence: "exact",
    });
    expect(typeOf("f")).toMatchObject({ type: { kind: "number", numberKind: "float" } });
    expect(typeOf("s")).toMatchObject({ type: { kind: "literal", value: "text" } });
    expect(typeOf("b")).toMatchObject({ type: { kind: "literal", value: true } });
    expect(typeOf("data")).toMatchObject({ type: { kind: "bytes" } });
    expect(typeOf("nothing")).toMatchObject({ type: { kind: "null" } });
    expect(typeOf("xs")).toMatchObject({
      type: { kind: "array", elementType: { kind: "number", numberKind: "int" } },
    });
    expect(typeOf("mapping")).toMatchObject({ type: { kind: "map", keyType: { kind: "string" } } });
    expect(typeOf("label")).toMatchObject({ type: { kind: "string" } });
    // Dynamic call: honestly unknown, never invented.
    expect(typeOf("dynamic")).toMatchObject({ type: { kind: "unknown" }, confidence: "unknown" });
  });

  it("maps PEP 604 and typing annotations", async () => {
    const source = "def f(x: int | None) -> list[str]:\n    return []\n";
    const model = analyzeModule(await parse(source));
    const fn = findSymbol(model, "f")[0]!;
    expect(fn.type).toMatchObject({ type: { kind: "array", elementType: { kind: "string" } } });
    const x = findSymbol(model, "x")[0]!;
    expect(x.type).toMatchObject({
      type: { kind: "union", members: [{ kind: "number", numberKind: "int" }, { kind: "null" }] },
    });
  });

  it("treats inlined comprehension targets as locals (PEP 709)", async () => {
    const source = "ys = [i * 2 for i in xs]\n";
    const model = analyzeModule(await parse(source));
    const is = findSymbol(model, "i");
    expect(is).toHaveLength(1);
    expect(is[0]!.kind).toBe("variable");
  });

  it("records import bindings with specifier provenance", async () => {
    const source = "import os.path\nfrom collections.abc import Mapping as M\n";
    const model = analyzeModule(await parse(source));
    const os = findSymbol(model, "os")[0]!;
    expect(os.kind).toBe("import");
    expect(os.imported).toBe(true);
    expect(os.importSpecifier).toBe("os.path");
    const m = findSymbol(model, "M")[0]!;
    expect(m.importSpecifier).toBe("collections.abc");
    expect(m.importedName).toBe("Mapping");
  });

  it("records unresolved references without inventing bindings", async () => {
    const source = "def handler():\n    return undefined_thing\n";
    const model = analyzeModule(await parse(source));
    expect(model.unresolvedReferences.some((entry) => entry.name === "undefined_thing")).toBe(true);
  });
});
