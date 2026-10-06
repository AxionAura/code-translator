import type { AstNode } from "./ast-node.js";
import type { Diagnostic } from "./diagnostic.js";
import type { ScopeInfo } from "./scope.js";
import type { TokenInfo } from "./token.js";

export type SourceLanguage = "python" | "javascript" | "typescript";

export type ParserId = "cpython-bridge" | "tree-sitter";

// Which parser produced a result and at what fidelity. `degraded` marks parsers that
// cannot provide the full parser contract (tree-sitter has no scope analysis and
// produces a concrete syntax tree rather than a CPython AST) — consumers that need
// semantic information must check this instead of assuming.
export interface ParserInfo {
  readonly id: ParserId;
  readonly fidelity: "full" | "degraded";
  // Protocol version for the bridge, grammar package version for tree-sitter.
  readonly parserVersion: string;
  // Interpreter version for the bridge (e.g. "3.14.7"), null when not applicable.
  readonly runtimeVersion: string | null;
}

export interface ParseResult {
  readonly language: SourceLanguage;
  readonly filename: string;
  readonly parser: ParserInfo;
  readonly ast: AstNode; // the module/root node
  readonly tokens: readonly TokenInfo[];
  // null when the parser cannot provide scope analysis (tree-sitter fallback).
  readonly scopes: ScopeInfo | null;
  readonly diagnostics: readonly Diagnostic[];
}
