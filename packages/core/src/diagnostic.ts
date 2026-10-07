import type { SourceSpan } from "./source-span.js";

// `error` covers parsers with error recovery (e.g. oxc returns a partial tree plus
// error diagnostics — D-019); fatal, unrecoverable parse failures are thrown as typed
// errors instead (AGENTS.md §7).
export type DiagnosticSeverity = "error" | "warning" | "info";

// Non-fatal reports attached to a parse result. Codes use the CTP- prefix for
// parser-level findings; JS front-ends use the JS- prefix.
export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly span: SourceSpan | null;
}
