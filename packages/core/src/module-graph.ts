// ModuleGraph (docs/architecture.md §4/§7): builds the project-level module graph from
// parsed modules, resolves project-local imports (no package registries — external
// specifiers become explicit external dependencies), detects strongly connected
// components (iterative Tarjan), and emits a deterministic dependency ordering.
// Resolution happens against the provided file set only — the filesystem is never
// queried and nothing is guessed silently (unresolved stays unresolved).
import type { ImportKind } from "./module-info.js";
import type { ParseResult, SourceLanguage } from "./parse-result.js";
import type { SourceSpan } from "./source-span.js";
import type { SemanticDiagnostic } from "./semantic.js";

export interface GraphModuleInput {
  readonly filename: string;
  readonly parseResult: ParseResult;
  // Explicit entry-point hints (CLI flags); Python `__main__` guards are detected
  // automatically.
  readonly isEntry?: boolean;
}

export type GraphImportStatus = "resolved" | "external" | "unresolved";

export interface GraphImport {
  readonly specifier: string;
  // "dynamic" marks import()/importlib usage edges (approximate, order-affecting only
  // via the cycle report — see docs/translation-pipeline.md §4).
  readonly importKind: "static" | "dynamic";
  readonly edgeKind: ImportKind;
  readonly status: GraphImportStatus;
  readonly resolvedModuleId: string | null;
  readonly span: SourceSpan | null;
}

export interface ModuleGraphNode {
  readonly id: string;
  readonly language: SourceLanguage;
  readonly imports: readonly GraphImport[];
  readonly isEntry: boolean;
  readonly isTestModule: boolean;
}

export interface ModuleGraphModel {
  // Keyed by module id (forward-slash project paths); keys are sorted.
  readonly modules: Readonly<Record<string, ModuleGraphNode>>;
  // Strongly connected components (cyclic groups). Deterministically sorted: groups
  // in dependency-first order, members lexicographic.
  readonly sccs: readonly (readonly string[])[];
  // Flatten(sccs): dependencies appear before dependents; cyclic components appear
  // as one contiguous group. Identical inputs produce identical order.
  readonly order: readonly string[];
  readonly externalModules: readonly string[];
  readonly diagnostics: readonly SemanticDiagnostic[];
}

const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export function normalizeModuleId(filename: string): string {
  const id = filename.replaceAll("\\", "/");
  const segments: string[] = [];
  for (const segment of id.split("/")) {
    if (segment === "" && segments.length > 0) continue; // collapse doubled slashes
    if (segment === ".") continue;
    if (segment === ".." && segments.length > 0 && segments[segments.length - 1] !== "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function dirname(id: string): string {
  const index = id.lastIndexOf("/");
  return index === -1 ? "" : id.slice(0, index);
}

function isTestModule(id: string): boolean {
  if (/(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(id)) return true;
  if (/\.(test|spec)\.(js|jsx|ts|tsx)$/.test(id)) return true;
  return /(^|\/)(__tests__|tests)\//.test(id);
}

// Python `if __name__ == "__main__":` guard detection on the normalized AST.
function hasPythonMainGuard(node: unknown): boolean {
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current !== "object" || current === null) continue;
    const record = current as Record<string, unknown>;
    if (record["kind"] === "If") {
      const fields = record["fields"] as Record<string, unknown> | undefined;
      const test = JSON.stringify(fields?.["test"] ?? record["test"]);
      if (test?.includes('"__main__"') === true && test.includes("__name__")) {
        return true;
      }
    }
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) stack.push(...value);
      else if (typeof value === "object" && value !== null) stack.push(value);
    }
  }
  return false;
}

interface ResolutionResult {
  readonly status: GraphImportStatus;
  readonly resolvedModuleId: string | null;
}

