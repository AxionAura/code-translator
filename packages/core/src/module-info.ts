import type { SourceSpan } from "./source-span.js";

// Parser-level module information extracted from the source AST. This feeds the M3
// ModuleGraph; it deliberately says nothing about scopes or types. `kind` vocabularies
// are per-language but the envelope is shared (D-002).
export type ImportKind = "named" | "default" | "namespace" | "side-effect";

export interface ModuleImport {
  readonly kind: ImportKind;
  readonly moduleSpecifier: string;
  // Named: the imported (exported) name. Default/namespace/side-effect: null.
  readonly importedName: string | null;
  // Local binding introduced by the import; null for side-effect imports.
  readonly localName: string | null;
  readonly span: SourceSpan | null;
}

export type ExportKind = "named" | "default" | "star" | "star-as";

export interface ModuleExport {
  readonly kind: ExportKind;
  // Name visible to importers. null for `export * from "..."`.
  readonly exportedName: string | null;
  // Local binding being exported; null for re-exports.
  readonly localName: string | null;
  // Module specifier of a re-export (`export { x } from "..."` / `export * from "..."`).
  readonly moduleSpecifier: string | null;
  readonly span: SourceSpan | null;
}

export interface ModuleInfo {
  // True when the source uses import/export syntax (an ES module, not a script).
  readonly hasModuleSyntax: boolean;
  readonly imports: readonly ModuleImport[];
  readonly exports: readonly ModuleExport[];
  // Spans of dynamic import() call sites with a static string specifier.
  readonly dynamicImports: readonly SourceSpan[];
}
