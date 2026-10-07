import type { AstNode } from "./ast-node.js";
import type { Diagnostic } from "./diagnostic.js";
import type { ModuleInfo } from "./module-info.js";
import type { ScopeInfo } from "./scope.js";
import type { TokenInfo } from "./token.js";

export type SourceLanguage = "python" | "javascript" | "typescript";

export type ParserId = "cpython-bridge" | "tree-sitter" | "oxc" | "babel";

// Which parser produced a result and at what fidelity. `degraded` marks parsers that
// cannot provide the full parser contract (tree-sitter has no scope analysis and
// produces a concrete syntax tree rather than a source-shaped AST; Babel's recovered
// parses carry no error list) — consumers must check this instead of assuming.
export interface ParserInfo {
  readonly id: ParserId;
  readonly fidelity: "full" | "degraded";
  // Protocol version for the bridge, package versions for in-process parsers.
  readonly parserVersion: string;
  // Interpreter version for the bridge (e.g. "3.14.7"), null when not applicable.
  readonly runtimeVersion: string | null;
}

export interface ParseResult {
  readonly language: SourceLanguage;
  readonly filename: string;
  readonly parser: ParserInfo;
  readonly ast: AstNode; // the module/root node
  // Comments as standalone tokens with spans. Full token streams are producer-specific:
  // the Python bridge emits its complete stream in `tokens` (comments included there
  // too), while the JS front-ends emit only comments (D-019) — downstream provenance
  // work derives everything else from the AST.
  readonly tokens: readonly TokenInfo[];
  readonly comments: readonly TokenInfo[];
  readonly module: ModuleInfo | null; // null when the front-end does not extract it yet
  // null when the parser cannot provide scope analysis (tree-sitter fallback, JS).
  readonly scopes: ScopeInfo | null;
  readonly diagnostics: readonly Diagnostic[];
}
