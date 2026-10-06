import type { SourceSpan } from "./source-span.js";

export type DiagnosticSeverity = "warning" | "info";

// Non-fatal reports attached to a parse result. Fatal conditions are thrown as typed
// errors instead (AGENTS.md §7); codes use the CTP- prefix for parser-level findings.
export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly span: SourceSpan | null;
}
