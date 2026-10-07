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

// Contract every JS/TS front-end implements (D-004: oxc primary, Babel fallback).
// Implementations live in @ctrans/parser-js. The language is explicit per parse —
// front-ends never guess grammar mode from file extensions.
export interface JsParser {
  parse(source: string, options: JsParseOptions): Promise<ParseResult>;
  describe(): Promise<ParserDescription>;
}

export interface JsParseOptions {
  // Label used in diagnostics and error messages only. Parsers never read from disk.
  readonly filename?: string;
  readonly language: "javascript" | "typescript";
  // Enables JSX/TSX grammar on top of the selected language.
  readonly jsx?: boolean;
}