export function buildModuleGraph(inputs: readonly GraphModuleInput[]): ModuleGraphModel {
  const diagnostics: SemanticDiagnostic[] = [];
  const knownIds = new Set(inputs.map((input) => normalizeModuleId(input.filename)));

  function resolvePython(specifier: string, fromId: string): ResolutionResult {
    let level = 0;
    let rest = specifier;
    while (rest.startsWith(".")) {
      level += 1;
      rest = rest.slice(1);
    }
    const base = dirname(fromId);
    const up = (dir: string, levels: number): string => {
      let current = dir;
      for (let i = 1; i < levels; i += 1) current = dirname(current);
      return current;
    };
    const targetPath = level > 0 ? joinPath(up(base, level), rest) : joinPath("", rest);
    const pathForm = targetPath.replaceAll(".", "/");
    const moduleCandidates =
      level > 0 && rest === ""
        ? [joinPath(targetPath, "__init__.py"), `${targetPath}.py`]
        : [`${pathForm}.py`, joinPath(pathForm, "__init__.py")];
    for (const candidate of moduleCandidates) {
      const normalized = normalizeModuleId(candidate);
      if (knownIds.has(normalized)) return { status: "resolved", resolvedModuleId: normalized };
    }
    return { status: level > 0 ? "unresolved" : "external", resolvedModuleId: null };
  }

  function resolveJs(specifier: string, fromId: string): ResolutionResult {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const base = dirname(fromId);
      const target = normalizeModuleId(joinPath(base, specifier));
      const candidates = [target, ...JS_EXTENSIONS.map((ext) => target + ext)];
      // TS-style imports spell ESM extensions (`./b.js` may mean `./b.ts`).
      const swapped = target.replace(/\.(js|mjs|cjs|jsx)$/, "");
      if (swapped !== target) {
        candidates.push(`${swapped}.ts`, `${swapped}.tsx`, `${swapped}.mts`, `${swapped}.cts`);
      }
      for (const extension of JS_EXTENSIONS) {
        candidates.push(joinPath(target, `index${extension}`));
      }
      for (const candidate of candidates) {
        if (knownIds.has(candidate)) return { status: "resolved", resolvedModuleId: candidate };
      }
      return { status: "unresolved", resolvedModuleId: null };
    }
    // Bare specifiers (packages, node: builtins) and anything outside the project
    // are explicit externals — never guessed.
    return { status: "external", resolvedModuleId: null };
  }

  const modules: Record<string, ModuleGraphNode> = {};
  for (const input of inputs) {
    const id = normalizeModuleId(input.filename);
    if (modules[id] !== undefined) {
      diagnostics.push({
        severity: "error",
        code: "SEM-DUPLICATE-MODULE",
        message: `module "${id}" was provided twice`,
        span: null,
      });
      continue;
    }
    const moduleInfo = input.parseResult.module;
    const imports: GraphImport[] = [];
    if (moduleInfo !== null) {
      for (const entry of moduleInfo.imports) {
        const resolution =
          input.parseResult.language === "python"
            ? resolvePython(entry.moduleSpecifier, id)
            : resolveJs(entry.moduleSpecifier, id);
        imports.push({
          specifier: entry.moduleSpecifier,
          importKind: "static",
          edgeKind: entry.kind,
          status: resolution.status,
          resolvedModuleId: resolution.resolvedModuleId,
          span: entry.span,
        });
      }
      for (const span of moduleInfo.dynamicImports) {
        imports.push({
          specifier: "(dynamic)",
          importKind: "dynamic",
          edgeKind: "named",
          status: "external",
          resolvedModuleId: null,
          span,
        });
      }
      for (const entry of moduleInfo.imports) {
        const resolution =
          input.parseResult.language === "python"
            ? resolvePython(entry.moduleSpecifier, id)
            : resolveJs(entry.moduleSpecifier, id);
        if (resolution.status === "unresolved") {
          diagnostics.push({
            severity: "warning",
            code: "SEM-UNRESOLVED-MODULE",
            message: `"${entry.moduleSpecifier}" imported by "${id}" does not resolve inside the analyzed file set`,
            span: entry.span,
          });
        } else if (resolution.status === "external") {
          diagnostics.push({
            severity: "info",
            code: "SEM-EXTERNAL-MODULE",
            message: `"${entry.moduleSpecifier}" is external to the analyzed project`,
            span: entry.span,
          });
        }
      }
    }
    modules[id] = {
      id,
      language: input.parseResult.language,
      imports,
      isEntry:
        input.isEntry === true ||
        (input.parseResult.language === "python" && hasPythonMainGuard(input.parseResult.ast)),
      isTestModule: isTestModule(id),
    };
  }

  // Adjacency over resolved internal edges only, sorted for determinism.
  const adjacency = new Map<string, string[]>();
  for (const node of Object.values(modules)) {
    const targets = node.imports
      .filter((entry) => entry.status === "resolved" && entry.resolvedModuleId !== null)
      .map((entry) => entry.resolvedModuleId!)
      .filter((target) => target !== node.id);
    adjacency.set(node.id, [...new Set(targets)].sort());
  }

  const sccs = tarjanSccs([...adjacency.keys()].sort(), adjacency);
  const order = sccs.flat();
  const externalModules = [
    ...new Set(
      Object.values(modules).flatMap((node) =>
        node.imports.filter((entry) => entry.status === "external").map((entry) => entry.specifier),
      ),
    ),
  ].sort();
  for (const scc of sccs) {
    if (scc.length > 1) {
      diagnostics.push({
        severity: "info",
        code: "SEM-CYCLE",
        message: `cyclic imports among: ${scc.join(", ")}`,
        span: null,
      });
    }
  }

  return { modules, sccs, order, externalModules, diagnostics };
}

function joinPath(base: string, relative: string): string {
  if (base === "") return relative;
  if (relative === "") return base;
  return `${base}/${relative}`;
}

// Iterative Tarjan (recursive Tarjan would risk stack exhaustion on hostile graphs).
// Emission order is deterministic given sorted vertices and sorted adjacency.
function tarjanSccs(
  vertices: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): readonly (readonly string[])[] {
  let counter = 0;
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  for (const root of vertices) {
    if (index.has(root)) continue;
    const callStack: Array<{ vertex: string; cursor: number }> = [{ vertex: root, cursor: 0 }];
    index.set(root, counter);
    lowLink.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!;
      const neighbors = adjacency.get(frame.vertex) ?? [];
      if (frame.cursor < neighbors.length) {
        const next = neighbors[frame.cursor]!;
        frame.cursor += 1;
        if (!index.has(next)) {
          index.set(next, counter);
          lowLink.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          callStack.push({ vertex: next, cursor: 0 });
        } else if (onStack.has(next)) {
          lowLink.set(frame.vertex, Math.min(lowLink.get(frame.vertex)!, index.get(next)!));
        }
        continue;
      }
      callStack.pop();
      if (callStack.length > 0) {
        const parent = callStack[callStack.length - 1]!;
        lowLink.set(
          parent.vertex,
          Math.min(lowLink.get(parent.vertex)!, lowLink.get(frame.vertex)!),
        );
      }
      if (lowLink.get(frame.vertex) === index.get(frame.vertex)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === frame.vertex) break;
        }
        sccs.push(component.sort());
      }
    }
  }
  return sccs;
}
