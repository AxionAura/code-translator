// Shared line-grid helpers for the Python front-end. The parser contract speaks UTF-8
// byte offsets and byte columns; upstream producers report code-point columns (CPython
// SyntaxError offsets, tree-sitter positions), so conversions live here.
export interface SourceLines {
  readonly lineTexts: readonly string[];
  // UTF-8 byte offset of each 0-based line start.
  readonly lineStarts: readonly number[];
}

// Mirrors the bridge's line scan: \n, \r\n, \r end a line; nothing else does (form
// feeds and other Unicode line boundaries do not create source lines).
export function scanSourceLines(text: string): SourceLines {
  const lineTexts: string[] = [];
  const lineStarts: number[] = [];
  let bytePos = 0;
  let lineStart = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\n" || ch === "\r") {
      const termLen = ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      lineTexts.push(text.slice(lineStart, i));
      lineStarts.push(bytePos);
      bytePos += Buffer.byteLength(text.slice(lineStart, i), "utf8") + termLen;
      i += termLen;
      lineStart = i;
    } else {
      i += 1;
    }
  }
  lineTexts.push(text.slice(lineStart));
  lineStarts.push(bytePos);
  return { lineTexts, lineStarts };
}

// Converts a 0-based code-point column on a line into the contract's byte column.
export function byteColumn(lineText: string, charColumn: number): number {
  return Buffer.byteLength(lineText.slice(0, charColumn), "utf8");
}
