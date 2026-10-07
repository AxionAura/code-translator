// Shared line-grid helpers for the parser contract. Spans speak UTF-8 byte offsets and
// byte columns; upstream producers report code-point columns (CPython SyntaxError,
// tokenize, tree-sitter) or UTF-16 indices (ESTree parsers), so conversions live here.
export interface SourceLines {
  readonly lineTexts: readonly string[];
  // UTF-8 byte offset of each 0-based line start.
  readonly lineStarts: readonly number[];
}

// Mirrors the Python bridge's line scan: \n, \r\n, \r end a line; nothing else does
// (form feeds and other Unicode line boundaries do not create source lines).
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

// Index of the line containing a byte offset (the last line whose start is <= offset).
export function lineIndexOf(lineStarts: readonly number[], byteOffset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  let result = 0;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const start = lineStarts[mid]!;
    if (start <= byteOffset) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}
