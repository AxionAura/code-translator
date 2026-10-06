import type { ParseResult } from "./parse-result.js";

// Contract every Python front-end implements (D-003: CPython bridge is primary,
// tree-sitter is the documented fallback). Implementations live in @ctrans/parser-py;
// the pipeline receives them through this interface (D-017).
export interface PythonParser {
  parse(source: string, options?: PythonParseOptions): Promise<ParseResult>;
  // Capability report for preflight/doctor flows; never parses user source.
  describe(): Promise<ParserDescription>;
}

export interface PythonParseOptions {
  // Label used in diagnostics and error messages only. Parsers never read from disk.
  readonly filename?: string;
}

export interface ParserDescription {
  readonly id: string;
  readonly available: boolean;
  readonly runtimeVersion: string | null;
  readonly protocolVersion: number | null;
  readonly unavailableReason: string | null;
}
