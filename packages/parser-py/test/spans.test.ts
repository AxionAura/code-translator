import { beforeAll, describe, expect, it } from "vitest";

import type { AstNode, SourceSpan, TokenInfo } from "@axion-ct/core";

import { createPythonBridgeParser, type PythonBridgeParser } from "../src/client.js";

let parser: PythonBridgeParser;

beforeAll(async () => {
  parser = await createPythonBridgeParser();
});

// Ground truth: byte offset of a character index in the UTF-8 encoding of the source.
function byteOffset(source: string, charIndex: number): number {
  return Buffer.byteLength(source.slice(0, charIndex), "utf8");
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

// Independent recomputation of the contract: the byte offset of a (line, byte-column)
// position is the UTF-8 length of all preceding lines plus the column.
function expectedByteOffset(source: string, line: number, byteColumnValue: number): number {
  const lines = source.split("\n");
  let offset = 0;
  for (let i = 0; i < line; i += 1) {
    offset += Buffer.byteLength(lines[i] ?? "", "utf8") + 1;
  }
  return offset + byteColumnValue;
}

describe("span fidelity", () => {
  it("reports ASCII spans with byte-accurate offsets and end positions", async () => {
    const source = "def greet(name):\n    return name\n";
    const result = await parser.parse(source);
    const fn = (result.ast.fields["body"] as AstNode[])[0] as AstNode;
    expect(fn.kind).toBe("FunctionDef");
    expect(fn.span).toEqual({
      start: { line: 0, column: 0 },
      end: { line: 1, column: 15 },
      startByteOffset: 0,
      endByteOffset: byteOffset(source, "def greet(name):\n    return name".length),
    });
    const returnName = ((fn.fields["body"] as AstNode[])[0] as AstNode).fields["value"] as AstNode;
    const start = byteOffset(source, source.indexOf("return name") + "return ".length);
    expect(returnName.span).toEqual({
      start: { line: 1, column: 11 },
      end: { line: 1, column: 15 },
      startByteOffset: start,
      endByteOffset: start + 4,
    });
  });

  it("uses UTF-8 byte columns when multibyte characters precede a construct", async () => {
    const source = "日本 = x\nseñor = y\n";
    const result = await parser.parse(source);
    const body = result.ast.fields["body"] as AstNode[];
    const firstName = (body[0] as AstNode).fields["targets"] as AstNode[];
    expect(firstName[0]?.span).toEqual({
      start: { line: 0, column: 0 },
      end: { line: 0, column: byteOffset(source, 2) }, // 日本 = 6 bytes
      startByteOffset: 0,
      endByteOffset: 6,
    });
    const secondName = (body[1] as AstNode).fields["targets"] as AstNode[];
    // señor is 6 bytes; the identifier starts at byte column 0 of line 1.
    expect(secondName[0]?.span?.start).toEqual({ line: 1, column: 0 });
    expect(secondName[0]?.span?.startByteOffset).toBe(byteOffset(source, 7));
    expect(secondName[0]?.span?.endByteOffset).toBe(byteOffset(source, 12));
  });

  it("handles multibyte characters inside constructs", async () => {
    const source = "text = '日本語'\n";
    const result = await parser.parse(source);
    const assign = (result.ast.fields["body"] as AstNode[])[0] as AstNode;
    const constant = assign.fields["value"] as AstNode;
    expect(constant.fields["value"]).toBe("日本語");
    const stringSpan = constant.span;
    expect(stringSpan?.startByteOffset).toBe(byteOffset(source, 7));
    expect(stringSpan?.endByteOffset).toBe(byteOffset(source, 12)); // 3 chars + 9 bytes payload
  });

  it("keeps ast spans and token spans on one byte grid", async () => {
    const source = '# comment\ndef f(x):\n    return f"x={x} é"\n';
    const result = await parser.parse(source);
    const spans: SourceSpan[] = [];
    collectSpans(result.ast, spans);
    for (const token of result.tokens as readonly TokenInfo[]) spans.push(token.span);
    const sourceBytes = Buffer.byteLength(source, "utf8");
    for (const span of spans) {
      expect(span.startByteOffset).toBeGreaterThanOrEqual(0);
      expect(span.endByteOffset).toBeLessThanOrEqual(sourceBytes);
      expect(span.endByteOffset).toBeGreaterThanOrEqual(span.startByteOffset);
      expect(span.startByteOffset).toBe(
        expectedByteOffset(source, span.start.line, span.start.column),
      );
      expect(span.endByteOffset).toBe(expectedByteOffset(source, span.end.line, span.end.column));
    }
    // Spot-check: a token's byte slice reproduces its text exactly.
    const comment = result.tokens.find((token) => token.kind === "COMMENT");
    expect(comment).toBeDefined();
    const commentBytes = Buffer.from(source, "utf8").subarray(
      comment?.span.startByteOffset ?? 0,
      comment?.span.endByteOffset ?? 0,
    );
    expect(commentBytes.toString("utf8")).toBe(comment?.text);
  });

  it("supports CRLF line endings with correct line numbering", async () => {
    const source = "a = 1\r\nb = a\r\n";
    const result = await parser.parse(source);
    const body = result.ast.fields["body"] as AstNode[];
    const second = body[1] as AstNode;
    expect(second.span?.start.line).toBe(1);
    expect(second.span?.startByteOffset).toBe(Buffer.byteLength("a = 1\r\n", "utf8"));
  });

  it("leaves the module node without a span (CPython ast.Module has none)", async () => {
    const source = "x = 1\ny = 2\n";
    const result = await parser.parse(source);
    expect(result.ast.span).toBeNull();
  });
});
