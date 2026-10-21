// Python → JS/TS unit translator (docs/roadmap.md M4): consumes the semantic model and
// the ModuleGraph, lowers the module body, rewrites imports to target module paths,
// injects the runtime helper module (built from the UNION of every unit's
// requirements, finalized after all units), and finalizes output through Prettier
// (D-012). The runtime module is emitted once in finalizeUnits (D-007).
import { stripTypeScriptTypes } from "node:module";

import {
  NO_REGISTRY,
  type RegistryLookup,
  CTransError,
  type AnalyzedUnit,
  type EmittedFile,
  type ModuleGraphModel,
  normalizeModuleId,
  pythonExportNames,
  targetModulePath,
  type UnitEmission,
  type UnitTranslationContext,
  type UnitTranslator,
} from "@ctrans/core";
import { format } from "prettier";

import { type AmbiguityRequest } from "@ctrans/core";
import { LoweringContext, ScopeStack } from "./context.js";
import { collectMatchStatements, matchAmbiguityRequest } from "./match.js";
import {
  INT_RESULT_TYPE,
  REGISTRY_MODULE_SOURCES,
  RUNTIME_HELPERS,
  RUNTIME_EXCEPTION_CLASSES,
  helperClosure,
} from "./helpers.js";
import { Emitter } from "./lower.js";

const RUNTIME_MODULE_BASE = "__ctrans_runtime";
const GENERATOR_VERSION = "0.0.0";

// A lowered module awaiting the union-based runtime import placement.
interface PendingModule {
  readonly targetPath: string;
  readonly sourcePath: string;
  readonly moduleImports: readonly string[];
  readonly body: string;
  // This unit's OWN helper/exception requirements (the runtime File covers the
  // union; each module imports only what it references).
  readonly helpers: readonly string[];
  readonly exceptions: readonly string[];
}

export class PyToJsTranslator implements UnitTranslator {
  readonly target: UnitTranslator["target"];
  private readonly intMode: "number" | "bigint";
  private readonly registry: RegistryLookup;
  private readonly pending: PendingModule[] = [];
  // Registry v1 generated modules referenced by any unit (emitted once).
  private readonly referencedModules = new Set<string>();
  private readonly unitHelpers = new Set<string>();
  private readonly unitExceptions = new Set<string>();

  constructor(
    target: "javascript" | "typescript",
    intMode: "number" | "bigint" = "number",
    registry: RegistryLookup = NO_REGISTRY,
  ) {
    // Explicit field assignment (not a parameter property): the unbuilt CLI runs
    // sources through Node strip-only mode, which rejects transform-only syntax.
    this.target = target;
    this.intMode = intMode;
    this.registry = registry;
  }

  // M8: engine-classified ambiguous constructs of this unit (the pipeline resolves
  // them through the optional AI port before translation). Only constructs with
  // MORE THAN ONE engine-offered option are escalatable; single-strategy cases are
  // not ambiguous requests.
  collectAmbiguities(unit: AnalyzedUnit, _graph: ModuleGraphModel): readonly AmbiguityRequest[] {
    const requests: AmbiguityRequest[] = [];
    for (const matchNode of collectMatchStatements(unit.parseResult.ast)) {
      const request = matchAmbiguityRequest(unit.filename, matchNode);
      if (request !== null) requests.push(request);
    }
    return requests;
  }

  async translateUnit(
    unit: AnalyzedUnit,
    graph: ModuleGraphModel,
    context?: UnitTranslationContext,
  ): Promise<UnitEmission> {
    const extension = this.target === "typescript" ? (".ts" as const) : (".js" as const);
    const ctx = new LoweringContext(this.target, unit.filename, this.intMode);
    const exportedNames = new Set(pythonExportNames(unit.parseResult, unit.model));
    const emitter = new Emitter(
      ctx,
      new ScopeStack(),
      exportedNames,
      this.importedSymbolKinds(unit, graph, context),
      context?.asyncFunctions?.get(unit.filename) ?? new Set(),
      this.importedAsyncNames(unit, graph, context),
      this.registry,
      context?.ambiguity ?? new Map(),
    );

    const moduleImports = this.importPrologue(unit, graph, extension);
    emitter.lowerModuleBody(unit.parseResult.ast.fields["body"] as never);

    // Track every unit's helper/exception requirements for the shared runtime.
    for (const name of ctx.helpers) this.unitHelpers.add(name);
    for (const name of ctx.exceptionClasses) this.unitExceptions.add(name);
    // Registry v1 modules referenced by this unit's imports.
    for (const sourceImport of unit.parseResult.module?.imports ?? []) {
      const root = sourceImport.moduleSpecifier.split(".")[0] ?? sourceImport.moduleSpecifier;
      if (REGISTRY_MODULE_SOURCES[root] !== undefined) this.referencedModules.add(root);
    }

    const targetPath = targetModulePath(unit.filename, extension);
    this.pending.push({
      targetPath,
      sourcePath: unit.filename,
      moduleImports,
      body: emitter.render(),
      helpers: [...ctx.helpers],
      exceptions: [...ctx.exceptionClasses],
    });
    return {
      targetExtension: extension,
      pathFor: (sourceModuleId: string) => targetModulePath(sourceModuleId, extension),
      files: [],
      ledger: ctx.ledger,
    };
  }

