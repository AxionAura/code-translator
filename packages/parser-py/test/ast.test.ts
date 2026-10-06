import { beforeAll, describe, expect, it } from "vitest";

import type { AstNode } from "@ctrans/core";

import { createPythonBridgeParser, type PythonBridgeParser } from "../src/client.js";

let parser: PythonBridgeParser;

beforeAll(async () => {
  parser = await createPythonBridgeParser();
});

async function body(source: string): Promise<AstNode[]> {
  const result = await parser.parse(source);
  const list = result.ast.fields["body"];
  if (!Array.isArray(list)) {
    throw new Error("module body is missing");
  }
  return list as AstNode[];
}

async function parseSingle(source: string): Promise<AstNode> {
  const list = await body(source);
  if (list.length !== 1) {
    throw new Error(`expected exactly one statement, got ${String(list.length)}`);
  }
  return list[0]!;
}

describe("AST grammar coverage", () => {
  it("captures assignments and expressions with operator singletons", async () => {
    const assign = await parseSingle("total = a + b * c\n");
    expect(assign.kind).toBe("Assign");
    const value = assign.fields["value"] as AstNode;
    expect(value.kind).toBe("BinOp");
    // `a + b * c`: the top-level operator is Add; the right operand carries the Mult.
    expect((value.fields["op"] as AstNode).kind).toBe("Add");
    expect((value.fields["op"] as AstNode).span).toBeNull();
    const right = value.fields["right"] as AstNode;
    expect((right.fields["op"] as AstNode).kind).toBe("Mult");
    expect((assign.fields["targets"] as AstNode[])[0]?.kind).toBe("Name");
  });

  it("captures function definitions with args and defaults", async () => {
    const fn = await parseSingle("def f(a, b=2, *args, **kwargs): pass\n");
    expect(fn.kind).toBe("FunctionDef");
    expect(fn.fields["name"]).toBe("f");
    const args = fn.fields["args"] as AstNode;
    const argNames = (args.fields["args"] as AstNode[]).map((arg) => arg.fields["arg"]);
    expect(argNames).toEqual(["a", "b"]);
    expect((args.fields["vararg"] as AstNode).fields["arg"]).toBe("args");
    expect((args.fields["kwarg"] as AstNode).fields["arg"]).toBe("kwargs");
    const defaults = args.fields["defaults"] as AstNode[];
    expect(defaults).toHaveLength(1);
    expect((defaults[0] as AstNode).kind).toBe("Constant");
  });

  it("captures classes with bases and keywords", async () => {
    const cls = await parseSingle("class C(Base, metaclass=M): pass\n");
    expect(cls.kind).toBe("ClassDef");
    expect(cls.fields["name"]).toBe("C");
    expect((cls.fields["bases"] as AstNode[]).map((b) => b.fields["id"])).toEqual(["Base"]);
    const keywords = cls.fields["keywords"] as AstNode[];
    expect(keywords[0]?.fields["arg"]).toBe("metaclass");
  });

  it("captures import forms", async () => {
    const imports = await body("import os, sys as system\nfrom a.b import c as d\n");
    expect(imports.map((node) => node.kind)).toEqual(["Import", "ImportFrom"]);
    const aliases = imports[0]?.fields["names"] as AstNode[];
    expect(aliases.map((alias) => alias.fields["asname"])).toEqual([null, "system"]);
    const from = imports[1] as AstNode;
    expect(from.fields["module"]).toBe("a.b");
    expect(from.fields["level"]).toBe(0);
  });

  it("captures control flow including for/while/else", async () => {
    const source = ["for i in xs:", "    pass", "else:", "    pass", ""].join("\n");
    const loop = await parseSingle(source);
    expect(loop.kind).toBe("For");
    expect((loop.fields["orelse"] as AstNode[]).length).toBe(1);
    const whileNode = await parseSingle("while True:\n    break\n");
    expect(whileNode.kind).toBe("While");
    expect((whileNode.fields["test"] as AstNode).kind).toBe("Constant");
  });

  it("captures comprehensions across list/dict/set forms", async () => {
    const listcomp = await parseSingle("ys = [x for x in xs if x]\n");
    const listValue = listcomp.fields["value"] as AstNode;
    expect(listValue.kind).toBe("ListComp");
    const generators = (listValue.fields["generators"] as AstNode[])[0] as AstNode;
    expect(generators.kind).toBe("comprehension");
    expect((generators.fields["ifs"] as AstNode[]).length).toBe(1);
    const dictcomp = await parseSingle("zs = {k: v for k, v in items}\n");
    expect((dictcomp.fields["value"] as AstNode).kind).toBe("DictComp");
  });

  it("captures decorators", async () => {
    const fn = await parseSingle("@decorator\n@factory(arg)\ndef f(): pass\n");
    expect(fn.kind).toBe("FunctionDef");
    const decorators = fn.fields["decorator_list"] as AstNode[];
    expect(decorators.map((node) => node.kind)).toEqual(["Name", "Call"]);
  });

  it("captures async syntax", async () => {
    const source = [
      "async def fetch(url):",
      "    async with session() as s:",
      "        data = s",
      "    async for chunk in gen():",
      "        await handle(chunk)",
      "    return [x async for x in gen()]",
      "",
    ].join("\n");
    const fn = await parseSingle(source);
    expect(fn.kind).toBe("AsyncFunctionDef");
    const body = fn.fields["body"] as AstNode[];
    expect(body.map((node) => node.kind)).toEqual(["AsyncWith", "AsyncFor", "Return"]);
    const returnValue = (body[2] as AstNode).fields["value"] as AstNode;
    expect(returnValue.kind).toBe("ListComp");
  });

  it("captures exception handling with else/finally", async () => {
    const source = [
      "try:",
      "    risky()",
      "except ValueError as err:",
      "    recover(err)",
      "except (TypeError, KeyError):",
      "    pass",
      "else:",
      "    ok()",
      "finally:",
      "    done()",
      "",
    ].join("\n");
    const tryNode = await parseSingle(source);
    expect(tryNode.kind).toBe("Try");
    const handlers = tryNode.fields["handlers"] as AstNode[];
    expect(handlers.map((node) => node.kind)).toEqual(["ExceptHandler", "ExceptHandler"]);
    const first = handlers[0] as AstNode;
    expect((first.fields["type"] as AstNode).fields["id"]).toBe("ValueError");
    expect(first.fields["name"]).toBe("err");
    expect((tryNode.fields["orelse"] as AstNode[]).length).toBe(1);
    expect((tryNode.fields["finalbody"] as AstNode[]).length).toBe(1);
  });

  it("tags JSON-hostile constants losslessly", async () => {
    const source = [
      "big = 123456789012345678901234567890",
      "data = b'ab'",
      "imag = 2.5j",
      "inf = 1e999",
      "el = ...",
    ].join("\n");
    const result = await parser.parse(source);
    const values = (result.ast.fields["body"] as AstNode[]).map(
      (node) => (node.fields["value"] as AstNode).fields["value"],
    );
    expect(values[0]).toEqual({ tag: "int", decimal: "123456789012345678901234567890" });
    expect(values[1]).toEqual({ tag: "bytes", base64: Buffer.from("ab").toString("base64") });
    expect(values[2]).toEqual({ tag: "complex", real: 0, imaginary: 2.5 });
    expect(values[3]).toEqual({ tag: "float", value: "inf" });
    expect(values[4]).toEqual({ tag: "ellipsis" });
  });

  it("keeps small ints and strings as native JSON values", async () => {
    const second = await parser.parse("n = 42\ns = 'héllo'\n");
    const values = (second.ast.fields["body"] as AstNode[]).map(
      (node) => (node.fields["value"] as AstNode).fields["value"],
    );
    expect(values[0]).toBe(42);
    expect(values[1]).toBe("héllo");
  });

  it("captures match statements (PEP 634 literal/capture forms)", async () => {
    const source = [
      "match command:",
      "    case 'go':",
      "        move()",
      "    case other:",
      "        stop(other)",
      "",
    ].join("\n");
    const match = await parseSingle(source);
    expect(match.kind).toBe("Match");
    const cases = match.fields["cases"] as AstNode[];
    expect(cases).toHaveLength(2);
    const firstPattern = cases[0]?.fields["pattern"] as AstNode;
    expect(firstPattern.kind).toBe("MatchValue");
    const secondPattern = cases[1]?.fields["pattern"] as AstNode;
    expect(secondPattern.kind).toBe("MatchAs");
  });
});
