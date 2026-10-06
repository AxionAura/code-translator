import { beforeAll, describe, expect, it } from "vitest";

import { createPythonBridgeParser, type PythonBridgeParser } from "../src/client.js";

let parser: PythonBridgeParser;

beforeAll(async () => {
  parser = await createPythonBridgeParser();
});

describe("token and comment stream", () => {
  it("captures comments with exact spans (comments are not in the AST)", async () => {
    const source = "# leading\nx = 1  # trailing\n";
    const result = await parser.parse(source);
    const comments = result.tokens.filter((token) => token.kind === "COMMENT");
    expect(comments.map((token) => token.text)).toEqual(["# leading", "# trailing"]);
    expect(comments[0]?.span).toEqual({
      start: { line: 0, column: 0 },
      end: { line: 0, column: 9 },
      startByteOffset: 0,
      endByteOffset: 9,
    });
    const astHasComment = JSON.stringify(result.ast).includes("leading");
    expect(astHasComment).toBe(false);
  });

  it("captures indentation as INDENT/DEDENT tokens", async () => {
    const source = "if a:\n    b()\nc()\n";
    const result = await parser.parse(source);
    const kinds = result.tokens.map((token) => token.kind);
    expect(kinds).toContain("INDENT");
    expect(kinds).toContain("DEDENT");
    const indent = result.tokens.find((token) => token.kind === "INDENT");
    expect(indent?.text).toBe("    ");
  });

  it("captures multiline strings with multi-line spans", async () => {
    const source = 's = """a\n日\n"""\n';
    const result = await parser.parse(source);
    const stringToken = result.tokens.find((token) => token.kind === "STRING");
    expect(stringToken?.text).toBe('"""a\n日\n"""');
    expect(stringToken?.span.start.line).toBe(0);
    expect(stringToken?.span.end.line).toBe(2);
    expect(stringToken?.span.endByteOffset).toBe(Buffer.byteLength(source, "utf8") - 1);
  });

  it("keeps NL tokens for blank lines and NEWLINE for statement ends", async () => {
    const source = "a = 1\n\nb = 2\n";
    const result = await parser.parse(source);
    const kinds = result.tokens.map((token) => token.kind);
    expect(kinds.filter((kind) => kind === "NL")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "NEWLINE")).toHaveLength(2);
  });

  it("preserves unicode content in token text", async () => {
    const source = "greeting = 'héllo wörld 🎉'\n";
    const result = await parser.parse(source);
    const stringToken = result.tokens.find((token) => token.kind === "STRING");
    expect(stringToken?.text).toBe("'héllo wörld 🎉'");
  });

  it("ends the stream with an ENDMARKER", async () => {
    const result = await parser.parse("x = 1\n");
    expect(result.tokens.at(-1)?.kind).toBe("ENDMARKER");
  });
});
