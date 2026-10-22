import { beforeAll, describe, expect, it } from "vitest";

import type { ScopeInfo } from "@axion-ct/core";

import { createPythonBridgeParser, type PythonBridgeParser } from "../src/client.js";

let parser: PythonBridgeParser;

beforeAll(async () => {
  parser = await createPythonBridgeParser();
});

function symbol(scope: ScopeInfo, name: string) {
  const found = scope.symbols.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`symbol "${name}" not found in scope "${scope.name}"`);
  }
  return found.flags;
}

function findScope(scope: ScopeInfo, name: string): ScopeInfo | null {
  if (scope.name === name) return scope;
  for (const child of scope.children) {
    const hit = findScope(child, name);
    if (hit !== null) return hit;
  }
  return null;
}

function mustFind(scope: ScopeInfo, name: string): ScopeInfo {
  const hit = findScope(scope, name);
  if (hit === null) {
    throw new Error(`scope "${name}" not found`);
  }
  return hit;
}

describe("symbol table", () => {
  it("reports module-level symbols with local/import/assignment flags", async () => {
    const source = "import os\nx = 1\ny = x + os.sep\n";
    const result = await parser.parse(source);
    const moduleScope = result.scopes;
    expect(moduleScope?.kind).toBe("module");
    expect(moduleScope?.line).toBeNull();
    expect(symbol(moduleScope!, "os")).toMatchObject({
      isImported: true,
      isReferenced: true,
    });
    expect(symbol(moduleScope!, "x")).toMatchObject({ isAssigned: true });
    expect(symbol(moduleScope!, "y")).toMatchObject({ isAssigned: true });
  });

  it("distinguishes parameters, locals, and declared globals", async () => {
    const source = [
      "g = 0",
      "",
      "def outer(a):",
      "    global g",
      "    b = a + 1",
      "    g = b",
      "",
    ].join("\n");
    const result = await parser.parse(source);
    const outer = mustFind(result.scopes!, "outer");
    expect(outer.kind).toBe("function");
    expect(symbol(outer, "a")).toMatchObject({ isParameter: true, isReferenced: true });
    expect(symbol(outer, "b")).toMatchObject({ isLocal: true, isAssigned: true });
    expect(symbol(outer, "g")).toMatchObject({
      isGlobal: true,
      isDeclaredGlobal: true,
      isAssigned: true,
    });
  });

  it("marks closure variables as free in nested functions", async () => {
    const source = [
      "def outer():",
      "    b = 1",
      "    def inner():",
      "        return b",
      "    return inner",
      "",
    ].join("\n");
    const result = await parser.parse(source);
    const inner = mustFind(result.scopes!, "inner");
    expect(symbol(inner, "b")).toMatchObject({ isFree: true, isReferenced: true });
    expect(mustFind(result.scopes!, "outer").children.some((c) => c.name === "inner")).toBe(true);
  });

  it("captures class scopes and their method scopes", async () => {
    const source = [
      "class C:",
      "    attr = 1",
      "",
      "    def m(self):",
      "        return self",
      "",
    ].join("\n");
    const result = await parser.parse(source);
    const cls = mustFind(result.scopes!, "C");
    expect(cls.kind).toBe("class");
    expect(symbol(cls, "attr")).toMatchObject({ isLocal: true, isAssigned: true });
    const method = mustFind(result.scopes!, "m");
    expect(symbol(method, "self")).toMatchObject({ isParameter: true });
    // Class-body names are not visible inside methods; `m` sees only its own scope.
    expect(method.symbols.map((s) => s.name)).toEqual(["self"]);
  });

  it("captures nonlocal declarations", async () => {
    const source = [
      "def outer():",
      "    count = 0",
      "    def inc():",
      "        nonlocal count",
      "        count = count + 1",
      "",
    ].join("\n");
    const result = await parser.parse(source);
    const inc = mustFind(result.scopes!, "inc");
    expect(symbol(inc, "count")).toMatchObject({
      isNonlocal: true,
      isFree: true,
      isAssigned: true,
    });
  });

  it("records the block header line as a 0-based line", async () => {
    const source = "\n\ndef deep():\n    pass\n";
    const result = await parser.parse(source);
    const deep = mustFind(result.scopes!, "deep");
    expect(deep.line).toBe(2);
  });

  it("reflects the running interpreter's scope model (3.14 annotation scopes)", async () => {
    // Python 3.14 (PEP 649/749) reports deferred-annotation scopes; on 3.14 the
    // __annotate__ scope for a function's annotations hangs off the ENCLOSING scope
    // (module here), as a sibling of the function scope. The bridge captures whatever
    // the runtime reports - this test documents that shape without hard-coding it.
    const result = await parser.parse("def f(x: int) -> int:\n    return x\n");
    const moduleScope = result.scopes!;
    if (moduleScope.children.some((child) => child.kind === "annotation")) {
      expect(moduleScope.children.some((child) => child.name === "f")).toBe(true);
      expect(moduleScope.children.some((child) => child.kind === "annotation")).toBe(true);
    } else {
      // On 3.12/3.13 there are no annotation scopes; the function scope still exists.
      expect(mustFind(moduleScope, "f").kind).toBe("function");
    }
  });
});
