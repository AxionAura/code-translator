import type { SourceSpan } from "./source-span.js";

// One token from the source parser's stream. `kind` vocabulary is parser-specific
// (CPython token names for Python: NAME, OP, STRING, COMMENT, INDENT, DEDENT, NL,
// NEWLINE, ENDMARKER, ...). Structural tokens are kept because comment attachment and
// provenance mapping need them; comments are not part of the AST.
export interface TokenInfo {
  readonly kind: string;
  readonly text: string;
  readonly span: SourceSpan;
}
