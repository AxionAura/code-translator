import type { SourceSpan } from "./source-span.js";

// TypeScript semantic-oracle contract (D-004, roadmap M2). The interface lives in core
// so the rest of the project never depends on TypeScript compiler API objects; the
// pinned typescript@6 implementation lives in @ctrans/parser-js and is replaceable when
// the TypeScript 7.1+ API lands. All queries are synchronous, in-memory, and
// deterministic: sources are provided as virtual files, nothing is read from disk.

export interface TsOracleSourceFile {
  readonly filename: string;
  readonly source: string;
}

export interface TsTypeSummary {
  // checker.typeToString output (human-readable, version-dependent wording).
  readonly display: string;
  readonly flags: readonly string[];
}

export interface TsSymbolSummary {
  readonly name: string;
  readonly symbolFlags: readonly string[];
  readonly type: TsTypeSummary | null;
  // Spans of the symbol's declarations in its own source file.
  readonly declarations: readonly SourceSpan[];
}

export type TsExportKind = "value" | "type" | "namespace" | "other";

export interface TsExportSummary extends TsSymbolSummary {
  readonly exportKind: TsExportKind;
}

export interface TsDiagnostic {
  readonly severity: "error" | "warning" | "suggestion" | "message";
  readonly code: number;
  readonly message: string;
  readonly span: SourceSpan | null;
}

export interface TsModuleSummary {
  readonly filename: string;
  // Syntactic + semantic diagnostics for the requested file.
  readonly diagnostics: readonly TsDiagnostic[];
  // Export surface of the module (empty for scripts without export syntax).
  readonly exports: readonly TsExportSummary[];
}

export interface TsModuleSummaryQuery {
  readonly files: readonly TsOracleSourceFile[];
  readonly filename: string;
}

export interface TsTypeAtQuery {
  readonly files: readonly TsOracleSourceFile[];
  readonly filename: string;
  // UTF-8 byte offset into the requested file's source.
  readonly byteOffset: number;
}

export interface TsSemanticOracle {
  summarizeModule(query: TsModuleSummaryQuery): TsModuleSummary;
  // Type of the innermost token at the given position; null when nothing is there.
  typeAt(query: TsTypeAtQuery): TsTypeSummary | null;
}