  // Project mode (M6): register helper/exception requirements that came from OUTSIDE
  // the translated source units (the pytest→vitest mapper's test lowering) so the
  // shared runtime's union covers the whole project. Must be called before
  // finalizeUnits.
  noteExternalHelpers(helperNames: readonly string[], exceptionNames: readonly string[]): void {
    for (const name of helperNames) this.unitHelpers.add(name);
    for (const className of exceptionNames) this.unitExceptions.add(className);
  }

  // Called once after every unit: assembles each module (runtime import restricted
  // to what the module itself references; the runtime file covers the UNION of all
  // units' requirements) and emits the runtime module when any unit required it.
  async finalizeUnits(): Promise<UnitEmission> {
    const extension = this.target === "typescript" ? (".ts" as const) : (".js" as const);
    const closure = helperClosure([...this.unitHelpers]);
    const runtimeNeeded =
      this.unitHelpers.size > 0 || this.unitExceptions.size > 0 || closure.exceptions.length > 0;
    const runtimePath = `${RUNTIME_MODULE_BASE}${extension}`;

    const files: EmittedFile[] = [];
    for (const module of this.pending) {
      const unitClosure = helperClosure(module.helpers);
      const unitExceptionNames = [...module.exceptions].filter((name) =>
        RUNTIME_EXCEPTION_CLASSES.includes(name),
      );
      const unitImportNames = [
        ...unitClosure.helpers
          .filter((name) => RUNTIME_HELPERS[name]?.internal !== true)
          .map((name) => `__ctrans_${name}`),
        ...unitExceptionNames,
      ].sort();
      const specifier = relativeImportSpecifier(dirname(module.targetPath), runtimePath);
      const runtimeImport =
        runtimeNeeded && unitImportNames.length > 0
          ? [`import { ${unitImportNames.join(", ")} } from "${specifier}";`]
          : [];
      const rawModule = [...module.moduleImports, ...runtimeImport, module.body].join("\n");
      files.push({
        targetPath: module.targetPath,
        sourcePath: module.sourcePath,
        content: await this.format(this.provenanceHeader(module.sourcePath) + rawModule),
      });
    }
    if (runtimeNeeded) {
      files.push({
        targetPath: runtimePath,
        sourcePath: "(runtime)",
        content: await this.format(
          await this.runtimeSource(
            [...closure.helpers],
            closure.exceptions.length > 0 || this.unitExceptions.size > 0,
          ),
        ),
      });
    }
    // Registry v1 generated modules (D-011): emitted once, only when referenced.
    // Sources are TypeScript (ADR D-022); JS targets strip types like the runtime.
    for (const moduleName of [...this.referencedModules].sort()) {
      const raw = REGISTRY_MODULE_SOURCES[moduleName];
      if (raw === undefined) continue;
      let code = raw;
      if (this.target === "javascript") {
        try {
          code = stripTypeScriptTypes(raw, { mode: "strip" });
        } catch (error) {
          throw new CTransError(
            "CG-RUNTIME-STRIP-FAILED",
            `Node type stripping failed for __ctrans_${moduleName}.js: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error },
          );
        }
      }
      files.push({
        targetPath: `__ctrans_${moduleName}${extension}`,
        sourcePath: `(registry:${moduleName})`,
        content: await this.format(code),
      });
    }
    return {
      targetExtension: extension,
      pathFor: (id) => targetModulePath(id, extension),
      files,
      ledger: [],
    };
  }

  // WS F: from-imported names bound to async functions of their source unit —
  // call sites in THIS unit must await them.
  private importedAsyncNames(
    unit: AnalyzedUnit,
    graph: ModuleGraphModel,
    context?: UnitTranslationContext,
  ): ReadonlySet<string> {
    const names = new Set<string>();
    const asyncFunctions = context?.asyncFunctions;
    if (asyncFunctions === undefined) return names;
    const sourceImports = unit.parseResult.module?.imports ?? [];
    for (const sourceImport of sourceImports) {
      if (sourceImport.kind !== "named") continue;
      const importedName = sourceImport.importedName;
      const localName = sourceImport.localName ?? importedName;
      if (importedName === null || localName === null) continue;
      // Resolve the import's target unit through the graph.
      const node = graph.modules[unit.filename];
      if (node === undefined) continue;
      for (const graphImport of node.imports) {
        if (graphImport.importKind !== "static" || graphImport.resolvedModuleId === null) continue;
        if (
          !graphImport.specifier.endsWith(importedName) &&
          !graphImport.specifier.endsWith(sourceImport.moduleSpecifier ?? "")
        ) {
          continue;
        }
        const asyncSet = asyncFunctions.get(graphImport.resolvedModuleId);
        if (asyncSet !== undefined && asyncSet.has(importedName)) {
          names.add(localName);
        }
      }
    }
    return names;
  }

  // Cross-module symbol kinds for from-imports: dep modules' top-level classes and
  // functions give imports real types (class construction lowers to `new`).
  private importedSymbolKinds(
    unit: AnalyzedUnit,
    graph: ModuleGraphModel,
    context?: UnitTranslationContext,
  ): ReadonlyMap<string, "class" | "function"> {
    return importedSymbolKindsFor(unit, graph, context);
  }

  private provenanceHeader(sourceModuleId: string): string {
    const direction = `python -> ${this.target}`;
    return (
      `/* Generated by Code Translator ${GENERATOR_VERSION} (${direction}).\n` +
      ` * Source module: ${sourceModuleId}\n` +
      ` * Per-construct decisions: .ctrans/ledger.json (docs/translation-pipeline.md §5).\n */\n`
    );
  }

  private async format(code: string): Promise<string> {
    try {
      return await format(code, {
        parser: this.target === "typescript" ? "typescript" : "babel",
        semi: true,
      });
    } catch (error) {
      // Surfaced, never swallowed: the raw (unformatted) output still reaches S1,
      // which will fail if the generator produced invalid syntax.
      throw new CTransError(
        "CG-FORMAT-FAILED",
        `prettier could not format generated ${this.target}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private importPrologue(
    unit: AnalyzedUnit,
    graph: ModuleGraphModel,
    extension: ".js" | ".ts",
  ): string[] {
    const lines: string[] = [];
    const node = graph.modules[unit.filename];
    const staticImports = node?.imports.filter((entry) => entry.importKind === "static") ?? [];
    const sourceImports = unit.parseResult.module?.imports ?? [];
    const myDir = dirname(targetModulePath(unit.filename, extension));
    // Names in `__all__`/the export convention are this module's public surface:
    // from-imports of those names re-export (Python `from pkg import x` reads the
    // package `__init__`, so the barrel must forward its own imports).
    const exportedNames = new Set(pythonExportNames(unit.parseResult, unit.model));

    staticImports.forEach((graphImport, index) => {
      const sourceImport = sourceImports[index];
      if (sourceImport === undefined) return;
      const localName = sourceImport.localName;
      const importedName = sourceImport.importedName;

      // `from __future__ import ...` is a compile-time directive with no runtime
      // effect in Python; emitting a target import would be a broken module path.
      if (graphImport.specifier === "__future__") {
        lines.push(`// ctrans: __future__ directive has no target emission`);
        return;
      }
      if (graphImport.status === "unresolved") {
        lines.push(
          `// ctrans: unresolved import "${graphImport.specifier}" (not in the analyzed file set)`,
        );
        return;
      }
      if (graphImport.status === "external") {
        // Registry v1 (D-011): mapped externals emit through their registry entry.
        const mapped = this.registry.lookupModule(
          graphImport.specifier.split(".")[0] ?? graphImport.specifier,
        );
        if (mapped !== null && mapped.emit.kind === "rewrite") {
          if (mapped.syncAsync === "sync-to-async") {
            // WS F: the async boundary module needs no import (fetch is a global);
            // the surface lowers at call sites. Record the mapping once per module.
            lines.push(
              `// ctrans: ${mapped.module} mapped to the JS fetch boundary (sync-to-async; surface documented in the registry)`,
            );
            return;
          }
          const spec = relativeImportSpecifier(myDir, `${mapped.emit.specifier}${extension}`);
          if (sourceImport.kind === "namespace" || importedName === null) {
            lines.push(`import * as ${localName ?? "module"} from "${spec}";`);
            return;
          }
          lines.push(
            importedName === localName || localName === null
              ? `import { ${importedName} } from "${spec}";`
              : `import { ${importedName} as ${localName} } from "${spec}";`,
          );
          return;
        }
        lines.push(
          externalImport(sourceImport.kind, importedName, localName, graphImport.specifier),
        );
        return;
      }
      const targetId = graphImport.resolvedModuleId;
      if (targetId === null) return;

      // `from . import helper` binds the SIBLING MODULE, not a symbol of the package.
      const siblingId =
        sourceImport.kind === "named" && importedName !== null
          ? normalizeModuleId(`${dirname(unit.filename)}/${importedName}.py`)
          : null;
      if (siblingId !== null && graph.modules[siblingId] !== undefined) {
        const specifier = relativeImportSpecifier(myDir, targetModulePath(siblingId, extension));
        lines.push(`import * as ${localName ?? importedName} from "${specifier}";`);
        return;
      }

      const specifier = relativeImportSpecifier(myDir, targetModulePath(targetId, extension));
      if (sourceImport.kind === "named") {
        const isExported = localName !== null && exportedNames.has(localName);
        if (isExported) {
          // Re-export the binding (barrel modules forward their public names).
          lines.push(
            importedName === null || importedName === localName
              ? `export { ${localName} } from "${specifier}";`
              : `export { ${importedName} as ${localName} } from "${specifier}";`,
          );
          return;
        }
        if (importedName === null || importedName === localName) {
          lines.push(`import { ${localName ?? importedName} } from "${specifier}";`);
        } else {
          lines.push(`import { ${importedName} as ${localName} } from "${specifier}";`);
        }
        return;
      }
      if (sourceImport.kind === "namespace") {
        // `import a.b` binds a module object; plain `import x` binds the module too.
        if (localName !== null && exportedNames.has(localName)) {
          lines.push(`export * as ${localName} from "${specifier}";`);
          return;
        }
        lines.push(`import * as ${localName ?? importedName ?? "module"} from "${specifier}";`);
        return;
      }
      lines.push(
        `// ctrans: unsupported import form (${sourceImport.kind}) from "${graphImport.specifier}"`,
      );
    });
    return lines;
  }

  private async runtimeSource(
    helperNames: readonly string[],
    includeExceptions: boolean,
  ): Promise<string> {
    // This translator only handles the JS/TS targets; Python output is codegen-py's.
    if (this.target !== "typescript" && this.target !== "javascript") {
      throw new CTransError(
        "CG-DIRECTION-MISMATCH",
        "py-to-js translator cannot render runtime helpers for a python target",
      );
    }
    return renderRuntime(this.target, helperNames, includeExceptions, this.intMode);
  }
}

// Renders the runtime helper module from the shared templates. Exposed for the
// behavior test-suite, which materializes the FULL helper set (a translated unit's
// runtime only ever contains the helpers that unit's closure required).
export function renderRuntime(
  target: "javascript" | "typescript",
  helperNames: readonly string[],
  includeExceptions: boolean,
  intMode: "number" | "bigint" = "number",
): string {
  // The helper sources are TypeScript (ADR D-022); JavaScript targets receive them
  // through Node's built-in type stripping — one source of truth, zero dependencies.
  // Numeric helper result types are parameterized per the D-006 integer mode.
  const intResult = INT_RESULT_TYPE[intMode];
  let code = `/* Generated by Code Translator - Python semantics helpers (D-007: zero runtime dependencies). */`;
  if (includeExceptions) {
    // Exception classes first: helpers and translated code reference them.
    code += `\n\n${RUNTIME_HELPERS["exceptions"]!.code}`;
  }
  for (const name of helperNames) {
    const helper = RUNTIME_HELPERS[name];
    if (helper === undefined || name === "exceptions") continue;
    code += `\n\n${helper.code}`;
  }
  code = code.replaceAll("__CTRANS_NUM__", intResult);
  if (target === "typescript") return code;
  try {
    return stripTypeScriptTypes(code, { mode: "strip" });
  } catch (error) {
    throw new CTransError(
      "CG-RUNTIME-STRIP-FAILED",
      `Node type stripping failed for __ctrans_runtime.js: ${
        error instanceof Error ? error.message : String(error)
      } — helper sources must stay strip-safe (ADR D-022)`,
      { cause: error },
    );
  }
}

// Cross-module symbol kinds for from-imports (shared with the pytest mapper):
// dep modules' top-level classes and functions give imports real types (class
// construction lowers to `new`). Barrel modules only RE-export (`from .book import
// Book`), so resolution follows the dep's own from-imports transitively for names
// the dep does not define itself. Exported so the test mapper resolves the SAME
// kinds — a test constructing an imported class must emit `new` too.
export function importedSymbolKindsFor(
  unit: AnalyzedUnit,
  graph: ModuleGraphModel,
  context?: UnitTranslationContext,
): ReadonlyMap<string, "class" | "function"> {
  const kinds = new Map<string, "class" | "function">();
  if (context === undefined) return kinds;
  const node = graph.modules[unit.filename];
  if (node === undefined) return kinds;

  const defsOf = (dep: AnalyzedUnit): Map<string, "class" | "function"> => {
    const defs = new Map<string, "class" | "function">();
    const body = dep.parseResult.ast.fields["body"];
    if (!Array.isArray(body)) return defs;
    for (const statement of body as readonly {
      kind: string;
      fields: Record<string, unknown>;
    }[]) {
      if (statement.kind !== "ClassDef" && statement.kind !== "FunctionDef") continue;
      const name = statement.fields["name"];
      if (typeof name === "string")
        defs.set(name, statement.kind === "ClassDef" ? "class" : "function");
    }
    return defs;
  };

  // Resolve `wanted` names starting at moduleId; names the module does not define
  // itself are followed through its own static from-imports (barrel forwarding).
  const visit = (moduleId: string, wanted: ReadonlySet<string>, depth: number): void => {
    if (depth > 8 || wanted.size === 0) return;
    const dep = context.analyzed.get(moduleId);
    if (dep === undefined) return;
    const defs = defsOf(dep);
    const missing = new Set<string>();
    for (const name of wanted) {
      if (kinds.has(name)) continue;
      const kind = defs.get(name);
      if (kind !== undefined) kinds.set(name, kind);
      else missing.add(name);
    }
    if (missing.size === 0) return;
    const depNode = graph.modules[moduleId];
    for (const graphImport of depNode?.imports ?? []) {
      if (graphImport.importKind !== "static" || graphImport.resolvedModuleId === null) continue;
      visit(graphImport.resolvedModuleId, missing, depth + 1);
    }
  };

  for (const graphImport of node.imports) {
    if (graphImport.importKind !== "static" || graphImport.resolvedModuleId === null) continue;
    // All names the unit from-imports in total (the graph import list and the
    // source import list are index-aligned; a namespace import contributes none).
    visit(graphImport.resolvedModuleId, unitImportedNames(unit), 0);
  }
  return kinds;
}

// Names bound by the unit's from-imports (the resolution targets for kinds).
function unitImportedNames(unit: AnalyzedUnit): ReadonlySet<string> {
  const names = new Set<string>();
  for (const sourceImport of unit.parseResult.module?.imports ?? []) {
    if (sourceImport.kind !== "named") continue;
    const local = sourceImport.localName ?? sourceImport.importedName;
    if (local !== null) names.add(local);
  }
  return names;
}

function externalImport(
  kind: string,
  importedName: string | null,
  localName: string | null,
  specifier: string,
): string {
  if (kind === "namespace" || importedName === null) {
    return `import * as ${localName ?? "module"} from "${specifier}";`;
  }
  if (importedName === localName) {
    return `import { ${localName} } from "${specifier}";`;
  }
  return `import { ${importedName} as ${localName} } from "${specifier}";`;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

// Relative ESM specifier from the importing file's directory to the target module
// file, always prefixed with ./ or ../ (never a bare specifier).
export function relativeImportSpecifier(fromDir: string, toPath: string): string {
  const fromParts = fromDir === "" ? [] : fromDir.split("/");
  const toParts = toPath.split("/");
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length - 1 &&
    fromParts[common] === toParts[common]
  ) {
    common += 1;
  }
  const up = fromParts.length - common;
  const down = toParts.slice(common);
  const joined = [...Array.from({ length: up }, () => ".."), ...down].join("/");
  return joined.startsWith("..") || joined.startsWith(".") ? joined : `./${joined}`;
}

export interface PyToJsTranslatorOptions {
  // D-006 integer policy (default "number"; "bigint" is the exact opt-in mode).
  readonly intMode?: "number" | "bigint";
  // D-017: the registry lookup is injected (core interface); default = none.
  readonly registry?: RegistryLookup;
}

export async function createPyToJsTranslator(
  target: "javascript" | "typescript",
  options: PyToJsTranslatorOptions = {},
): Promise<PyToJsTranslator> {
  return new PyToJsTranslator(target, options.intMode ?? "number", options.registry ?? NO_REGISTRY);
}
