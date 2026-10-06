// Responsibility (docs/architecture.md §3): semantic layer, module graph, transformation
// ledger, and pipeline orchestration. Cross-package types and engine interfaces live here
// (AGENTS.md §3, ADR D-017); implementation packages depend on these, never the reverse.
export const packageName = "@ctrans/core";

export { CTransError } from "./errors.js";
export type { AstNode, AstValue, TaggedValue } from "./ast-node.js";
export type { Diagnostic, DiagnosticSeverity } from "./diagnostic.js";
export type { ParseResult, ParserId, ParserInfo, SourceLanguage } from "./parse-result.js";
export type { ParserDescription, PythonParseOptions, PythonParser } from "./parser.js";
export type { ScopeInfo, SymbolFlag, SymbolInfo } from "./scope.js";
export type { SourcePosition, SourceSpan } from "./source-span.js";
export type { TokenInfo } from "./token.js";
