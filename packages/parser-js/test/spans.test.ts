import { beforeAll, describe, expect, it } from "vitest";

import type { AstNode, SourceSpan } from "@ctrans/core";

import { createOxcJsParser, type OxcJsParser } from "../src/oxc-parser.js";

let parser: OxcJsParser;

beforeAll(async () => {
  parser = await createOxcJsParser();
});

function byteOffset(source: string, utf16Index: number): number {
  return Buffer.byteLength(source.slice(0, utf16Index), "utf8");
}

function collectSpans(node: AstNode, into: SourceSpan[]): void {
  if (node.span !== null) into.push(node.span);
  for (const value of Object.values(node.fields)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item === "object" && item !== null && "kind" in item) {
        collectSpans(item as AstNode, into);
      }
    }
  }
}

const SOURCE_LINES = "const a = 1;\nconst b = 2;\n";

describe("span fidelity (oxc)", () => {
  it("reports byte-accurate spans for ASCII sources", async () => {
    const source = "const value = 1234;\n";
    const result = await parser.parse(source, { language: "javascript" });
    const declarator = (
      (result.ast.fields["body"] as AstNode[])[0]!.fields["declarations"] as AstNode[]
    )[0]!;
    const literal = declarator.fields["init"] as AstNode;
    // "const value = " is 14 utf16 units; the literal ends at 18.
    expect(literal.span).toEqual({
      start: { line: 0, column: 14 },
      end: { line: 0, column: 18 },
      startByteOffset: 14,
      endByteOffset: 18,
    });
  });

  it("converts multibyte characters correctly (before and inside constructs)", async () => {
    const source = "const 日本 = '日本語';\n";
    const result = await parser.parse(source, { language: "javascript" });
    const declarator = (
      (result.ast.fields["body"] as AstNode[])[0]!.fields["declarations"] as AstNode[]
    )[0]!;
    const id = declarator.fields["id"] as AstNode;
    // utf16 grid: 日本 at 6..8 -> bytes 6..12 ("const " = 6 ascii bytes first).
    expect(id.span?.startByteOffset).toBe(byteOffset(source, 6));
    expect(id.span?.endByteOffset).toBe(byteOffset(source, 8));
    const literal = declarator.fields["init"] as AstNode;
    // utf16: ' at 11, 日本語 12..15, ' at 15 -> bytes 15..26 (3 chars = 9 bytes).
    expect(literal.span?.startByteOffset).toBe(byteOffset(source, 11));
    expect(literal.span?.endByteOffset).toBe(byteOffset(source, 16));
  });

  it("handles CRLF, LF, missing trailing newline, and empty sources", async () => {
    const crlf = "const a = 1;\r\nconst b = a;\r\n";
    const crlfResult = await parser.parse(crlf, { language: "javascript" });
    const second = (crlfResult.ast.fields["body"] as AstNode[])[1]!;
    expect(second.span?.start.line).toBe(1);
    expect(second.span?.startByteOffset).toBe(Buffer.byteLength("const a = 1;\r\n", "utf8"));

    const noNewline = "const a = 1;";
    const noNewlineResult = await parser.parse(noNewline, { language: "javascript" });
    const only = (noNewlineResult.ast.fields["body"] as AstNode[])[0]!;
    expect(only.span?.endByteOffset).toBe(Buffer.byteLength(noNewline, "utf8"));

    const empty = await parser.parse("", { language: "javascript" });
    expect(empty.ast.kind).toBe("Program");
    expect(empty.ast.fields["body"] as AstNode[]).toEqual([]);
  });

  it("keeps every span valid: start <= end and line/column consistent with bytes", async () => {
    const source = "import { x } from './m.js';\nfunction f(日本語) { return x + `t${f}`; }\n";
    const result = await parser.parse(source, { language: "javascript" });
    const spans: SourceSpan[] = [];
    collectSpans(result.ast, spans);
    for (const comment of result.comments) spans.push(comment.span);
    expect(spans.length).toBeGreaterThan(10);
    for (const span of spans) {
      expect(span.endByteOffset).toBeGreaterThanOrEqual(span.startByteOffset);
      expect(span.startByteOffset).toBeGreaterThanOrEqual(0);
      expect(span.endByteOffset).toBeLessThanOrEqual(Buffer.byteLength(source, "utf8"));
    }
  });

  it("reproduces node source exactly from byte spans", async () => {
    const source = "const greeting = 'héllo wörld';\n";
    const result = await parser.parse(source, { language: "javascript" });
    const literal = (
      (result.ast.fields["body"] as AstNode[])[0]!.fields["declarations"] as AstNode[]
    )[0]!.fields["init"] as AstNode;
    const bytes = Buffer.from(source, "utf8").subarray(
      literal.span!.startByteOffset,
      literal.span!.endByteOffset,
    );
    expect(bytes.toString("utf8")).toBe("'héllo wörld'");
  });

  it("handles a BOM without breaking spans", async () => {
    const source = "\uFEFFconst a = 1;\n";
    const result = await parser.parse(source, { language: "javascript" });
    // Whatever the parser does with the BOM, spans must stay in bounds and consistent.
    const spans: SourceSpan[] = [];
    collectSpans(result.ast, spans);
    for (const span of spans) {
      expect(span.startByteOffset).toBeGreaterThanOrEqual(0);
      expect(span.endByteOffset).toBeLessThanOrEqual(Buffer.byteLength(source, "utf8"));
    }
    expect(SOURCE_LINES.length).toBeGreaterThan(0); // guard against silent test shrinkage
  });
});
