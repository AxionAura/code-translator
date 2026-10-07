// ModuleContracts (docs/architecture.md §7): the externally relevant surface of a
// module — what dependents are allowed to know — without embedding the whole AST.
// Export type information is honest: CommonTypes come from the semantic model's
// conservative inference/annotations; the TypeScript oracle adds display strings as
// separate provenance. Unknown stays unknown (D-002, AGENTS.md §11).
import type { AnnotatedType } from "./common-type.js";
import type { ParseResult, SourceLanguage } from "./parse-result.js";
import type { SourceSpan } from "./source-span.js";
import type { SemanticDiagnostic, SemanticModel, SymbolKind } from "./semantic.js";
import type { TsSemanticOracle } from "./ts-oracle.js";

export type ContractEntryKind = "value" | "function" | "class" | "type" | "other";

export interface ContractEntry {
  readonly name: string;
  readonly kind: ContractEntryKind;
  readonly type: AnnotatedType | null;
  // Human-readable type from the TypeScript oracle (provenance "oracle"), when the
  // oracle was provided and the module is TypeScript. Never invented.
  readonly oracleTypeDisplay: string | null;
  readonly span: SourceSpan | null;
}

export interface ModuleContract {
  readonly moduleId: string;
  readonly language: SourceLanguage;
  readonly exports: readonly ContractEntry[];
  readonly diagnostics: readonly SemanticDiagnostic[];
}

export interface ContractInput {
  readonly filename: string;
  readonly source: string;
  readonly parseResult: ParseResult;
  readonly model: SemanticModel;
}

function contractKind(symbolKind: SymbolKind): ContractEntryKind {
  switch (symbolKind) {
    case "function":
      return "function";
    case "class":
      return "class";
    case "type":
    case "enum":
    case "namespace":
    case "typeParameter":
      return "type";
    case "variable":
    case "constant":
    case "parameter":
    case "property":
    case "import":
      return "value";
    default:
      return "other";
  }
}

// Python's export convention: `__all__` when present, otherwise all top-level public
// bindings (no leading underscore).
function pythonExportNames(parseResult: ParseResult, model: SemanticModel): string[] {
  const allNames: string[] | null = extractDuAll(parseResult);
  if (allNames !== null) return allNames;
  const rootScope = model.scopes[model.rootScopeId];
  if (rootScope === undefined) {
    throw new Error(`semantic model is missing its root scope "${model.rootScopeId}"`);
  }
  const names: string[] = [];
  for (const symbolId of rootScope.symbolIds) {
    const symbol = model.symbols[symbolId];
    if (symbol === undefined) continue;
    if (symbol.name.startsWith("_")) continue;
    if (symbol.kind === "import") continue;
    names.push(symbol.name);
  }
  return names.sort();
}

function extractDuAll(parseResult: ParseResult): string[] | null {
  // Walk the AST for `__all__ = ["a", "b"]` (list or tuple of string constants).
  const stack: unknown[] = [parseResult.ast];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current !== "object" || current === null) continue;
    const record = current as Record<string, unknown>;
    if (record["kind"] === "Assign") {
      const fields = record["fields"] as Record<string, unknown> | undefined;
      const targets = (fields?.["targets"] ?? record["targets"]) as unknown;
      const valueNode = (fields?.["value"] ?? record["value"]) as
        { fields?: Record<string, unknown>; elts?: unknown } | undefined;
      const isAllTarget =
        Array.isArray(targets) &&
        targets.some(
          (target) =>
            typeof target === "object" &&
            target !== null &&
            ((target as { fields?: Record<string, unknown> }).fields?.["id"] === "__all__" ||
              (target as Record<string, unknown>)["id"] === "__all__"),
        );
      const elts = valueNode?.fields?.["elts"] ?? valueNode?.elts;
      if (isAllTarget && Array.isArray(elts)) {
        const names = (elts as Array<{ fields?: Record<string, unknown>; value?: unknown }>)
          .map((element) => {
            const scalar = element.fields?.["value"] ?? element.value;
            return typeof scalar === "string" ? scalar : null;
          })
          .filter((name): name is string => name !== null);
        return names.sort();
      }
    }
    for (const entry of Object.values(record)) {
      if (Array.isArray(entry)) stack.push(...entry);
      else if (typeof entry === "object" && entry !== null) stack.push(entry);
    }
  }
  return null;
}

export function extractModuleContract(
  input: ContractInput,
  oracle?: TsSemanticOracle,
): ModuleContract {
  const diagnostics: SemanticDiagnostic[] = [];
  const rootScope = input.model.scopes[input.model.rootScopeId];
  if (rootScope === undefined) {
    throw new Error(`semantic model is missing its root scope "${input.model.rootScopeId}"`);
  }
  if (rootScope === undefined) {
    throw new Error(`semantic model is missing its root scope "${input.model.rootScopeId}"`);
  }
  const symbolsByName = new Map<string, string>();
  for (const symbolId of rootScope.symbolIds) {
    const symbol = input.model.symbols[symbolId];
    if (symbol !== undefined) symbolsByName.set(symbol.name, symbolId);
  }

  const entries: ContractEntry[] = [];
  if (input.parseResult.language === "python") {
    for (const name of pythonExportNames(input.parseResult, input.model)) {
      const symbolId = symbolsByName.get(name);
      const symbol = symbolId === undefined ? undefined : input.model.symbols[symbolId];
      entries.push({
        name,
        kind: symbol === undefined ? "other" : contractKind(symbol.kind),
        type: symbol?.type ?? null,
        oracleTypeDisplay: null,
        span: symbol?.declarationSpan ?? null,
      });
    }
  } else {
    const moduleInfo = input.parseResult.module;
    const oracleDisplays = new Map<string, string>();
    if (oracle !== undefined && input.parseResult.language === "typescript") {
      try {
        const summary = oracle.summarizeModule({
          files: [{ filename: input.filename, source: input.source }],
          filename: input.filename,
        });
        for (const entry of summary.exports) {
          if (entry.type !== null) oracleDisplays.set(entry.name, entry.type.display);
        }
      } catch (error) {
        diagnostics.push({
          severity: "warning",
          code: "SEM-ORACLE-UNAVAILABLE",
          message: `oracle query failed: ${error instanceof Error ? error.message : String(error)}`,
          span: null,
        });
      }
    }
    if (moduleInfo !== null) {
      for (const exportEntry of moduleInfo.exports) {
        if (exportEntry.kind === "star" || exportEntry.kind === "star-as") {
          diagnostics.push({
            severity: "info",
            code: "SEM-STAR-REEXPORT",
            message: `star re-export in "${input.filename}" is resolved at graph level, not inlined into the contract`,
            span: exportEntry.span,
          });
          continue;
        }
        const name = exportEntry.exportedName ?? "default";
        const symbolId =
          exportEntry.localName === null ? undefined : symbolsByName.get(exportEntry.localName);
        const symbol = symbolId === undefined ? undefined : input.model.symbols[symbolId];
        entries.push({
          name,
          kind: symbol === undefined ? "other" : contractKind(symbol.kind),
          type: symbol?.type ?? null,
          oracleTypeDisplay: oracleDisplays.get(exportEntry.localName ?? name) ?? null,
          span: symbol?.declarationSpan ?? exportEntry.span,
        });
      }
    }
  }

  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return {
    moduleId: input.filename,
    language: input.parseResult.language,
    exports: entries,
    diagnostics,
  };
}
