// Semantic model contracts (docs/architecture.md §4): language-neutral scopes, symbols,
// and their resolution. The model is produced per module by the semantic analyzers in
// this package (semantic-python.ts / semantic-javascript.ts) from the source-shaped
// ParseResult; language differences (Python class scope, JS var hoisting, TDZ, …) are
// modeled explicitly instead of flattened (D-002).
import type { AnnotatedType } from "./common-type.js";
import type { SourceLanguage } from "./parse-result.js";
import type { SourceSpan as Span } from "./source-span.js";

export type ScopeKind =
  "module" | "function" | "class" | "block" | "parameter" | "catch" | "type" | "comprehension";

export type SymbolKind =
  | "variable"
  | "constant"
  | "parameter"
  | "function"
  | "class"
  | "method"
  | "property"
  | "import"
  | "type"
  | "enum"
  | "namespace"
  | "typeParameter";

export type ReferenceContext = "read" | "write" | "delete";

// Value/type namespace distinction (TypeScript); Python/JS declarations are "value".
export type DeclarationNamespace = "value" | "type" | "both";

export interface SymbolReference {
  // Span of the referencing identifier.
  readonly span: Span;
  readonly context: ReferenceContext;
  // Scope containing the reference (not the declaring scope).
  readonly scopeId: string;
}

export interface SymbolEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly scopeId: string;
  readonly declarationSpan: Span | null;
  readonly references: readonly SymbolReference[];
  // null = not analyzed; an AnnotatedType with confidence "unknown" = analyzed and
  // honestly dynamic. Never an invented concrete type (AGENTS.md §11).
  readonly type: AnnotatedType | null;
  readonly mutability: "mutable" | "readonly" | "unknown";
  readonly exported: boolean;
  readonly imported: boolean;
  // For kind "import": module specifier and the originally imported name.
  readonly importSpecifier: string | null;
  readonly importedName: string | null;
  readonly namespace: DeclarationNamespace;
  // Language-specific flags kept verbatim (e.g. Python isFree/isGlobal/isNonlocal,
  // JS isVar), so nothing is flattened away.
  readonly languageFlags: Readonly<Record<string, boolean>>;
}

export interface ScopeNode {
  readonly id: string;
  readonly kind: ScopeKind;
  readonly name: string | null;
  readonly language: SourceLanguage;
  readonly span: Span | null;
  readonly parent: string | null;
  readonly children: readonly string[];
  readonly symbolIds: readonly string[];
  // Language-specific scope facts, e.g. Python class bodies are not visible to
  // methods; JS block scopes nest lexically.
  readonly notes: readonly string[];
}

export type SemanticSeverity = "error" | "warning" | "info";

export interface SemanticDiagnostic {
  readonly severity: SemanticSeverity;
  readonly code: string;
  readonly message: string;
  readonly span: Span | null;
}

export interface SemanticModel {
  readonly language: SourceLanguage;
  readonly filename: string;
  // Flat, id-keyed maps; children/parents reference ids. Construction order follows
  // the deterministic AST walk, so the whole model serializes stably.
  readonly scopes: Readonly<Record<string, ScopeNode>>;
  readonly symbols: Readonly<Record<string, SymbolEntry>>;
  readonly rootScopeId: string;
  // References that resolved to no binding (builtins, JS globals, true typos).
  // Resolution policy is per-language: Python unresolved names are warned about in
  // the graph phase; JS globals are ordinary and carry no diagnostic.
  readonly unresolvedReferences: ReadonlyArray<{
    readonly name: string;
    readonly reference: SymbolReference;
  }>;
  readonly diagnostics: readonly SemanticDiagnostic[];
}

export function symbolName(model: SemanticModel, id: string): string {
  const symbol = model.symbols[id];
  if (symbol === undefined) {
    throw new Error(`unknown symbol id "${id}"`);
  }
  return symbol.name;
}

// analyzeModule (semantic.ts entry): dispatches a ParseResult to the language's
// semantic analyzer. The TypeScript oracle is NOT consumed here — symbol-level types
// come from annotations/conservative inference; the oracle serves contract extraction
// (module-contract.ts) where its display strings are recorded as separate provenance.
import type { ParseResult } from "./parse-result.js";
import { analyzeJavaScriptModule } from "./semantic-javascript.js";
import { analyzePythonModule } from "./semantic-python.js";

export function analyzeModule(parseResult: ParseResult): SemanticModel {
  switch (parseResult.language) {
    case "python":
      return analyzePythonModule(parseResult);
    case "javascript":
    case "typescript":
      return analyzeJavaScriptModule(parseResult);
    default:
      throw new Error(`no semantic analyzer for language "${String(parseResult.language)}"`);
  }
}
