import type { SourceSpan } from "./source-span.js";

// Values that JSON cannot represent natively without loss. The bridge tags them so
// precision and type survive serialization: int literals beyond 2^53, non-finite float
// literals (`1e999` parses to inf), bytes, complex, and Ellipsis constants.
export type TaggedValue =
  | { readonly tag: "int"; readonly decimal: string }
  | { readonly tag: "float"; readonly value: "inf" | "-inf" | "nan" }
  | { readonly tag: "bytes"; readonly base64: string }
  | { readonly tag: "complex"; readonly real: number; readonly imaginary: number }
  | { readonly tag: "ellipsis" };

export type AstValue =
  null | boolean | number | string | AstNode | TaggedValue | readonly AstValue[];

// Generic AST envelope shared by every front-end. `kind` is the source parser's node
// name (CPython class names for Python, e.g. "FunctionDef"); field names and shapes are
// source-shaped per language (D-002) — this envelope makes them traversable and
// uniformly spanned, not semantically normalized. Nodes without source positions
// (CPython operator/context singletons) carry span = null.
export interface AstNode {
  readonly kind: string;
  readonly span: SourceSpan | null;
  readonly fields: Readonly<Record<string, AstValue>>;
}
