// CommonType v1 (docs/architecture.md §4): the language-neutral type algebra of the
// semantic layer. It models only concepts shared across Python ↔ JS/TS translation
// (D-002) — language-specific type systems stay in the source AST. Every use site is
// wrapped in an `AnnotatedType` carrying provenance: a dynamic Python value becomes
// `unknown`, never an invented `string` (honesty invariant, AGENTS.md §11).

import type { SourceSpan } from "./source-span.js";

export type TypeOrigin =
  // Written in the source (annotation/assertion).
  | "explicit"
  // Derived by our conservative inference from literals/expressions.
  | "inferred"
  // Reported by the TypeScript semantic oracle.
  | "oracle";

export type TypeConfidence =
  // The mapping is lossless for the target languages.
  | "exact"
  // Mapped with documented approximations (e.g. Python `int` → JS number).
  | "approximate"
  // Nothing is known; the type is an honest unknown.
  | "unknown";

export interface AnnotatedType {
  readonly type: CommonType;
  readonly origin: TypeOrigin;
  readonly confidence: TypeConfidence;
  readonly span: SourceSpan | null;
}

// `numberKind` distinguishes Python int/float (drives D-006 precision diagnostics
// later); JS numbers carry no numberKind. `literalKind: "bigint"` marks bigint
// literals whose value is a decimal string.
export type CommonType =
  | { readonly kind: "unknown" }
  | { readonly kind: "any" }
  | { readonly kind: "never" }
  | { readonly kind: "null" }
  | { readonly kind: "undefined" }
  | { readonly kind: "void" }
  | { readonly kind: "boolean" }
  | { readonly kind: "number"; readonly numberKind?: "int" | "float" }
  | { readonly kind: "bigint" }
  | { readonly kind: "string" }
  | { readonly kind: "bytes" }
  | { readonly kind: "symbol" }
  | { readonly kind: "object" }
  | { readonly kind: "array"; readonly elementType: CommonType }
  | { readonly kind: "tuple"; readonly elements: readonly CommonType[] }
  | { readonly kind: "set"; readonly elementType: CommonType }
  | { readonly kind: "map"; readonly keyType: CommonType; readonly valueType: CommonType }
  | {
      readonly kind: "function";
      readonly paramTypes: readonly CommonType[];
      readonly returnType: CommonType;
      readonly async: boolean;
    }
  | { readonly kind: "class"; readonly name: string | null }
  | { readonly kind: "instance"; readonly className: string }
  | { readonly kind: "generator"; readonly elementType: CommonType }
  | { readonly kind: "iterator"; readonly elementType: CommonType }
  | { readonly kind: "promise"; readonly valueType: CommonType }
  | { readonly kind: "union"; readonly members: readonly CommonType[] }
  | { readonly kind: "intersection"; readonly members: readonly CommonType[] }
  | {
      readonly kind: "literal";
      readonly value: boolean | number | string | null;
      readonly literalKind?: "bigint";
    }
  | { readonly kind: "optional"; readonly innerType: CommonType }
  | { readonly kind: "typeParameter"; readonly name: string }
  | { readonly kind: "module"; readonly name: string | null };

export const UNKNOWN: CommonType = { kind: "unknown" };

export function annotate(
  type: CommonType,
  origin: TypeOrigin,
  confidence: TypeConfidence,
  span: SourceSpan | null = null,
): AnnotatedType {
  return { type, origin, confidence, span };
}

// The canonical "analyzed but dynamic" answer.
export function unknownType(span: SourceSpan | null = null): AnnotatedType {
  return { type: UNKNOWN, origin: "inferred", confidence: "unknown", span };
}
