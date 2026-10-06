// Parser-level scope/symbol information; for Python this is CPython symtable output.
// Observed scope kinds on Python 3.12–3.14: "module", "function", "class"; Python 3.14
// adds "annotation" scopes (PEP 749). Since 3.12 (PEP 709) comprehensions may be
// inlined into the enclosing scope and then do not appear as child scopes.
export type SymbolFlag =
  | "isLocal"
  | "isGlobal"
  | "isParameter"
  | "isFree"
  | "isImported"
  | "isAssigned"
  | "isReferenced"
  | "isDeclaredGlobal"
  | "isNonlocal";

export interface SymbolInfo {
  readonly name: string;
  readonly flags: Readonly<Record<SymbolFlag, boolean>>;
}

export interface ScopeInfo {
  readonly kind: string;
  readonly name: string;
  // 0-based line of the block header, null when the runtime reports none (module scope).
  readonly line: number | null;
  readonly symbols: readonly SymbolInfo[];
  readonly children: readonly ScopeInfo[];
}
