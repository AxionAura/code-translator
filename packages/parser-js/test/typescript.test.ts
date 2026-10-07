import { beforeAll, describe, expect, it } from "vitest";

import type { AstNode } from "@ctrans/core";

import { createOxcJsParser, type OxcJsParser } from "../src/oxc-parser.js";

let parser: OxcJsParser;

beforeAll(async () => {
  parser = await createOxcJsParser();
});

describe("TypeScript grammar coverage (oxc)", () => {
  it("captures interfaces, type aliases, and enums", async () => {
    const source = [
      "interface Point { readonly x: number; y?: string }",
      "type Pair<T> = [first: T, second: T];",
      "enum Color { Red = 1, Green }",
      "",
    ].join("\n");
    const result = await parser.parse(source, { language: "typescript" });
    const kinds = (result.ast.fields["body"] as AstNode[]).map((node) => node.kind);
    expect(kinds).toEqual([
      "TSInterfaceDeclaration",
      "TSTypeAliasDeclaration",
      "TSEnumDeclaration",
    ]);
  });

  it("captures generics, unions, intersections, and annotations", async () => {
    const fn = (await parser.parse(
      "function identity<T extends object>(value: T & { id: string } | null): T { return value; }\n",
      { language: "typescript" },
    )) as Awaited<ReturnType<OxcJsParser["parse"]>>;
    const declaration = (fn.ast.fields["body"] as AstNode[])[0]!;
    const typeParameters = declaration.fields["typeParameters"] as AstNode;
    expect((typeParameters.fields["params"] as AstNode[])[0]!.kind).toBe("TSTypeParameter");
    const returnType = declaration.fields["returnType"] as AstNode;
    expect(returnType.kind).toBe("TSTypeAnnotation");
  });

  it("captures access modifiers and optional properties", async () => {
    const cls = (await parser.parse(
      "class Box {\n  private readonly size = 1;\n  public label?: string;\n}\n",
      { language: "typescript" },
    )) as Awaited<ReturnType<OxcJsParser["parse"]>>;
    const body = ((cls.ast.fields["body"] as AstNode[])[0]!.fields["body"] as AstNode).fields[
      "body"
    ] as AstNode[];
    expect(body.map((node) => node.kind)).toEqual(["PropertyDefinition", "PropertyDefinition"]);
    expect(body[0]!.fields["accessibility"]).toBe("private");
    expect(body[0]!.fields["readonly"]).toBe(true);
    expect(body[1]!.fields["optional"]).toBe(true);
  });

  it("captures as-expressions and satisfies", async () => {
    const asExpr = (await parser.parse("const a = value as Secret;\n", { language: "typescript" }))
      .ast.fields["body"] as AstNode[];
    expect(
      ((asExpr[0]!.fields["declarations"] as AstNode[])[0]!.fields["init"] as AstNode).kind,
    ).toBe("TSAsExpression");
    const satisfies = (
      await parser.parse("const b = config satisfies Config;\n", { language: "typescript" })
    ).ast.fields["body"] as AstNode[];
    expect(
      ((satisfies[0]!.fields["declarations"] as AstNode[])[0]!.fields["init"] as AstNode).kind,
    ).toBe("TSSatisfiesExpression");
  });

  it("captures overloaded signatures and namespaces", async () => {
    const source = [
      "declare function pick(x: string): string;",
      "declare function pick(x: number): number;",
      "namespace App { export const version = 1; }",
      "",
    ].join("\n");
    const result = await parser.parse(source, { language: "typescript" });
    const kinds = (result.ast.fields["body"] as AstNode[]).map((node) => node.kind);
    expect(kinds).toEqual(["TSDeclareFunction", "TSDeclareFunction", "TSModuleDeclaration"]);
  });

  it("captures experimental decorators (legacy syntax)", async () => {
    const cls = (await parser.parse("@injectable\nclass Service {\n  @logged\n  run() {}\n}\n", {
      language: "typescript",
    })) as Awaited<ReturnType<OxcJsParser["parse"]>>;
    const declaration = (cls.ast.fields["body"] as AstNode[])[0]!;
    expect(declaration.kind).toBe("ClassDeclaration");
    expect((declaration.fields["decorators"] as AstNode[])[0]!.kind).toBe("Decorator");
  });
});
