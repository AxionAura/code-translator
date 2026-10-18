// Python → JS/TS unit translator (docs/roadmap.md M4): consumes the semantic model and
// the ModuleGraph, lowers the module body, rewrites imports to target module paths,
// injects the runtime helper module (built from the UNION of every unit's
// requirements, finalized after all units), and finalizes output through Prettier
// (D-012). The runtime module is emitted once in finalizeUnits (D-007).
import { stripTypeScriptTypes } from "node:module";

import {
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

import { LoweringContext, ScopeStack } from "./context.js";
import { RUNTIME_HELPERS, RUNTIME_EXCEPTION_CLASSES, helperClosure } from "./helpers.js";
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
  private readonly pending: PendingModule[] = [];
  private readonly unitHelpers = new Set<string>();
  private readonly unitExceptions = new Set<string>();

  constructor(target: "javascript" | "typescript") {
    // Explicit field assignment (not a parameter property): the unbuilt CLI runs
    // sources through Node strip-only mode, which rejects transform-only syntax.
    this.target = target;
  }

  async translateUnit(
    unit: AnalyzedUnit,
    graph: ModuleGraphModel,
    context?: UnitTranslationContext,
  ): Promise<UnitEmission> {
    const extension = this.target === "typescript" ? (".ts" as const) : (".js" as const);
    const ctx = new LoweringContext(this.target, unit.filename);
    const exportedNames = new Set(pythonExportNames(unit.parseResult, unit.model));
    const emitter = new Emitter(
      ctx,
      new ScopeStack(),
      exportedNames,
      this.importedSymbolKinds(unit, graph, context),
    );

    const moduleImports = this.importPrologue(unit, graph, extension);
    emitter.lowerModuleBody(unit.parseResult.ast.fields["body"] as never);

    // Track every unit's helper/exception requirements for the shared runtime.
    for (const name of ctx.helpers) this.unitHelpers.add(name);
    for (const name of ctx.exceptionClasses) this.unitExceptions.add(name);

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
        content: await this.format(this.provenanceHeader(module.targetPath) + rawModule),
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
    return {
      targetExtension: extension,
      pathFor: (id) => targetModulePath(id, extension),
      files,
      ledger: [],
    };
  }

  // Cross-module symbol kinds for from-imports: dep modules' top-level classes and
  // functions give imports real types (class construction lowers to `new`).
  private importedSymbolKinds(
    unit: AnalyzedUnit,
    graph: ModuleGraphModel,
    context?: UnitTranslationContext,
  ): ReadonlyMap<string, "class" | "function"> {
    const kinds = new Map<string, "class" | "function">();
    if (context === undefined) return kinds;
    const node = graph.modules[unit.filename];
    if (node === undefined) return kinds;
    for (const graphImport of node.imports) {
      if (graphImport.importKind !== "static" || graphImport.resolvedModuleId === null) continue;
      const dep = context.analyzed.get(graphImport.resolvedModuleId);
      if (dep === undefined) continue;
      const body = dep.parseResult.ast.fields["body"];
      if (!Array.isArray(body)) continue;
      for (const statement of body as readonly {
        kind: string;
        fields: Record<string, unknown>;
      }[]) {
        if (statement.kind !== "ClassDef" && statement.kind !== "FunctionDef") continue;
        const name = statement.fields["name"];
        if (typeof name === "string") {
          kinds.set(name, statement.kind === "ClassDef" ? "class" : "function");
        }
      }
    }
    return kinds;
  }

  private provenanceHeader(targetPath: string): string {
    const direction = `python -> ${this.target}`;
    return (
      `/* Generated by Code Translator ${GENERATOR_VERSION} (${direction}).\n` +
      ` * Source module: ${targetPath.replace(/\.(ts|js)$/, ".py")}\n` +
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

      if (graphImport.status === "unresolved") {
        lines.push(
          `// ctrans: unresolved import "${graphImport.specifier}" (not in the analyzed file set)`,
        );
        return;
      }
      if (graphImport.status === "external") {
        // M4 has no registry: externals are emitted verbatim with a warning; the
        // mapping (e.g. os.path -> node:path) arrives in M5.
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
    return renderRuntime(this.target, helperNames, includeExceptions);
  }
}

// Renders the runtime helper module from the shared templates. Exposed for the
// behavior test-suite, which materializes the FULL helper set (a translated unit's
// runtime only ever contains the helpers that unit's closure required).
export function renderRuntime(
  target: "javascript" | "typescript",
  helperNames: readonly string[],
  includeExceptions: boolean,
): string {
  // The helper sources are TypeScript (ADR D-022); JavaScript targets receive them
  // through Node's built-in type stripping — one source of truth, zero dependencies.
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

export async function createPyToJsTranslator(
  target: "javascript" | "typescript",
): Promise<PyToJsTranslator> {
  return new PyToJsTranslator(target);
}
