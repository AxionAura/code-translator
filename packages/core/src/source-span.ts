// Source positions (docs/architecture.md §2). UTF-8 byte offsets are authoritative;
// line/column are presentation data. Lines are 0-based, columns are UTF-8 byte offsets
// from the line start (matching CPython's ast col_offset semantics), and `end` is
// exclusive. The Python bridge converts tokenize's 1-based rows and code-point columns
// into this contract so every producer speaks the same units.
export interface SourcePosition {
  readonly line: number;
  readonly column: number;
}

export interface SourceSpan {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
  readonly startByteOffset: number;
  readonly endByteOffset: number;
}
