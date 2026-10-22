import { beforeAll, describe, expect, it } from "vitest";

import type { AstNode } from "@axion-ct/core";

import { createOxcJsParser, type OxcJsParser } from "../src/oxc-parser.js";

let parser: OxcJsParser;

beforeAll(async () => {
  parser = await createOxcJsParser();
});

describe("JSX / TSX support (oxc)", () => {
  it("parses JSX elements, attributes, and expressions", async () => {
    const result = await parser.parse(
      'const el = <Button size={3} label="go">text {count}</Button>;\n',
      { language: "javascript", jsx: true },
    );
    const init = (
      (result.ast.fields["body"] as AstNode[])[0]!.fields["declarations"] as AstNode[]
    )[0]!.fields["init"] as AstNode;
    expect(init.kind).toBe("JSXElement");
    const attributes = init.fields["openingElement"]
      ? ((init.fields["openingElement"] as AstNode).fields["attributes"] as AstNode[])
      : [];
    expect(attributes.length).toBeGreaterThanOrEqual(2);
  });

  it("parses fragments", async () => {
    const result = await parser.parse("const f = <>one</>;\n", {
      language: "javascript",
      jsx: true,
    });
    const init = (
      (result.ast.fields["body"] as AstNode[])[0]!.fields["declarations"] as AstNode[]
    )[0]!.fields["init"] as AstNode;
    expect(init.kind).toBe("JSXFragment");
  });

  it("parses TSX with generic arrow functions (the <T,> ambiguity)", async () => {
    const result = await parser.parse("const pick = <T,>(x: T): T => x;\n", {
      language: "typescript",
      jsx: true,
    });
    const init = (
      (result.ast.fields["body"] as AstNode[])[0]!.fields["declarations"] as AstNode[]
    )[0]!.fields["init"] as AstNode;
    expect(init.kind).toBe("ArrowFunctionExpression");
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects JSX when the jsx flag is off", async () => {
    const result = await parser.parse("const el = <div />;\n", { language: "javascript" });
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });
});
