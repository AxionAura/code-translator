// WS F — async boundary propagation v1 (docs/dependency-mapping.md §6).
//
// Python's `requests` API is synchronous; JS `fetch` is async-only (verified —
// there is no sync variant). When the registry maps a sync-to-async module, every
// caller of its functions must await, and that requirement propagates transitively
// through the ModuleGraph: callee async => caller async => caller's callers async.
//
// The propagation is a deterministic fixpoint over per-unit call graphs:
// 1. Each analyzed unit reports the local functions that (transitively within the
//    unit) call the async boundary (a `requests.*` call).
// 2. Cross-module edges come from the ModuleGraph: a local function that calls an
//    async function of an imported module becomes async itself.
// 3. The fixpoint iterates until no new function joins the async set.
//
// The pipeline consults this set through `AsyncRequirements` so the lowering can
// emit `async`/`await` and record every changed signature in the ledger.
import type { ModuleGraphModel } from "./module-graph.js";
import type { AstNode } from "./ast-node.js";

export interface AsyncRequirements {
  // module id -> set of function names that must be emitted as async.
  readonly asyncFunctions: ReadonlyMap<string, ReadonlySet<string>>;
  // The registry module that introduced the boundary (for ledger provenance).
  readonly boundaryModule: string;
}

interface FunctionInfo {
  readonly name: string;
  readonly callsLocal: readonly string[];
  // Calls into another unit's function: `unitId::functionName`.
  readonly callsExternal: readonly string[];
  readonly touchesBoundary: boolean;
}

// Walk a unit AST collecting function definitions and their call edges (iterative
// — hostile inputs must not recurse).
export function collectFunctionCalls(unitId: string, ast: AstNode): Map<string, FunctionInfo> {
  const functions = new Map<string, FunctionInfo>();
  const body = ast.fields["body"];
  if (!Array.isArray(body)) return functions;

  // Collect def/class names at module level for callee classification.
  const moduleLevelNames = new Set<string>();
  for (const statement of body as readonly AstNode[]) {
    if (
      (statement.kind === "FunctionDef" || statement.kind === "ClassDef") &&
      typeof statement.fields["name"] === "string"
    ) {
      moduleLevelNames.add(statement.fields["name"] as string);
    }
  }

  for (const statement of body as readonly AstNode[]) {
    if (statement.kind !== "FunctionDef" && statement.kind !== "AsyncFunctionDef") continue;
    const name = String(statement.fields["name"] ?? "");
    if (name === "") continue;
    let touchesBoundary = false;
    const callsLocal = new Set<string>();
    const callsExternal = new Set<string>();
    // Iterative walk of the function body.
    const stack: unknown[] = [...((statement.fields["body"] as readonly unknown[]) ?? [])];
    while (stack.length > 0) {
      const current = stack.pop();
      if (Array.isArray(current)) {
        stack.push(...current);
        continue;
      }
      if (typeof current !== "object" || current === null) continue;
      const record = current as { kind?: string; fields?: Record<string, unknown> };
      if (record.kind === undefined || record.fields === undefined) continue;
      if (record.kind === "Call") {
        const func = record.fields["func"] as
          { kind?: string; fields?: Record<string, unknown> } | undefined;
        if (func?.kind === "Attribute" && func.fields !== undefined) {
          // `requests.get(...)` — the boundary call surface.
          const receiver = func.fields["value"] as
            { kind?: string; fields?: Record<string, unknown> } | undefined;
          if (
            receiver?.kind === "Name" &&
            receiver.fields !== undefined &&
            receiver.fields["id"] === "requests"
          ) {
            touchesBoundary = true;
          }
        } else if (func?.kind === "Name" && func.fields !== undefined) {
          const callee = String(func.fields["id"] ?? "");
          if (moduleLevelNames.has(callee)) callsLocal.add(callee);
        }
      } else if (record.kind === "Name" && typeof record.fields["id"] === "string") {
        // A bare reference to a module-level callable used as a value: still a call
        // edge candidate when invoked (approximate — the call may be passed around).
        const referenced = record.fields["id"] as string;
        if (moduleLevelNames.has(referenced)) callsLocal.add(referenced);
      }
      for (const value of Object.values(record.fields)) {
        if (Array.isArray(value)) stack.push(...value);
        else if (typeof value === "object" && value !== null) stack.push(value);
      }
    }
    functions.set(name, {
      name,
      callsLocal: [...callsLocal],
      callsExternal: [...callsExternal],
      touchesBoundary,
    });
  }
  return functions;
}

// Extract `from module import name` bindings per unit (for cross-module edges).
export function collectImportedFunctions(
  unitId: string,
  ast: AstNode,
  graph: ModuleGraphModel,
  analyzedModules: ReadonlySet<string>,
): Map<string, { readonly unit: string; readonly function: string }> {
  const bindings = new Map<string, { unit: string; function: string }>();
  const body = ast.fields["body"];
  if (!Array.isArray(body)) return bindings;
  for (const statement of body as readonly AstNode[]) {
    if (statement.kind !== "ImportFrom") continue;
    const moduleField = statement.fields["module"];
    if (typeof moduleField !== "string") continue;
    const node = graph.modules[unitId];
    if (node === undefined) continue;
    const resolved = node.imports.find(
      (entry) => entry.importKind === "static" && entry.specifier.includes(moduleField),
    );
    const targetUnit = resolved?.resolvedModuleId ?? null;
    if (targetUnit === null || !analyzedModules.has(targetUnit)) continue;
    const names = statement.fields["names"];
    if (!Array.isArray(names)) continue;
    for (const alias of names as readonly AstNode[]) {
      const imported = alias.fields["name"];
      if (typeof imported === "string" && imported !== "*") {
        bindings.set(String(alias.fields["asname"] ?? imported), {
          unit: targetUnit,
          function: imported,
        });
      }
    }
  }
  return bindings;
}

// The deterministic fixpoint. `unitFunctions` maps unit id -> local call graph;
// `unitImports` maps unit id -> local-name -> {unit, function} bindings.
export function propagateAsync(
  unitFunctions: ReadonlyMap<string, ReadonlyMap<string, FunctionInfo>>,
  unitImports: ReadonlyMap<string, ReadonlyMap<string, { unit: string; function: string }>>,
  _boundaryModule: string,
): Map<string, Set<string>> {
  const asyncFunctions = new Map<string, Set<string>>();
  for (const [unit, functions] of unitFunctions) {
    const set = new Set<string>();
    for (const info of functions.values()) {
      if (info.touchesBoundary) set.add(info.name);
    }
    asyncFunctions.set(unit, set);
  }
  // Fixpoint: a function that calls an async function (locally or cross-unit)
  // becomes async itself. Iterate until stable (graphs are finite).
  let changed = true;
  while (changed) {
    changed = false;
    for (const [unit, functions] of unitFunctions) {
      const asyncSet = asyncFunctions.get(unit)!;
      const imports = unitImports.get(unit) ?? new Map();
      for (const info of functions.values()) {
        if (asyncSet.has(info.name)) continue;
        let mustAwait = false;
        for (const callee of info.callsLocal) {
          if (asyncSet.has(callee)) mustAwait = true;
        }
        for (const binding of imports.values()) {
          if (asyncFunctions.get(binding.unit)?.has(binding.function)) mustAwait = true;
        }
        if (mustAwait) {
          asyncSet.add(info.name);
          changed = true;
        }
      }
    }
  }
  return asyncFunctions;
}

export const ASYNC_BOUNDARY_MODULE = "requests";
