// Responsibility (docs/architecture.md §3): semantic layer, module graph, transformation
// ledger, and pipeline orchestration. Cross-package types and engine interfaces live here
// (AGENTS.md §3, ADR D-017); implementation packages depend on these, never the reverse.
export const packageName = "@ctrans/core";

export { CTransError } from "./errors.js";
export { byteColumn, lineIndexOf, scanSourceLines } from "./source-lines.js";
export type { SourceLines } from "./source-lines.js";
export type { AstNode, AstValue, TaggedValue } from "./ast-node.js";
export type { Diagnostic, DiagnosticSeverity } from "./diagnostic.js";
export type {
  ExportKind,
  ImportKind,
  ModuleExport,
  ModuleImport,
  ModuleInfo,
} from "./module-info.js";
export type { ParseResult, ParserId, ParserInfo, SourceLanguage } from "./parse-result.js";
export type {
  JsParseOptions,
  JsParser,
  ParserDescription,
  PythonParseOptions,
  PythonParser,
} from "./parser.js";
export type { ScopeInfo, SymbolFlag, SymbolInfo } from "./scope.js";
export type { SourcePosition, SourceSpan } from "./source-span.js";
export type { TokenInfo } from "./token.js";
export type {
  TsDiagnostic,
  TsExportKind,
  TsExportSummary,
  TsModuleSummary,
  TsModuleSummaryQuery,
  TsOracleSourceFile,
  TsSemanticOracle,
  TsSymbolSummary,
  TsTypeAtQuery,
  TsTypeSummary,
} from "./ts-oracle.js";
