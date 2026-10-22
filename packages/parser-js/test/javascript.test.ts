import { beforeAll, describe, expect, it } from "vitest";

import type { AstNode } from "@axion-ct/core";

import { createOxcJsParser, type OxcJsParser } from "../src/oxc-parser.js";

let parser: OxcJsParser;

beforeAll(async () => {
  parser = await createOxcJsParser();
});

async function singleStatement(source: string): Promise<AstNode> {
  const result = await parser.parse(source, { language: "javascript" });
  const body = result.ast.fields["body"];
  expect(Array.isArray(body)).toBe(true);
  return (body as AstNode[])[0]!;
}

describe("JavaScript grammar coverage (oxc)", () => {
  it("captures declarations, arrow functions, and template literals", async () => {
    const fn = await singleStatement("const double = (n) => n * 2;\n");
    expect(fn.kind).toBe("VariableDeclaration");
    const declarator = (fn.fields["declarations"] as AstNode[])[0]!;
    expect((declarator.fields["init"] as AstNode).kind).toBe("ArrowFunctionExpression");
  });

  it("captures classes with inheritance and methods", async () => {
    const cls = await singleStatement("class Circle extends Shape {\n  area() { return 0; }\n}\n");
    expect(cls.kind).toBe("ClassDeclaration");
    expect((cls.fields["superClass"] as AstNode).kind).toBe("Identifier");
    const method = ((cls.fields["body"] as AstNode).fields["body"] as AstNode[])[0]!;
    expect(method.kind).toBe("MethodDefinition");
  });

  it("captures destructuring, spread, and object/array literals", async () => {
    const destructuring = await singleStatement("const { a, b: renamed, ...rest } = source;\n");
    const pattern = (destructuring.fields["declarations"] as AstNode[])[0]!.fields["id"] as AstNode;
    expect(pattern.kind).toBe("ObjectPattern");
    expect(pattern.fields["properties"] as AstNode[]).toHaveLength(3);
    const spread = await singleStatement("const merged = [...left, ...right];\n");
    const elements = ((spread.fields["declarations"] as AstNode[])[0]!.fields["init"] as AstNode)
      .fields["elements"] as AstNode[];
    expect((elements[0] as AstNode).kind).toBe("SpreadElement");
  });

  it("captures control flow and exception handling", async () => {
    const tryNode = await singleStatement(
      "try {\n  risky();\n} catch (error) {\n  log(error);\n} finally {\n  done();\n}\n",
    );
    expect(tryNode.kind).toBe("TryStatement");
    expect(((tryNode.fields["handler"] as AstNode).fields["param"] as AstNode).kind).toBe(
      "Identifier",
    );
    expect((tryNode.fields["finalizer"] as AstNode).kind).toBe("BlockStatement");
    const loop = await singleStatement("for (const item of items) { use(item); }\n");
    expect(loop.kind).toBe("ForOfStatement");
  });

  it("captures async, await, and generators", async () => {
    const fn = await singleStatement(
      "async function* stream() {\n  await Promise.resolve();\n  yield 1;\n}\n",
    );
    expect(fn.kind).toBe("FunctionDeclaration");
    expect(fn.fields["async"]).toBe(true);
    expect(fn.fields["generator"]).toBe(true);
    const body = (fn.fields["body"] as AstNode).fields["body"] as AstNode[];
    expect(body.map((node) => node.kind)).toEqual(["ExpressionStatement", "ExpressionStatement"]);
    // `yield 1` is an expression statement wrapping a YieldExpression.
    expect((body[1]!.fields["expression"] as AstNode).kind).toBe("YieldExpression");
  });

  it("captures modern operators", async () => {
    const chain = await singleStatement("const city = profile?.address?.city ?? 'unknown';\n");
    const init = (chain.fields["declarations"] as AstNode[])[0]!.fields["init"] as AstNode;
    expect(init.kind).toBe("LogicalExpression");
    expect(init.fields["operator"]).toBe("??");
  });

  it("captures numeric edge literals without precision loss", async () => {
    const big = await singleStatement("const huge = 9007199254740993n;\n");
    const literal = (big.fields["declarations"] as AstNode[])[0]!.fields["init"] as AstNode;
    // ESTree models bigints as Literal with a `bigint` string field - exact digits.
    expect(literal.kind).toBe("Literal");
    expect(literal.fields["bigint"]).toBe("9007199254740993");
  });

  it("flattens regex literal payloads into dotted fields", async () => {
    const regex = await singleStatement("const re = /a+b/gi;\n");
    const literal = (regex.fields["declarations"] as AstNode[])[0]!.fields["init"] as AstNode;
    expect(literal.kind).toBe("Literal");
    expect(literal.fields["regex.pattern"]).toBe("a+b");
    expect(literal.fields["regex.flags"]).toBe("gi");
  });

  it("captures import and export statements", async () => {
    const result = await parser.parse(
      "import def, { named as alias } from './mod.js';\nexport const out = 1;\nexport * as ns from './other.js';\n",
      { language: "javascript" },
    );
    const kinds = (result.ast.fields["body"] as AstNode[]).map((node) => node.kind);
    expect(kinds).toEqual(["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"]);
  });
});
