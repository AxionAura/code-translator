// JavaScript/TypeScript → Python translator (roadmap M7 WS B). Deliberate,
// tested mappings per docs/language-support.md §2 (TS/JS→Py column) over the
// normalized ESTree envelope from @axion-ct/parser-js — never a syntax-level print.
//
// Policy highlights:
// - Native operators where semantics match (arithmetic on numbers, `/` is float in
//   both, `**`); JS-only semantics route through `__ctrans_` helpers in the
//   generated `__ctrans_runtime.py` (truncated `%`, JS truthiness incl. NaN, `in`
//   on arrays, string-keyed dynamic property access with undefined-for-missing).
// - `undefined`/`null` collapse to `None` (semantic, tri-state loss documented
//   per policy §2.3 — recorded at each use).
// - Template literals → f-strings (deterministic); interpolations of non-string
//   values go through `__ctrans_str` (JS String() spellings: true/null).
// - Array/string/dict method mappings are type-directed: receivers provable from
//   initializer/annotation evidence map natively (`.toUpperCase()` → `.upper()`);
//   everything else stays honest-unknown and uses helpers or reports unsupported.
// - Runtime TS constructs in TS input (enums, namespaces, parameter properties,
//   decorators) are unsupported-loud, never dropped silently.
// - Output is finalized through the pinned ruff formatter (D-012/D-015/D-024).
import { createRequire } from "node:module";

import {
  CTransError,
  NO_REGISTRY,
  type AnalyzedUnit,
  type EmittedFile,
  type LedgerEntry,
  type LedgerEscalation,
  type ModuleGraphModel,
  type RegistryLookup,
  type UnitEmission,
  type UnitTranslationContext,
  type UnitTranslator,
} from "@axion-ct/core";

import { renderPyRuntime } from "./helpers.js";

const RUNTIME_MODULE = "__ctrans_runtime.py";
const RUNTIME_MODULE_BASE = "__ctrans_runtime";

const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

// Receiver kinds the type-directed method mappings rely on.
type ReceiverKind = "array" | "string" | "dict" | "number" | "instance" | "unknown";

export interface JsToPyTranslatorOptions {
  // Injectable ruff entry (tests can stub); default resolves the pinned package.
  readonly ruffFormat?: (code: string) => string;
}

export function createJsToPyTranslator(options: JsToPyTranslatorOptions = {}): UnitTranslator {
  return new JsToPyTranslator(options.ruffFormat ?? defaultRuffFormat);
}

function defaultRuffFormat(code: string): string {
  try {
    const require = createRequire(import.meta.url);
    const ruff = require("@astral-sh/ruff-wasm-nodejs") as {
      Workspace: new (
        options: unknown,
        encoding: unknown,
      ) => {
        format: (code: string) => string;
      };
      PositionEncoding: { Utf8: unknown };
    };
    const workspace = new ruff.Workspace({}, ruff.PositionEncoding.Utf8);
    return workspace.format(code);
  } catch (error) {
    throw new CTransError(
      "CG-FORMAT-FAILED",
      `ruff could not format generated Python: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

export class JsToPyTranslator implements UnitTranslator {
  readonly target = "python" as const;
  private readonly pending: {
    readonly targetPath: string;
    readonly sourcePath: string;
    readonly raw: string;
    readonly ledger: readonly LedgerEntry[];
  }[] = [];
  private readonly helpers = new Set<string>();
  private readonly runtimeBridge = new Set<string>();
  private needsRuntime = false;
  private readonly ruffFormat: (code: string) => string;

  // Explicit field (not a parameter property): the unbuilt CLI runs sources
  // through Node strip-only mode, which rejects transform-only syntax.
  constructor(ruffFormat: (code: string) => string) {
    this.ruffFormat = ruffFormat;
  }

  async translateUnit(
    unit: AnalyzedUnit,
    graph: ModuleGraphModel,
    _context?: UnitTranslationContext,
  ): Promise<UnitEmission> {
    if (unit.parseResult.language !== "javascript" && unit.parseResult.language !== "typescript") {
      throw new CTransError(
        "CG-DIRECTION-MISMATCH",
        `js-to-py translator received a ${unit.parseResult.language} input (${unit.filename})`,
      );
    }
    const printer = new PyPrinter(unit, graph, NO_REGISTRY);
    const raw = printer.printProgram(unit.parseResult.ast);
    for (const helper of printer.helpers) this.helpers.add(helper);
    for (const name of printer.runtimeBridge) this.runtimeBridge.add(name);
    if (printer.needsRuntime) this.needsRuntime = true;
    const targetPath = targetPathFor(unit.filename);
    this.pending.push({ targetPath, sourcePath: unit.filename, raw, ledger: printer.ledger });
    return {
      targetExtension: ".py",
      pathFor: (sourceModuleId: string) => targetPathFor(sourceModuleId),
      files: [],
      ledger: printer.ledger,
    };
  }

  async finalizeUnits(): Promise<UnitEmission> {
    const files: EmittedFile[] = [];
    const ledger: LedgerEntry[] = [];
    for (const module of this.pending) {
      const withImport = this.placeRuntimeImport(module.raw, module.targetPath);
      files.push({
        targetPath: module.targetPath,
        sourcePath: module.sourcePath,
        content: this.ruffFormat(withImport),
      });
      ledger.push(...module.ledger);
    }
    if (this.helpers.size > 0 || this.runtimeBridge.size > 0 || this.needsRuntime) {
      files.push({
        targetPath: RUNTIME_MODULE,
        sourcePath: "(runtime)",
        content: this.ruffFormat(renderPyRuntime([...this.helpers], [...this.runtimeBridge])),
      });
    }
    this.pending.length = 0;
    this.helpers.clear();
    this.runtimeBridge.clear();
    this.needsRuntime = false;
    return { targetExtension: ".py", pathFor: (id) => targetPathFor(id), files, ledger };
  }

  private placeRuntimeImport(raw: string, targetPath: string): string {
    const needsRe = this.helpers.has("re");
    const helperNames = [...this.helpers].filter((name) => name !== "re");
    if (helperNames.length === 0 && !needsRe) return raw;
    const lines = raw.split("\n");
    const lastImport = lines.reduce(
      (last, line, index) =>
        line.startsWith("import ") || line.startsWith("from ") ? index : last,
      -1,
    );
    const insertions: string[] = [];
    if (needsRe) insertions.push("import re");
    if (helperNames.length > 0) {
      const names = helperImportNames(helperNames);
      const specifier = relativePyImport(dirname(targetPath), RUNTIME_MODULE);
      insertions.push(...runtimeImportLines(names, specifier));
    }
    lines.splice(lastImport + 1, 0, ...insertions);
    return lines.join("\n");
  }
}

// Runtime imports must resolve both as a package (relative) and as a flat
// output directory (absolute via sys.path[0]); a bare relative import makes
// top-level output unrunnable (ImportError: attempted relative import with no
// known parent package).
// Translated modules reference runtime helpers through a single-underscore
// alias (`__ctrans_x as _ctrans_x`): Python's private-name mangling rewrites
// `__x` identifiers inside class bodies, which would break every helper call
// in a translated class method. The runtime module's def names keep the
// `__ctrans_` prefix; only references in translated code are aliased.
function runtimeAlias(name: string): string {
  return name.startsWith("__ctrans_") ? `_ctrans_${name.slice("__ctrans_".length)}` : name;
}

function runtimeImportLines(names: readonly string[], specifier: string): string[] {
  // Callers always pass a dotted (package-relative) specifier, so the absolute
  // fallback is always emitted alongside it.
  const relative = `from ${specifier} import ${names.join(", ")}`;
  const absolute = `from ${RUNTIME_MODULE_BASE} import ${names.join(", ")}`;
  return ["try:", `    ${relative}`, "except ImportError:", `    ${absolute}`];
}

function helperImportNames(requested: readonly string[]): string[] {
  const names = requested.flatMap((name) =>
    name === "numeric_constants"
      ? ["__ctrans_nan", "__ctrans_infinity"]
      : [`__ctrans_${snakeCase(name)}`],
  );
  return [...new Set(names.flatMap((name) => [`${name} as ${runtimeAlias(name)}`]))].sort();
}

export function snakeCase(name: string): string {
  return name
    .replaceAll("_", "_")
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function targetPathFor(sourceModuleId: string): string {
  return sourceModuleId.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, ".py");
}

// Python relative-import specifier from the importing file's directory.
export function relativePyImport(fromDir: string, toPath: string): string {
  const fromParts = fromDir === "" ? [] : fromDir.split("/");
  const toParts = toPath.replace(/\.py$/, "").split("/");
  const target = toParts[toParts.length - 1]!;
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length - 1 &&
    fromParts[common] === toParts[common]
  ) {
    common += 1;
  }
  const up = fromParts.length - common;
  const dots = ".".repeat(up + 1);
  const down = toParts.slice(common, -1);
  return `${dots}${[...down, target].join(".")}`;
}

// './x' → '.x', '../x' → '..x', './a/b' → '.a.b' (Python relative levels).
function pyRelativeSpecifier(moduleSource: string): string {
  const stripped = moduleSource.replace(/\.(js|ts|tsx|jsx|mjs|cjs)$/, "");
  let level = 0;
  let rest = stripped;
  while (rest.startsWith("./") || rest === ".") {
    level += 1;
    rest = rest.slice(2);
  }
  while (rest.startsWith("../")) {
    level += 1;
    rest = rest.slice(3);
  }
  const dots = ".".repeat(Math.max(level, 1));
  return rest === "" ? dots : dots + rest.replaceAll("/", ".");
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

// ---- ESTree envelope accessors ------------------------------------------------
type PyNode = {
  kind: string;
  span: {
    start: { line: number; column: number };
    end: { line: number; column: number };
    startByteOffset: number;
    endByteOffset: number;
  } | null;
  fields: Record<string, unknown>;
};

function kids(node: PyNode, name: string): readonly PyNode[] {
  const value = node.fields[name];
  return Array.isArray(value) ? (value as readonly PyNode[]) : [];
}

function kid(node: PyNode, name: string): PyNode | null {
  const value = node.fields[name];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as PyNode)
    : null;
}

function scalar(node: PyNode | null, name: string): string | number | boolean | null {
  if (node === null) return null;
  const value = node.fields[name];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

const PRECEDENCE: Record<string, number> = {
  "??": 1,
  "||": 2,
  "&&": 3,
  "|": 4,
  "^": 5,
  "&": 6,
  "==": 7,
  "!=": 7,
  "===": 7,
  "!==": 7,
  "<": 8,
  "<=": 8,
  ">": 8,
  ">=": 8,
  instanceof: 8,
  in: 8,
  "<<": 9,
  ">>": 9,
  ">>>": 9,
  "+": 10,
  "-": 10,
  "*": 11,
  "/": 11,
  "%": 11,
  "**": 12,
};

// ---- printer -------------------------------------------------------------------
class PyPrinter {
  readonly ledger: LedgerEntry[] = [];
  readonly helpers = new Set<string>();
  // codegen-js runtime helper names imported by translated modules (round-trip);
  // finalizeUnits emits their Python-semantic bridge definitions.
  readonly runtimeBridge = new Set<string>();
  // Set when a module imports the runtime in any form (named, default, or
  // namespace): the runtime file must be emitted for the import to resolve.
  needsRuntime = false;
  private lines: string[] = [];
  private indent = 0;
  private ordinal = 0;
  private readonly scopes: Map<string, ReceiverKind>[] = [new Map()];
  private readonly classNames = new Set<string>();
  private readonly mangled = new Map<string, string>();
  private exportedNames: string[] = [];
  private tmpCounter = 0;
  private pendingParamsComment = false;

  private readonly unit: AnalyzedUnit;
  private readonly graph: ModuleGraphModel;
  private readonly registry: RegistryLookup;

  // Explicit fields (not parameter properties): the unbuilt CLI runs sources
  // through Node strip-only mode, which rejects transform-only syntax.
  constructor(unit: AnalyzedUnit, graph: ModuleGraphModel, registry: RegistryLookup) {
    this.unit = unit;
    this.graph = graph;
    this.registry = registry;
  }

  // ---- ledger ------------------------------------------------------------------
  private record(entry: {
    span: PyNode["span"];
    sourceKind: string;
    rule: string;
    decision: "deterministic" | "semantic" | "ambiguous" | "unsupported";
    rationale: string;
    adaptation?: string | null;
    warnings?: readonly string[];
    candidates?: readonly string[] | null;
    escalation?: LedgerEscalation | null;
    targetSummary?: string | null;
  }): void {
    this.ordinal += 1;
    const span = entry.span;
    this.ledger.push({
      id: `${this.unit.filename}#${String(this.ordinal).padStart(3, "0")}`,
      unit: this.unit.filename,
      span:
        span === null
          ? null
          : {
              start: { line: span.start.line, column: span.start.column },
              end: { line: span.end.line, column: span.end.column },
              startByteOffset: span.startByteOffset,
              endByteOffset: span.endByteOffset,
            },
      sourceKind: entry.sourceKind,
      rule: entry.rule,
      decision: entry.decision,
      rationale: entry.rationale,
      adaptation: entry.adaptation ?? null,
      targetSummary: entry.targetSummary ?? null,
      warnings: entry.warnings ?? [],
      ...(entry.candidates == null ? {} : { candidates: entry.candidates }),
      escalation: entry.escalation ?? null,
    });
  }

  private unsupported(node: PyNode, what: string, reason: string): string {
    this.record({
      span: node.span,
      sourceKind: `js.${node.kind}`,
      rule: `js.${node.kind}→unsupported`,
      decision: "unsupported",
      rationale: reason,
      warnings: ["CTW-UNSUPPORTED-JS-CONSTRUCT"],
      targetSummary: null,
    });
    void what;
    return `# ctrans: unsupported ${what} — ${reason}`;
  }

  private semantic(
    node: PyNode,
    sourceKind: string,
    rule: string,
    rationale: string,
    adaptation: string,
    targetSummary: string,
  ): void {
    this.record({
      span: node.span,
      sourceKind,
      rule,
      decision: "semantic",
      rationale,
      adaptation,
      targetSummary,
    });
  }

  private deterministic(
    node: PyNode,
    sourceKind: string,
    rule: string,
    rationale: string,
    targetSummary: string,
  ): void {
    this.record({
      span: node.span,
      sourceKind,
      rule,
      decision: "deterministic",
      rationale,
      targetSummary,
    });
  }

  private useHelper(name: string): string {
    this.helpers.add(name);
    return `_ctrans_${snakeCase(name)}`;
  }

  // ---- scopes ------------------------------------------------------------------
  private pushScope(): void {
    this.scopes.push(new Map());
  }

  private popScope(): void {
    this.scopes.pop();
  }

  private declareKind(name: string, kind: ReceiverKind): void {
    if (name !== "") this.scopes[this.scopes.length - 1]!.set(name, kind);
  }

  private kindOf(name: string): ReceiverKind {
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      const hit = this.scopes[i]!.get(name);
      if (hit !== undefined) return hit;
    }
    return "unknown";
  }

  private isValueNameDefined(name: string): boolean {
    return Object.values(this.unit.model.symbols).some(
      (symbol) =>
        symbol.name === name &&
        symbol.namespace !== "type" &&
        symbol.kind !== "type" &&
        symbol.kind !== "typeParameter",
    );
  }

  private mangle(name: string): string {
    // Helper references bind under the single-underscore alias (see
    // runtimeAlias): Python's class-body mangling would rewrite any `__x`
    // identifier, breaking every helper call inside a translated method.
    if (name.startsWith("__ctrans_")) return runtimeAlias(name);
    const existing = this.mangled.get(name);
    if (existing !== undefined) return existing;
    const mangled = PYTHON_KEYWORDS.has(name) ? `${name}_` : name;
    this.mangled.set(name, mangled);
    if (mangled !== name) {
      this.record({
        span: null,
        sourceKind: "js.Identifier",
        rule: "js.identifier→py.mangled",
        decision: "semantic",
        rationale: `'${name}' is a Python keyword; the binding is mangled consistently at every use`,
        adaptation: `${name} → ${mangled}`,
        targetSummary: mangled,
      });
    }
    return mangled;
  }

  // ---- program -----------------------------------------------------------------
  printProgram(program: PyNode): string {
    for (const statement of kids(program, "body")) this.printStatement(statement);
    if (this.exportedNames.length > 0) {
      const list = this.exportedNames.map((name) => JSON.stringify(name)).join(", ");
      this.lines.unshift(`__all__ = [${list}]`);
      this.record({
        span: null,
        sourceKind: "js.exports",
        rule: "js.exports→py.__all__",
        decision: "semantic",
        rationale: "Python has no export keywords; the export surface becomes __all__",
        adaptation: "__all__ list",
        targetSummary: `__all__ (${String(this.exportedNames.length)} names)`,
      });
    }
    return this.lines.join("\n");
  }

  private freshTmp(): string {
    this.tmpCounter += 1;
    return `_ctrans_tmp${String(this.tmpCounter).padStart(2, "0")}`;
  }

  // ---- statements ----------------------------------------------------------------
  private printStatement(node: PyNode): void {
    switch (node.kind) {
      case "ImportDeclaration":
        this.printImport(node);
        return;
      case "ExportNamedDeclaration":
        this.printExportNamed(node);
        return;
      case "ExportDefaultDeclaration":
        this.printExportDefault(node);
        return;
      case "ExportAllDeclaration":
        this.printExportAll(node);
        return;
      case "VariableDeclaration":
        this.printVariableDeclaration(node);
        return;
      case "FunctionDeclaration":
        this.printFunction(node);
        return;
      case "ClassDeclaration":
        this.printClass(node);
        return;
      case "ExpressionStatement":
        this.line(this.printExpression(kid(node, "expression")!, 0));
        return;
      case "BlockStatement":
        this.pushScope();
        for (const statement of kids(node, "body")) this.printStatement(statement);
        this.popScope();
        return;
      case "IfStatement":
        this.printIf(node);
        return;
      case "WhileStatement":
        this.line(`while ${this.truthyTest(kid(node, "test")!)}:`);
        this.printBody(kid(node, "body")!);
        this.deterministic(
          node,
          "js.WhileStatement",
          "js.while→py.while",
          "while correspondence",
          "while",
        );
        return;
      case "DoWhileStatement":
        this.printDoWhile(node);
        return;
      case "ForStatement":
        this.printFor(node);
        return;
      case "ForOfStatement":
        this.printForOf(node);
        return;
      case "ForInStatement":
        this.printForIn(node);
        return;
      case "SwitchStatement":
        this.printSwitch(node);
        return;
      case "ReturnStatement": {
        const argument = kid(node, "argument");
        this.line(argument === null ? "return" : `return ${this.printExpression(argument, 0)}`);
        return;
      }
      case "BreakStatement":
        this.line("break");
        return;
      case "ContinueStatement":
        this.line("continue");
        return;
      case "LabeledStatement":
        this.line(
          this.unsupported(
            node,
            "labeled statement",
            "Python has no labels; outside the M7 subset",
          ),
        );
        return;
      case "ThrowStatement":
        this.printThrow(node);
        return;
      case "TryStatement":
        this.printTry(node);
        return;
      case "EmptyStatement":
        return;
      case "TSExportAssignment":
      case "TSImportEqualsDeclaration":
        this.unsupported(
          node,
          node.kind,
          "TypeScript module-system construct with no Python mapping",
        );
        return;
      case "TSTypeAliasDeclaration":
      case "TSInterfaceDeclaration":
        this.eraseTypeNode(node);
        return;
      case "TSEnumDeclaration":
        this.line(
          this.unsupported(node, "enum", "enums are runtime constructs; outside the M7 subset"),
        );
        return;
      case "TSModuleDeclaration":
        if (node.fields["declare"] === true) {
          this.eraseTypeNode(node);
        } else {
          this.line(
            this.unsupported(
              node,
              "namespace",
              "namespaces are runtime constructs; outside the M7 subset",
            ),
          );
        }
        return;
      case "TSDeclareFunction":
        this.eraseTypeNode(node);
        return;
      default:
        this.line(
          this.unsupported(node, node.kind, "statement form outside the M7 reverse subset"),
        );
    }
  }

  private eraseTypeNode(node: PyNode): void {
    this.record({
      span: node.span,
      sourceKind: `js.${node.kind}`,
      rule: `js.${node.kind}→erased`,
      decision: "deterministic",
      rationale: "type-only construct is erased (no runtime effect)",
      adaptation: "erased",
      targetSummary: null,
    });
  }

  private printImport(node: PyNode): void {
    if (node.fields["importKind"] === "type") {
      this.eraseTypeNode(node);
      return;
    }
    const moduleSource = String(scalar(kid(node, "source"), "value") ?? "");
    const names: { imported: string; local: string }[] = [];
    const defaults: string[] = [];
    let namespace: string | null = null;
    for (const specifier of kids(node, "specifiers")) {
      if (specifier.fields["importKind"] === "type") continue;
      if (specifier.kind === "ImportSpecifier") {
        const imported = String(
          scalar(kid(specifier, "imported"), "name") ??
            String(scalar(kid(specifier, "imported"), "value") ?? ""),
        );
        const local = String(scalar(kid(specifier, "local"), "name") ?? "");
        names.push({ imported, local });
      } else if (specifier.kind === "ImportDefaultSpecifier") {
        defaults.push(String(scalar(kid(specifier, "local"), "name") ?? ""));
      } else if (specifier.kind === "ImportNamespaceSpecifier") {
        namespace = String(scalar(kid(specifier, "local"), "name") ?? "");
      } else {
        this.unsupported(specifier, specifier.kind, "import form outside the M7 reverse subset");
      }
    }
    this.emitImport(moduleSource, names, defaults, namespace, node);
  }

  private emitImport(
    moduleSource: string,
    names: { imported: string; local: string }[],
    defaults: string[],
    namespace: string | null,
    node: PyNode,
  ): void {
    const node0 = this.graph.modules[this.unit.filename];
    const graphImport = (node0?.imports ?? []).find(
      (candidate) => candidate.specifier === moduleSource,
    );
    if (
      graphImport !== undefined &&
      graphImport.status === "resolved" &&
      graphImport.resolvedModuleId !== null
    ) {
      const targetId = graphImport.resolvedModuleId;
      const targetPy = targetPathFor(targetId);
      const myDir = dirname(this.unit.filename.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, ""));
      const specifier = relativePyImport(myDir, targetPy);
      const clauses: string[] = [];
      // Default imports map to the module's generated `default` binding.
      for (const local of defaults) {
        clauses.push(`default as ${this.mangle(local)}`);
        this.declareKind(local, "unknown");
      }
      for (const { imported, local } of names) {
        clauses.push(
          imported === local
            ? this.mangle(imported)
            : `${this.mangle(imported)} as ${this.mangle(local)}`,
        );
        this.declareKind(local, "unknown");
      }
      if (namespace !== null) {
        // `import * as ns` binds the module object.
        const moduleBind = targetPy.replace(/\.py$/, "").replaceAll("/", ".");
        const shortName = moduleBind.split(".").pop() ?? moduleBind;
        this.line(`from ${specifier} import ${shortName} as ${this.mangle(namespace)}`);
        this.declareKind(namespace, "dict");
      } else if (clauses.length > 0) {
        this.line(`from ${specifier} import ${clauses.join(", ")}`);
      }
      this.record({
        span: node.span,
        sourceKind: "js.ImportDeclaration",
        rule: "js.import→py.from-import",
        decision: "deterministic",
        rationale: "local import rewritten to a Python relative import of the translated module",
        targetSummary: `from ${specifier} import …`,
      });
      return;
    }
    // External: verbatim module import (S3 classifies; never invented names).
    // A relative-but-unresolved specifier keeps its dotted relative level.
    const root = moduleSource.startsWith(".")
      ? pyRelativeSpecifier(moduleSource)
      : moduleSource.split("/")[0]!;
    if (root === `.${RUNTIME_MODULE_BASE}` || root === RUNTIME_MODULE_BASE) {
      this.emitRuntimeImport(names, defaults, namespace, node);
      return;
    }
    if (names.length === 0 && defaults.length === 0 && namespace !== null) {
      this.line(`import ${this.mangle(root)} as ${this.mangle(namespace)}`);
    } else if (defaults.length > 0 || namespace !== null) {
      this.line(`import ${this.mangle(root)}`);
      for (const local of defaults) {
        this.line(`${this.mangle(local)} = ${this.mangle(root)}`);
        this.declareKind(local, "unknown");
      }
      if (namespace !== null) this.line(`${this.mangle(namespace)} = ${this.mangle(root)}`);
    } else if (names.length > 0) {
      const clauses = names.map(({ imported, local }) =>
        imported === local
          ? this.mangle(imported)
          : `${this.mangle(imported)} as ${this.mangle(local)}`,
      );
      this.line(`from ${this.mangle(root)} import ${clauses.join(", ")}`);
      for (const { local } of names) this.declareKind(local, "unknown");
    } else {
      this.line(`import ${this.mangle(root)}`);
    }
    this.record({
      span: node.span,
      sourceKind: "js.ImportDeclaration",
      rule: "js.import→py.import-external",
      decision: "semantic",
      rationale:
        "external (non-project) import passes through verbatim against the Python package namespace; the registry/S3 report unmapped packages",
      adaptation: "external-verbatim",
      targetSummary: `import ${root}`,
    });
  }

  // A translated module may import the generated runtime (round-trip: the
  // Python→TypeScript leg emits `import … from "./__ctrans_runtime.js"`). The
  // runtime file is emitted by this translator, not by the module graph, so the
  // resolved-import path never fires. Register the imported helper names so
  // finalizeUnits emits their bridge definitions, and emit the import in the
  // package/flat dual-resolving shape. The runtime module has no default
  // export, so default and namespace bindings bind the runtime module object.
  private emitRuntimeImport(
    names: { imported: string; local: string }[],
    defaults: string[],
    namespace: string | null,
    node: PyNode,
  ): void {
    const myDir = dirname(this.unit.filename.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, ""));
    const specifier = relativePyImport(myDir, RUNTIME_MODULE);
    this.needsRuntime = true;
    if (names.length > 0) {
      const clauses = names.map(({ imported, local }) =>
        imported === local
          ? `${imported} as ${runtimeAlias(imported)}`
          : `${imported} as ${this.mangle(local)}`,
      );
      for (const lineText of runtimeImportLines(clauses, specifier)) this.line(lineText);
      for (const { imported, local } of names) {
        this.runtimeBridge.add(imported);
        this.declareKind(local, "unknown");
      }
    }
    if (namespace !== null || defaults.length > 0) {
      const parent = specifier.replace(/(^|\.)__ctrans_runtime$/, "$1");
      const bindings = [...defaults, ...(namespace !== null ? [namespace] : [])].map(
        (local) => `__ctrans_runtime as ${this.mangle(local)}`,
      );
      this.line("try:");
      this.line(`    from ${parent} import ${bindings.join(", ")}`);
      this.line("except ImportError:");
      for (const local of [...defaults, ...(namespace !== null ? [namespace] : [])]) {
        this.line(`    import ${RUNTIME_MODULE_BASE} as ${this.mangle(local)}`);
        this.declareKind(local, "unknown");
      }
    }
    this.record({
      span: node.span,
      sourceKind: "js.ImportDeclaration",
      rule: "js.import→py.import-runtime",
      decision: "semantic",
      rationale:
        "import of the generated __ctrans_runtime module: definitions are emitted by this translator; the import resolves relatively in package layouts and absolutely in flat output",
      adaptation: "runtime-import-fallback",
      targetSummary: `from ${specifier} import …`,
    });
  }

  private printExportNamed(node: PyNode): void {
    if (node.fields["exportKind"] === "type") {
      this.eraseTypeNode(node);
      return;
    }
    const declaration = kid(node, "declaration");
    if (declaration !== null) {
      this.printStatement(declaration);
      this.collectExportedNames(declaration);
      this.deterministic(
        node,
        "js.ExportNamedDeclaration",
        "js.export→py.public-name",
        "export keyword becomes a public module name (surfaced via __all__)",
        "public binding",
      );
      return;
    }
    const specifiers: { local: string; exported: string }[] = [];
    for (const specifier of kids(node, "specifiers")) {
      if (specifier.fields["exportKind"] === "type") continue;
      const local = String(scalar(kid(specifier, "local"), "name") ?? "");
      const exported = String(
        scalar(kid(specifier, "exported"), "name") ??
          String(scalar(kid(specifier, "exported"), "value") ?? ""),
      );
      specifiers.push({ local, exported });
      this.exportedNames.push(exported);
      const sourceNodeEarly = kid(node, "source");
      if (sourceNodeEarly === null && exported !== local) {
        // Local rename binding (no source): exported = local in this module.
        this.line(`${this.mangle(exported)} = ${this.mangle(local)}`);
      }
    }
    const sourceNode = kid(node, "source");
    if (sourceNode !== null) {
      // Re-export: one from-import binding each exported name from the source.
      const moduleSource = String(scalar(sourceNode, "value") ?? "");
      const node0 = this.graph.modules[this.unit.filename];
      const graphImport = (node0?.imports ?? []).find(
        (candidate) => candidate.specifier === moduleSource,
      );
      let specifier: string;
      if (
        graphImport !== undefined &&
        graphImport.status === "resolved" &&
        graphImport.resolvedModuleId !== null
      ) {
        const targetPy = targetPathFor(graphImport.resolvedModuleId);
        const myDir = dirname(this.unit.filename.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, ""));
        specifier = relativePyImport(myDir, targetPy);
      } else if (moduleSource.startsWith(".")) {
        specifier = pyRelativeSpecifier(moduleSource);
      } else {
        specifier = this.mangle(moduleSource.split("/")[0]!);
      }
      const clauses = specifiers.map(({ local, exported }) =>
        local === exported
          ? this.mangle(local)
          : `${this.mangle(local)} as ${this.mangle(exported)}`,
      );
      this.line(`from ${specifier} import ${clauses.join(", ")}`);
    }
    this.deterministic(
      node,
      "js.ExportNamedDeclaration",
      "js.export-list→py.__all__",
      "export specifier list joins the module __all__ surface",
      "export list",
    );
  }

  private printExportDefault(node: PyNode): void {
    const declaration = kid(node, "declaration");
    if (
      declaration !== null &&
      (declaration.kind === "FunctionDeclaration" || declaration.kind === "ClassDeclaration")
    ) {
      this.printStatement(declaration);
      const name = String(scalar(kid(declaration, "id"), "name") ?? "");
      this.line(`default = ${this.mangle(name)}`);
      this.exportedNames.push("default");
      this.semantic(
        node,
        "js.ExportDefaultDeclaration",
        "js.export-default→py.default-binding",
        "JS default export becomes a module-level `default` binding (import side reads it as `default`)",
        "default binding",
        `default = ${name}`,
      );
      return;
    }
    const expression =
      declaration !== null &&
      declaration.kind !== "FunctionDeclaration" &&
      declaration.kind !== "ClassDeclaration"
        ? declaration
        : kid(node, "declaration");
    if (
      expression !== null &&
      expression.kind !== "FunctionDeclaration" &&
      expression.kind !== "ClassDeclaration"
    ) {
      this.line(`default = ${this.printExpression(expression, 0)}`);
      this.exportedNames.push("default");
      this.semantic(
        node,
        "js.ExportDefaultDeclaration",
        "js.export-default→py.default-binding",
        "JS default export becomes a module-level `default` binding",
        "default binding",
        "default = …",
      );
    }
  }

  private printExportAll(node: PyNode): void {
    const moduleSource = String(scalar(kid(node, "source"), "value") ?? "");
    const node0 = this.graph.modules[this.unit.filename];
    const graphImport = (node0?.imports ?? []).find(
      (candidate) => candidate.specifier === moduleSource,
    );
    let specifier: string;
    if (
      graphImport !== undefined &&
      graphImport.status === "resolved" &&
      graphImport.resolvedModuleId !== null
    ) {
      const targetPy = targetPathFor(graphImport.resolvedModuleId);
      const myDir = dirname(this.unit.filename.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, ""));
      specifier = relativePyImport(myDir, targetPy);
    } else if (moduleSource.startsWith(".")) {
      specifier = pyRelativeSpecifier(moduleSource);
    } else {
      specifier = this.mangle(moduleSource.split("/")[0]!);
    }
    this.line(`from ${specifier} import *`);
    this.semantic(
      node,
      "js.ExportAllDeclaration",
      "js.export-star→py.star-import",
      "star re-export maps to a Python star import bound under a private name",
      "from … import *",
      "export *",
    );
  }

  private collectExportedNames(declaration: PyNode): void {
    if (declaration.kind === "FunctionDeclaration" || declaration.kind === "ClassDeclaration") {
      const name = String(scalar(kid(declaration, "id"), "name") ?? "");
      if (name !== "") this.exportedNames.push(name);
      return;
    }
    if (declaration.kind === "VariableDeclaration") {
      for (const declarator of kids(declaration, "declarations")) {
        const id = kid(declarator, "id");
        if (id !== null && id.kind === "Identifier") {
          this.exportedNames.push(String(scalar(id, "name") ?? ""));
        }
      }
    }
  }

  private printVariableDeclaration(node: PyNode): void {
    for (const declarator of kids(node, "declarations")) {
      this.printDeclarator(declarator);
    }
    this.record({
      span: node.span,
      sourceKind: "js.VariableDeclaration",
      rule: `js.${String(node.fields["kind"] ?? "let")}→py.assignment`,
      decision: "semantic",
      rationale:
        "JS let/const/var collapse to Python assignment semantics (rebinding; Python has no block scoping — module/function scope binding is the documented mapping)",
      adaptation: "assignment",
      targetSummary: "assignment",
    });
  }

  private printDeclarator(node: PyNode): void {
    const id = kid(node, "id")!;
    const init = kid(node, "init");
    if (id.kind === "ObjectPattern") {
      if (init === null) {
        this.unsupported(id, "object destructuring without initializer", "outside the M7 subset");
        return;
      }
      this.printObjectDestructuring(id, init);
      return;
    }
    const idText = this.printBindingTarget(id, init);
    if (init === null) {
      // JS `let x;` is undefined; Python needs a binding.
      this.line(`${idText} = None`);
      this.semantic(
        node,
        "js.VariableDeclarator",
        "js.no-init→py.None",
        "JS undefined default becomes None (tri-state collapse documented)",
        "None",
        `${idText} = None`,
      );
      return;
    }
    // `const f = function() {...}` / `const g = async (x) => {...}` (BLOCK body):
    // Python's honest equivalent is a def/async-def statement, not an assignment.
    if (
      id.kind === "Identifier" &&
      (init.kind === "FunctionExpression" || init.kind === "ArrowFunctionExpression") &&
      kid(init, "body")!.kind === "BlockStatement"
    ) {
      const name = String(scalar(id, "name") ?? "");
      const prefix = init.fields["async"] === true ? "async def" : "def";
      const params = this.printParams(init);
      this.line(`${prefix} ${this.mangle(name)}(${params}):`);
      this.pushScope();
      this.indent += 1;
      this.declareParamKinds(init);
      this.printBodyStatements(kid(init, "body")!);
      this.indent -= 1;
      this.popScope();
      this.semantic(
        node,
        `js.${init.kind}`,
        "js.fn-expression→py.def",
        "function expressions with block bodies map to named defs (Python has no function-expression values)",
        "named def",
        `def ${name}`,
      );
      this.declareKind(name, "unknown");
      return;
    }
    this.line(`${idText} = ${this.printExpression(init, 0)}`);
    // Track receiver kinds for method mapping provability.
    this.declareKindFromInit(id, init);
  }

  private declareKindFromInit(id: PyNode, init: PyNode): void {
    if (id.kind !== "Identifier") return;
    const name = String(scalar(id, "name") ?? "");
    this.declareKind(name, this.inferReceiverKind(init));
  }

  private inferReceiverKind(node: PyNode): ReceiverKind {
    switch (node.kind) {
      case "ArrayExpression":
        return "array";
      case "ObjectExpression":
        return "dict";
      case "Literal":
        return typeof node.fields["value"] === "string"
          ? "string"
          : typeof node.fields["value"] === "number"
            ? "number"
            : "unknown";
      case "TemplateLiteral":
        return "string";
      case "ThisExpression":
        // Inside an instance method, `this` is a class instance. Static
        // members and module-level `this` are outside the supported subset.
        return "instance";
      case "NewExpression": {
        const callee = kid(node, "callee");
        if (
          callee !== null &&
          callee.kind === "Identifier" &&
          String(scalar(callee, "name") ?? "") === "Map"
        ) {
          return "dict";
        }
        if (
          callee !== null &&
          callee.kind === "Identifier" &&
          String(scalar(callee, "name") ?? "") === "Set"
        ) {
          return "unknown";
        }
        // new KnownClass(...) binds an instance of a class declared in this
        // unit (source-order limitation: the class must print before the use
        // site — later-declared classes keep the honest unknown kind).
        if (
          callee !== null &&
          callee.kind === "Identifier" &&
          this.classNames.has(String(scalar(callee, "name") ?? ""))
        ) {
          return "instance";
        }
        return "unknown";
      }
      default:
        return "unknown";
    }
  }

  // Destructuring targets print as parallel assignment sequences.
  private printBindingTarget(node: PyNode, init: PyNode | null): string {
    void init;
    switch (node.kind) {
      case "Identifier":
        return this.mangle(String(scalar(node, "name") ?? ""));
      case "ArrayPattern": {
        const elements = kids(node, "elements").map((element) =>
          element === null
            ? ""
            : element.kind === "RestElement"
              ? `*${this.mangle(String(scalar(kid(element, "argument"), "name") ?? ""))}`
              : this.mangle(String(scalar(element, "name") ?? "")),
        );
        return elements.join(", ");
      }
      case "ObjectPattern": {
        // `const {a, b} = obj` → key reads; hoisted to statements by the caller
        // via printObjectDestructuring (returns "" here as a marker).
        return "__OBJECT_PATTERN__";
      }
      case "AssignmentPattern":
        return this.mangle(String(scalar(kid(node, "left"), "name") ?? ""));
      default:
        return "__UNSUPPORTED_PATTERN__";
    }
  }

  private printObjectDestructuring(pattern: PyNode, init: PyNode): void {
    const objText = this.printExpression(init, 0);
    const tmp = this.freshTmp();
    this.line(`${tmp} = ${objText}`);
    for (const property of kids(pattern, "properties")) {
      if (property.kind === "RestElement") {
        this.line(
          this.unsupported(
            property,
            "object rest in destructuring",
            "rest-in-object destructuring is outside the M7 subset",
          ),
        );
        continue;
      }
      const key = String(
        scalar(kid(property, "key"), "name") ?? String(scalar(kid(property, "key"), "value") ?? ""),
      );
      const value = kid(property, "value")!;
      if (value.kind === "Identifier") {
        const local = String(scalar(value, "name") ?? "");
        this.line(
          `${this.mangle(local)} = ${this.useHelper("js_get")}(${tmp}, ${JSON.stringify(key)})`,
        );
        this.declareKind(local, "unknown");
      } else if (value.kind === "AssignmentPattern") {
        const local = String(scalar(kid(value, "left"), "name") ?? "");
        const defaultValue = this.printExpression(kid(value, "right")!, 0);
        this.line(
          `${this.mangle(local)} = ${this.useHelper("js_get")}(${tmp}, ${JSON.stringify(key)})`,
        );
        this.line(`if ${this.mangle(local)} is None: ${this.mangle(local)} = ${defaultValue}`);
        this.declareKind(local, "unknown");
      } else {
        this.unsupported(value, value.kind, "nested object destructuring outside the M7 subset");
      }
    }
    this.semantic(
      pattern,
      "js.ObjectPattern",
      "js.obj-destructure→py.key-reads",
      "object destructuring becomes key reads through the dynamic-access helper (missing keys read undefined→None, matching JS)",
      "key reads",
      `destructure { … }`,
    );
  }

  // ---- functions/classes --------------------------------------------------------
  private printParams(node: PyNode): string {
    const parts: string[] = [];
    for (const param of kids(node, "params")) {
      if (param.kind === "TSParameterProperty") {
        this.unsupported(
          param,
          "parameter property",
          "parameter properties assign fields (runtime-relevant); outside the M7 subset",
        );
        parts.push("_ctrans_param");
        this.pendingParamsComment = true;
        continue;
      }
      if (param.kind === "AssignmentPattern") {
        const left = kid(param, "left")!;
        const defaultValue = this.printExpression(kid(param, "right")!, 0);
        parts.push(`${this.mangle(String(scalar(left, "name") ?? ""))}=${defaultValue}`);
        continue;
      }
      if (param.kind === "RestElement") {
        parts.push(`*${this.mangle(String(scalar(kid(param, "argument"), "name") ?? ""))}`);
        continue;
      }
      parts.push(this.mangle(String(scalar(param, "name") ?? "")));
    }
    return parts.join(", ");
  }

  private declareParamKinds(node: PyNode): void {
    for (const param of kids(node, "params")) {
      const target =
        param.kind === "AssignmentPattern"
          ? kid(param, "left")
          : param.kind === "RestElement"
            ? kid(param, "argument")
            : param;
      if (target !== null && target.kind === "Identifier") {
        this.declareKind(String(scalar(target, "name") ?? ""), "unknown");
      }
    }
  }

  private printBodyStatements(body: PyNode): void {
    const statements = kids(body, "body");
    if (statements.length === 0) {
      this.line("pass");
      return;
    }
    const before = this.lines.length;
    for (const statement of statements) this.printStatement(statement);
    // Comment-only bodies (unsupported markers) are not Python blocks.
    this.ensureBlock(before);
  }

  // If every line emitted since `before` is a comment/blank, append `pass` so the
  // enclosing def/if/while is a valid Python block.
  private ensureBlock(before: number): void {
    for (let index = before; index < this.lines.length; index += 1) {
      const content = this.lines[index]!.trimStart();
      if (content !== "" && !content.startsWith("#")) return;
    }
    this.line("pass");
  }

  private printClass(node: PyNode): void {
    if (node.fields["declare"] === true) {
      this.eraseTypeNode(node);
      return;
    }
    if (node.fields["abstract"] === true) {
      this.line(
        this.unsupported(
          node,
          "abstract class",
          "abstract classes are type-system constructs with runtime bodies",
        ),
      );
      return;
    }
    const name = String(scalar(kid(node, "id"), "name") ?? "");
    this.classNames.add(name);
    const superNode = kid(node, "superClass");
    const bases = superNode === null ? "" : `(${this.printExpression(superNode, 0)})`;
    this.line(`class ${this.mangle(name)}${bases}:`);
    this.pushScope();
    this.indent += 1;
    const members = kids(kid(node, "body")!, "body");
    // Instance field initializers become the head of __init__ (JS runs them at
    // construction time; class-level Python attributes would SHARE mutable state).
    const instanceFields = members.filter(
      (member) => member.kind === "PropertyDefinition" && member.fields["static"] !== true,
    );
    const constructor = members.find(
      (member) =>
        member.kind === "MethodDefinition" && String(member.fields["kind"] ?? "") === "constructor",
    );
    let emittedInit = false;
    if (instanceFields.length > 0 || constructor !== undefined) {
      const params = constructor !== undefined ? this.printParams(kid(constructor, "value")!) : "";
      this.line(`def __init__(self${params === "" ? "" : `, ${params}`}):`);
      if (this.pendingParamsComment) {
        this.line(
          "# ctrans: unsupported parameter property — field assignment dropped (outside the M7 subset)",
        );
        this.pendingParamsComment = false;
      }
      this.pushScope();
      this.indent += 1;
      const beforeInit = this.lines.length;
      const superCall =
        constructor !== undefined ? this.findSuperCall(kid(constructor, "value")!) : null;
      if (superNode !== null && superCall !== null) {
        // JS super(...args) forwards its arguments to the base constructor;
        // Python's super().__init__(...args) is the corresponding call.
        const forwarded = kids(superCall, "arguments").map((argument) =>
          this.printExpression(argument, 0),
        );
        this.line(`super().__init__(${forwarded.join(", ")})`);
        this.semantic(
          superCall,
          "js.CallExpression(super)",
          "js.super(args)→py.super().__init__(args)",
          "super constructor call forwards its arguments to the base __init__; Python's super() attribute lookup approximates the JS prototype chain for the supported single-inheritance subset",
          "super().__init__(…)",
          "super(…)",
        );
      }
      for (const field of instanceFields) {
        const key = this.propertyKeyText(kid(field, "key")!, field.fields["computed"] === true);
        const value = kid(field, "value");
        this.line(
          `self.${this.mangle(key)} = ${value === null ? "None" : this.printExpression(value, 0)}`,
        );
        this.record({
          span: field.span,
          sourceKind: "js.PropertyDefinition",
          rule: "js.field→py.self-attr",
          decision: "semantic",
          rationale:
            "instance fields initialize per instance in the constructor (class attributes would share mutable state — verified Python hazard); reads of a missing attribute raise AttributeError where JS yields undefined (documented)",
          adaptation: "self.<field> in __init__",
          targetSummary: `self.${key}`,
        });
      }
      if (constructor !== undefined) {
        this.pushScope();
        this.declareParamKinds(kid(constructor, "value")!);
        const constructorBody = kid(kid(constructor, "value")!, "body");
        const bodyStatements = constructorBody === null ? [] : kids(constructorBody, "body");
        for (const statement of bodyStatements) {
          if (this.isSuperCallStatement(statement)) continue;
          this.printStatement(statement);
        }
        if (instanceFields.length === 0) {
          this.ensureBlock(beforeInit);
        }
        this.popScope();
      } else if (instanceFields.length === 0) {
        this.line("pass");
      }
      this.indent -= 1;
      this.popScope();
      emittedInit = true;
      this.record({
        span: node.span,
        sourceKind: "js.ClassDeclaration",
        rule: "js.constructor→py.__init__",
        decision: "deterministic",
        rationale: "constructor correspondence with instance-field initialization",
        targetSummary: `def __init__`,
      });
    }
    const beforeMembers = this.lines.length;
    for (const member of members) {
      if (member === constructor) continue;
      if (member.kind === "PropertyDefinition" && member.fields["static"] !== true) continue;
      this.printClassMember(member, name);
    }
    if (!emittedInit && members.length === 0) {
      this.line("pass");
    } else if (!emittedInit) {
      this.ensureBlock(beforeMembers);
    }
    this.indent -= 1;
    this.popScope();
    this.deterministic(
      node,
      "js.ClassDeclaration",
      "js.class→py.class",
      "class correspondence (single inheritance; prototype model maps to the class model)",
      `class ${name}`,
    );
  }

  // Returns the constructor's explicit super(...) CALL (whose arguments must
  // be forwarded to the base __init__), or null when there is none.
  private findSuperCall(constructor: PyNode): PyNode | null {
    const block = kid(constructor, "body");
    if (block === null) return null;
    for (const statement of kids(block, "body")) {
      if (this.isSuperCallStatement(statement)) return kid(statement, "expression")!;
    }
    return null;
  }

  private isSuperCallStatement(statement: PyNode): boolean {
    if (statement.kind !== "ExpressionStatement") return false;
    const expression = kid(statement, "expression");
    if (expression === null || expression.kind !== "CallExpression") return false;
    const callee = kid(expression, "callee");
    return callee !== null && callee.kind === "Super";
  }

  private printClassMember(node: PyNode, className: string): void {
    void className;
    if (node.kind === "MethodDefinition") {
      const isStatic = node.fields["static"] === true;
      const kind = String(node.fields["kind"] ?? "method");
      const key = this.propertyKeyText(kid(node, "key")!, node.fields["computed"] === true);
      const value = kid(node, "value")!;
      if (kind === "get") {
        this.line("@property");
        this.printFunction(value, false, key);
        this.semantic(
          node,
          "js.MethodDefinition",
          "js.getter→py.property",
          "getter maps to @property",
          "@property",
          `get ${key}`,
        );
        return;
      }
      if (kind === "set") {
        this.line(`@${this.mangle(key)}.setter`);
        this.printFunction(value, false, key);
        this.semantic(
          node,
          "js.MethodDefinition",
          "js.setter→py.setter",
          "setter maps to @name.setter",
          "@x.setter",
          `set ${key}`,
        );
        return;
      }
      if (isStatic) {
        this.line("@staticmethod");
      }
      this.printFunction(value, false, key, isStatic ? [] : ["self"]);
      this.deterministic(
        node,
        "js.MethodDefinition",
        "js.method→py.method",
        "method correspondence (this → self)",
        `def ${key}`,
      );
      return;
    }
    if (node.kind === "PropertyDefinition") {
      // Static field: class attribute (mutable static state warned).
      const key = this.propertyKeyText(kid(node, "key")!, node.fields["computed"] === true);
      const value = kid(node, "value");
      const valueText = value === null ? "None" : this.printExpression(value, 0);
      this.line(`${this.mangle(key)} = ${valueText}`);
      this.semantic(
        node,
        "js.PropertyDefinition",
        "js.static-field→py.class-attr",
        "static field becomes a class attribute (mutable values share state — documented divergence)",
        "class attribute",
        `${key}`,
      );
      return;
    }
    if (node.kind === "StaticBlock") {
      this.line(
        this.unsupported(
          node,
          "static block",
          "static initialization blocks are outside the M7 subset",
        ),
      );
      return;
    }
    if (
      node.kind === "TSAbstractMethodDefinition" ||
      node.kind === "TSAbstractPropertyDefinition"
    ) {
      this.unsupported(node, "abstract member", "abstract members are type-system constructs");
      return;
    }
    this.line(this.unsupported(node, node.kind, "class member form outside the M7 reverse subset"));
  }

  // printFunction with an optional explicit name + injected leading params (methods).
  private printFunction2(node: PyNode, name: string, injected: readonly string[]): void {
    const isAsync = node.fields["async"] === true;
    const params = this.printParamsWithInjected(node, injected);
    const prefix = isAsync ? "async def" : "def";
    this.line(`${prefix} ${this.mangle(name)}(${params}):`);
    if (this.pendingParamsComment) {
      this.line(
        "# ctrans: unsupported parameter property — field assignment dropped (outside the M7 subset)",
      );
      this.pendingParamsComment = false;
    }
    this.pushScope();
    this.indent += 1;
    this.declareParamKinds(node);
    this.printBodyStatements(kid(node, "body")!);
    this.indent -= 1;
    this.popScope();
  }

  private printParamsWithInjected(node: PyNode, injected: readonly string[]): string {
    const parts = [...injected];
    for (const param of kids(node, "params")) {
      if (param.kind === "AssignmentPattern") {
        const left = kid(param, "left")!;
        parts.push(
          `${this.mangle(String(scalar(left, "name") ?? ""))}=${this.printExpression(kid(param, "right")!, 0)}`,
        );
        continue;
      }
      if (param.kind === "RestElement") {
        parts.push(`*${this.mangle(String(scalar(kid(param, "argument"), "name") ?? ""))}`);
        continue;
      }
      parts.push(this.mangle(String(scalar(param, "name") ?? "")));
    }
    return parts.join(", ");
  }

  private printFunction(
    node: PyNode,
    forceAsync = false,
    nameOverride?: string,
    injected?: readonly string[],
  ): void {
    if (nameOverride !== undefined) {
      this.printFunction2(node, nameOverride, injected ?? ["self"]);
      return;
    }
    const nameNode = kid(node, "id");
    const name = nameNode === null ? "" : String(scalar(nameNode, "name") ?? "");
    const isAsync = forceAsync || node.fields["async"] === true;
    const params = this.printParams(node);
    const prefix = isAsync ? "async def" : "def";
    this.line(`${prefix} ${this.mangle(name)}(${params}):`);
    this.pushScope();
    this.indent += 1;
    this.declareParamKinds(node);
    this.printBodyStatements(kid(node, "body")!);
    this.indent -= 1;
    this.popScope();
    this.deterministic(
      node,
      "js.FunctionDeclaration",
      "js.function→py.def",
      "function correspondence (async preserved; generators are yield-bearing defs)",
      `def ${name}`,
    );
  }

  // ---- control flow -------------------------------------------------------------
  private printIf(node: PyNode): void {
    const test = this.truthyTest(kid(node, "test")!);
    this.line(`if ${test}:`);
    this.printBody(kid(node, "consequent")!);
    const alternate = kid(node, "alternate");
    if (alternate !== null) {
      if (alternate.kind === "IfStatement") {
        // Recurse: `elif <test>:` + bodies (the nested if's first line becomes elif).
        const before = this.lines.length;
        this.printIf(alternate);
        this.lines[before] = this.lines[before]!.replace(/^(\s*)if /, "$1elif ");
      } else {
        this.line("else:");
        this.printBody(alternate);
      }
    }
    this.deterministic(
      node,
      "js.IfStatement",
      "js.if→py.if",
      "if/elif/else correspondence (tests through the JS-truthiness helper where types diverge)",
      "if",
    );
  }

  private lineWithOverwrite(_marker: string, emit: () => void): void {
    emit();
  }

  private printBody(node: PyNode): void {
    this.pushScope();
    this.indent += 1;
    if (node.kind === "BlockStatement") {
      this.printBodyStatements(node);
    } else {
      this.printStatement(node);
    }
    this.indent -= 1;
    this.popScope();
  }

  private printDoWhile(node: PyNode): void {
    const hasContinue = this.containsContinue(kid(node, "body")!);
    if (hasContinue) {
      this.line(
        this.unsupported(
          node,
          "do-while with continue",
          "the do-while rewrite cannot reproduce continue-to-test semantics",
        ),
      );
      return;
    }
    this.line("while True:");
    this.printBody(kid(node, "body")!);
    const test = this.truthyTest(kid(node, "test")!);
    this.line(`    if not ${this.parenthesize(test)}:`);
    this.line("        break");
    this.semantic(
      node,
      "js.DoWhileStatement",
      "js.do-while→py.while-True",
      "do-while becomes while True + trailing inverted test break (JS semantics preserved)",
      "while True + break",
      "do/while",
    );
  }

  private containsContinue(node: PyNode): boolean {
    for (const value of Object.values(node.fields)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "object" && item !== null && "kind" in (item as object)) {
            const child = item as PyNode;
            if (child.kind === "ContinueStatement") return true;
            if (this.containsContinue(child)) return true;
          }
        }
      } else if (typeof value === "object" && value !== null && "kind" in (value as object)) {
        const child = value as PyNode;
        if (child.kind === "ContinueStatement") return true;
        if (this.containsContinue(child)) return true;
      }
    }
    return false;
  }

  private printFor(node: PyNode): void {
    const init = kid(node, "init");
    const test = kid(node, "test");
    const update = kid(node, "update");
    const counting = this.matchCountingLoop(init, test, update);
    if (counting !== null) {
      const { variable, start, end, step } = counting;
      const rangeArgs = step === 1 ? [start, end] : [start, end, String(step)];
      this.line(`for ${this.mangle(variable)} in range(${rangeArgs.join(", ")}):`);
      this.pushScope();
      this.indent += 1;
      this.declareKind(variable, "number");
      this.printForBody(kid(node, "body")!);
      this.indent -= 1;
      this.popScope();
      this.record({
        span: node.span,
        sourceKind: "js.ForStatement",
        rule: "js.for→py.range",
        decision: "semantic",
        rationale:
          "counting loop maps to range(); the bound expression re-evaluates per Python semantics only when step/stop are dynamic — documented by the bound form",
        adaptation: `range(${rangeArgs.join(", ")})`,
        targetSummary: `for ${variable} in range(…)`,
      });
      return;
    }
    this.line(
      this.unsupported(
        node,
        "general for loop",
        "only the counting-loop pattern maps to Python; general for(;;) rewrites are outside the M7 subset",
      ),
    );
  }

  // Recognizes `for (let i = A; i < B; i++)` (and <=, --, i += k, i -= k).
  private matchCountingLoop(
    init: PyNode | null,
    test: PyNode | null,
    update: PyNode | null,
  ): { variable: string; start: string; end: string; step: number } | null {
    if (init === null || test === null || update === null) return null;
    if (init.kind !== "VariableDeclaration" || kids(init, "declarations").length !== 1) return null;
    const declarator = kids(init, "declarations")[0]!;
    const id = kid(declarator, "id");
    if (id === null || id.kind !== "Identifier") return null;
    const variable = String(scalar(id, "name") ?? "");
    const startNode = kid(declarator, "init");
    if (startNode === null) return null;
    const start = this.printExpression(startNode, 0);
    // test: i < B | i <= B | i > B | i >= B
    if (test.kind !== "BinaryExpression") return null;
    const testOp = String(test.fields["operator"] ?? "");
    const testLeft = kid(test, "left");
    const testRight = kid(test, "right");
    if (testLeft === null || testRight === null) return null;
    const leftName = testLeft.kind === "Identifier" ? String(scalar(testLeft, "name") ?? "") : null;
    const rightName =
      testRight.kind === "Identifier" ? String(scalar(testRight, "name") ?? "") : null;
    let end = "";
    if (leftName === variable && (testOp === "<" || testOp === "<=")) {
      end = this.printExpression(testRight, 0);
      if (testOp === "<=") end = `${end} + 1`;
    } else if (rightName === variable && (testOp === ">" || testOp === ">=")) {
      end = this.printExpression(testLeft, 0);
      if (testOp === ">=") end = `${end} + 1`;
    } else if (
      leftName === variable &&
      (testOp === ">" || testOp === ">=") &&
      testRight !== null &&
      testRight.kind === "Literal" &&
      typeof testRight.fields["value"] === "number"
    ) {
      // `i > B` / `i >= B` with a literal bound (descending): range stops BEFORE
      // its stop value, so stop = B for `>` (last value B+1) and B-1 for `>=`
      // (last value B).
      const bound = testRight.fields["value"] as number;
      end = String(testOp === ">" ? bound : bound - 1);
    } else {
      return null;
    }
    // update: i++ | i-- | i += k | i -= k
    const updateOp = String(update.fields["operator"] ?? "");
    let step = 0;
    if (update.kind === "UpdateExpression" && updateOp === "++") {
      step = 1;
    } else if (update.kind === "UpdateExpression" && updateOp === "--") {
      step = -1;
    } else if (update.kind === "AssignmentExpression" && updateOp === "+=") {
      const amount = kid(update, "right");
      step =
        amount !== null && amount.kind === "Literal" && typeof amount.fields["value"] === "number"
          ? (amount.fields["value"] as number)
          : Number.NaN;
    } else if (update.kind === "AssignmentExpression" && updateOp === "-=") {
      const amount = kid(update, "right");
      step =
        amount !== null && amount.kind === "Literal" && typeof amount.fields["value"] === "number"
          ? -(amount.fields["value"] as number)
          : Number.NaN;
    }
    if (!Number.isInteger(step) || step === 0) return null;
    return { variable, start, end, step };
  }

  private printForBody(node: PyNode): void {
    if (node.kind === "BlockStatement") {
      this.printBodyStatements(node);
    } else {
      this.printStatement(node);
    }
  }

  private printForOf(node: PyNode): void {
    const left = kid(node, "left")!;
    const right = this.printExpression(kid(node, "right")!, 0);
    const pattern =
      left.kind === "VariableDeclaration" ? kid(kids(left, "declarations")[0]!, "id")! : left;
    if (pattern.kind !== "Identifier") {
      this.unsupported(
        pattern,
        "destructuring for-of target",
        "destructuring for-of is outside the M7 subset",
      );
      return;
    }
    const name = String(scalar(pattern, "name") ?? "");
    const awaitPrefix = node.fields["await"] === true ? "await " : "";
    this.line(`for ${this.mangle(name)} in ${awaitPrefix}${right}:`);
    this.pushScope();
    this.indent += 1;
    this.declareKind(name, "unknown");
    this.printForBody(kid(node, "body")!);
    this.indent -= 1;
    this.popScope();
    this.deterministic(
      node,
      "js.ForOfStatement",
      "js.for-of→py.for-in",
      "for-of iteration correspondence",
      `for ${name} in …`,
    );
  }

  private printForIn(node: PyNode): void {
    const left = kid(node, "left")!;
    const right = kid(node, "right")!;
    const rightText = this.printExpression(right, 0);
    const pattern =
      left.kind === "VariableDeclaration" ? kid(kids(left, "declarations")[0]!, "id")! : left;
    if (pattern.kind !== "Identifier") {
      this.unsupported(
        pattern,
        "destructuring for-in target",
        "destructuring for-in is outside the M7 subset",
      );
      return;
    }
    const name = String(scalar(pattern, "name") ?? "");
    const keysFn = this.useHelper("js_array_from_keys");
    this.line(`for ${this.mangle(name)} in ${keysFn}(${rightText}):`);
    this.pushScope();
    this.indent += 1;
    this.declareKind(name, "string");
    this.printForBody(kid(node, "body")!);
    this.indent -= 1;
    this.popScope();
    this.semantic(
      node,
      "js.ForInStatement",
      "js.for-in→py.keys-helper",
      "for-in enumerates keys with JS semantics (stringified array indexes; object keys)",
      "keys helper",
      `for ${name} in keys(…)`,
    );
  }

  private printSwitch(node: PyNode): void {
    const discriminant = this.printExpression(kid(node, "discriminant")!, 0);
    const cases = kids(node, "cases");
    // Fallthrough detection: a case whose consequent lacks break/return/throw
    // before the next case is a fallthrough — unsupported (honest).
    for (let index = 0; index < cases.length - 1; index += 1) {
      const consequent = kids(cases[index]!, "consequent");
      const last = consequent[consequent.length - 1];
      if (
        consequent.length === 0 ||
        (last !== undefined &&
          last.kind !== "BreakStatement" &&
          last.kind !== "ReturnStatement" &&
          last.kind !== "ThrowStatement" &&
          last.kind !== "ContinueStatement")
      ) {
        this.line(
          this.unsupported(
            cases[index]!,
            "case fallthrough",
            "case fallthrough has no Python equivalent; outside the M7 subset",
          ),
        );
        return;
      }
    }
    const tmp = this.freshTmp();
    this.line(`${tmp} = ${discriminant}`);
    let first = true;
    for (const caseNode of cases) {
      const test = kid(caseNode, "test");
      const consequent = kids(caseNode, "consequent");
      const trimmed =
        consequent.length > 0 && consequent[consequent.length - 1]!.kind === "BreakStatement"
          ? consequent.slice(0, -1)
          : consequent;
      if (test === null) {
        this.line("else:");
      } else {
        this.line(`${first ? "if" : "elif"} ${tmp} == ${this.printExpression(test, 0)}:`);
      }
      first = false;
      this.pushScope();
      this.indent += 1;
      if (trimmed.length === 0) this.line("pass");
      for (const statement of trimmed) this.printStatement(statement);
      this.indent -= 1;
      this.popScope();
    }
    this.semantic(
      node,
      "js.SwitchStatement",
      "js.switch→py.if-elif",
      "no-fallthrough switch becomes an if/elif chain over a temporary (fallthrough cases are unsupported-loud)",
      "if/elif chain",
      "switch",
    );
  }

  private printThrow(node: PyNode): void {
    const argument = kid(node, "argument")!;
    const throwTarget = this.printExpression(argument, 0);
    if (argument.kind === "NewExpression") {
      this.line(`raise ${throwTarget}`);
      this.deterministic(
        node,
        "js.ThrowStatement",
        "js.throw→py.raise",
        "throw of a constructed error maps to raise",
        "raise",
      );
      return;
    }
    // Non-Error throwables wrap in RuntimeError (policy §2.4).
    this.line(`raise RuntimeError(${throwTarget})`);
    this.semantic(
      node,
      "js.ThrowStatement",
      "js.throw-non-error→py.RuntimeError",
      "JS may throw any value; Python raise requires an exception — non-Error values wrap in RuntimeError",
      "RuntimeError wrap",
      `raise RuntimeError(…)`,
    );
  }

  private printTry(node: PyNode): void {
    this.line("try:");
    this.printBody(kid(node, "block")!);
    const handler = kid(node, "handler");
    if (handler !== null) {
      const param = kid(handler, "param");
      const name = param !== null ? this.mangle(String(scalar(param, "name") ?? "")) : null;
      if (name !== null) {
        this.line(`except Exception as ${name}:`);
      } else {
        this.line("except Exception:");
      }
      this.pushScope();
      this.indent += 1;
      if (name !== null) this.declareKind(name, "unknown");
      this.printBodyStatements(kid(handler, "body")!);
      this.indent -= 1;
      this.popScope();
      this.semantic(
        handler,
        "js.CatchClause",
        "js.catch→py.except-Exception",
        "JS catch intercepts every throwable; Python maps to Exception (BaseException-family pass-through documented)",
        "except Exception",
        "catch",
      );
    }
    const finalizer = kid(node, "finalizer");
    if (finalizer !== null) {
      this.line("finally:");
      this.printBody(finalizer);
    }
  }

  // ---- expressions ----------------------------------------------------------------
  private printExpression(node: PyNode, _parentPrecedence: number): string {
    const text = this.printExpressionInner(node);
    return text;
  }

  private parenthesize(text: string): string {
    return `(${text})`;
  }

  private printExpressionInner(node: PyNode): string {
    switch (node.kind) {
      case "Identifier": {
        const name = String(scalar(node, "name") ?? "");
        if (name === "NaN") {
          this.helpers.add("numeric_constants");
          this.semantic(
            node,
            "js.Identifier(NaN)",
            "js.NaN→py.math-nan",
            "JavaScript NaN maps to a Python float NaN",
            "math.nan",
            "NaN",
          );
          return "_ctrans_nan()";
        }
        if (name === "Infinity") {
          this.helpers.add("numeric_constants");
          this.semantic(
            node,
            "js.Identifier(Infinity)",
            "js.Infinity→py.math-inf",
            "JavaScript Infinity maps to Python math.inf",
            "math.inf",
            "Infinity",
          );
          return "_ctrans_infinity()";
        }
        if (name === "undefined") {
          this.record({
            span: node.span,
            sourceKind: "js.Identifier(undefined)",
            rule: "js.undefined→py.None",
            decision: "semantic",
            rationale: "undefined collapses to None (tri-state loss documented, policy §2.3)",
            adaptation: "None",
            targetSummary: "None",
          });
          return "None";
        }
        return this.mangle(name);
      }
      case "ThisExpression":
        return "self";
      case "Super":
        return "super";
      case "Literal": {
        const raw = node.fields["raw"];
        const value = node.fields["value"];
        if (typeof value === "string") return JSON.stringify(value);
        if (typeof value === "number") {
          if (typeof raw === "string" && !raw.includes("_")) return raw;
          return Number.isInteger(value) ? String(value) : String(value);
        }
        if (typeof value === "boolean") return value ? "True" : "False";
        if (value === null) {
          this.record({
            span: node.span,
            sourceKind: "js.Literal(null)",
            rule: "js.null→py.None",
            decision: "semantic",
            rationale: "null/undefined collapse to None (tri-state loss documented, policy §2.3)",
            adaptation: "None",
            targetSummary: "None",
          });
          return "None";
        }
        if (node.fields["regex"] !== undefined) {
          const pattern = String(node.fields["regex.pattern"] ?? "");
          const flags = String(node.fields["regex.flags"] ?? "");
          this.helpers.add("re");
          const flagMap: Record<string, string> = {
            g: "",
            i: "re.IGNORECASE",
            m: "re.MULTILINE",
            s: "re.DOTALL",
            u: "",
            y: "",
          };
          const pyFlags = flags
            .split("")
            .map((flag) => flagMap[flag] ?? "")
            .filter((flag) => flag !== "");
          this.record({
            span: node.span,
            sourceKind: "js.Literal(regex)",
            rule: "js.regex→py.re",
            decision: "semantic",
            rationale:
              "regex literals map to re.compile; the flag set is audited (g/y have no Python counterpart) and the dialect is verified-compatible for the supported subset",
            adaptation: "re.compile",
            targetSummary: `re.compile(${JSON.stringify(pattern)})`,
          });
          return `re.compile(${JSON.stringify(pattern)}${pyFlags.length > 0 ? `, ${pyFlags.join(" | ")}` : ""})`;
        }
        return this.unsupported(node, "literal", "literal form outside the M7 reverse subset");
      }
      case "TemplateLiteral":
        return this.printTemplate(node);
      case "TaggedTemplateExpression":
        return this.unsupported(
          node,
          "tagged template",
          "tagged templates have no Python-faithful general form",
        );
      case "ArrayExpression": {
        const elements = kids(node, "elements").map((element) =>
          element === null
            ? ""
            : element.kind === "SpreadElement"
              ? `*${this.printExpression(kid(element, "argument")!, 0)}`
              : this.printExpression(element, 0),
        );
        return `[${elements.join(", ")}]`;
      }
      case "ObjectExpression": {
        const properties = kids(node, "properties").map((property) => {
          if (property.kind === "SpreadElement") {
            return `**${this.printExpression(kid(property, "argument")!, 0)}`;
          }
          if (property.kind === "ObjectMethod" || property.kind === "ObjectAccessor") {
            return this.unsupported(
              property,
              property.kind,
              "object methods outside the M7 reverse subset",
            );
          }
          const computed = property.fields["computed"] === true;
          const key = this.propertyKeyText(kid(property, "key")!, computed);
          const value = this.printExpression(kid(property, "value")!, 0);
          return `${JSON.stringify(key)}: ${value}`;
        });
        return `{${properties.filter((entry) => entry !== "").join(", ")}}`;
      }
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        const params = this.printParams(node);
        const body = kid(node, "body")!;
        if (node.fields["async"] === true) {
          return this.unsupported(
            node,
            "async arrow/function expression",
            "async function expressions need asyncio scoping; outside the M7 subset",
          );
        }
        if (body.kind === "BlockStatement") {
          const name = this.freshTmp();
          const before = this.lines.length;
          this.indent = 0;
          this.line(`${name} = None  # ctrans: inline function expression (single-use closure)`);
          this.lines.length = before;
          this.unsupported(
            node,
            "block-bodied function expression",
            "multi-statement function expressions in expression position are outside the M7 subset",
          );
          return "__CTRANS_UNSUPPORTED_FUNCTION__";
        }
        // Expression-bodied arrow → lambda.
        const lambdaBody = this.printExpression(body, 0);
        return `lambda ${params}: ${lambdaBody}`;
      }
      case "UnaryExpression": {
        const operator = String(node.fields["operator"] ?? "");
        const argumentNode = kid(node, "argument")!;
        if (operator === "typeof") {
          const fn = this.useHelper("typeof");
          this.semantic(
            node,
            "js.UnaryExpression(typeof)",
            "js.typeof→py.typeof",
            "typeof maps to the helper reproducing JS's strings (number/string/boolean/undefined/object/function); null/undefined collapse documented",
            "typeof",
            "typeof x",
          );
          return `${fn}(${this.printExpression(argumentNode, 0)})`;
        }
        if (operator === "void") {
          return `(${this.printExpression(argumentNode, 0)} and None)`;
        }
        if (operator === "delete") {
          const fn = this.useHelper("js_delete");
          if (argumentNode.kind === "MemberExpression") {
            const objectText = this.printExpression(kid(argumentNode, "object")!, 0);
            const key =
              argumentNode.fields["computed"] === true
                ? this.printExpression(kid(argumentNode, "property")!, 0)
                : JSON.stringify(String(scalar(kid(argumentNode, "property"), "name") ?? ""));
            return `${fn}(${objectText}, ${key})`;
          }
          return this.unsupported(
            node,
            "delete of non-member",
            "delete applies to properties only",
          );
        }
        const argumentText = this.printExpression(argumentNode, 1);
        const py =
          operator === "!"
            ? `not ${this.truthyOperand(argumentNode, argumentText)}`
            : `${operator}${argumentText}`;
        return py;
      }
      case "UpdateExpression": {
        const operator = String(node.fields["operator"] ?? "");
        const target = kid(node, "argument")!;
        const amount = operator === "++" ? "+ 1" : "- 1";
        // Member targets: rewrite as a read-modify-write statement. The read goes
        // through the undefined-for-missing helper; the write creates the property
        // (JS semantics).
        if (target.kind === "MemberExpression") {
          const writeText = this.assignmentTargetText(target);
          const readText = this.printExpression(target, 0);
          this.pendingStatement(`${writeText} = ${readText} ${amount}`);
          return "None";
        }
        const targetText = this.printExpression(target, 0);
        if (node.fields["prefix"] === true) {
          // ++x evaluates to the new value; as a sub-expression this needs a
          // statement context — unsupported in expression position (honest).
          return this.unsupported(
            node,
            `${operator} in expression position`,
            "prefix update as a value is outside the M7 subset",
          );
        }
        // x++ as a statement value: JS yields the OLD value.
        const tmp = this.freshTmp();
        this.pendingStatement(`${tmp} = ${targetText}`);
        this.pendingStatement(`${targetText} = ${targetText} ${amount}`);
        return tmp;
      }
      case "BinaryExpression":
        return this.printBinary(node);
      case "LogicalExpression": {
        const operator = String(node.fields["operator"] ?? "");
        const left = kid(node, "left")!;
        const right = kid(node, "right")!;
        if (operator === "&&" || operator === "||") {
          // Short-circuit with JS truthiness on the left operand: evaluate left
          // once into a temp when it is not provably boolean.
          const leftText = this.printExpression(left, 0);
          if (this.isProvableBoolean(left)) {
            const pyOp = operator === "&&" ? "and" : "or";
            return `(${leftText} ${pyOp} ${this.printExpression(right, 0)})`;
          }
          const truthy = this.useHelper("truthy");
          const tmp = this.freshTmp();
          this.pendingStatement(`${tmp} = ${leftText}`);
          const pyOp = operator === "&&" ? "and" : "or";
          const conditional = `(${tmp} ${pyOp} ${this.printExpression(right, 0)})`;
          // JS semantics: && yields the LEFT value (not a boolean) when falsy —
          // Python `and` also yields the operand value ✓, but the TEST must use
          // JS truthiness.
          this.pendingStatement(`if not ${truthy}(${tmp}): ${tmp}`);
          return conditional;
        }
        if (operator === "??") {
          const leftText = this.printExpression(left, 0);
          const tmp = this.freshTmp();
          this.pendingStatement(`${tmp} = ${leftText}`);
          return `(${tmp} if ${tmp} is not None else ${this.printExpression(right, 0)})`;
        }
        return this.unsupported(node, "logical operator", `${operator} outside the M7 subset`);
      }
      case "AssignmentExpression": {
        const operator = String(node.fields["operator"] ?? "=");
        const target = kid(node, "left")!;
        const value = kid(node, "right")!;
        const targetText = this.assignmentTargetText(target);
        if (operator === "=") {
          return `${targetText} = ${this.printExpression(value, 0)}`;
        }
        if (operator === "+=") {
          const add = this.useHelper("js_add");
          if (this.isProvableNumber(target) && this.isProvableNumber(value)) {
            return `${targetText} = ${targetText} + ${this.printExpression(value, 0)}`;
          }
          return `${targetText} = ${add}(${targetText}, ${this.printExpression(value, 0)})`;
        }
        if (operator === "-=" || operator === "*=" || operator === "/=" || operator === "**=") {
          const pyOp = operator.slice(0, 1);
          return `${targetText} = ${targetText} ${pyOp} ${this.printExpression(value, 0)}`;
        }
        if (operator === "%=") {
          const mod = this.useHelper("js_mod");
          return `${targetText} = ${mod}(${targetText}, ${this.printExpression(value, 0)})`;
        }
        return this.unsupported(
          node,
          `assignment ${operator}`,
          "assignment form outside the M7 reverse subset",
        );
      }
      case "ConditionalExpression": {
        // `test ? a : b` → `(a if truthy(test) else b)`. The test must evaluate
        // ONCE (both branches may have side effects): temp when not provable.
        const testNode = kid(node, "test")!;
        const testText = this.printExpression(testNode, 0);
        const consequent = this.printExpression(kid(node, "consequent")!, 0);
        const alternate = this.printExpression(kid(node, "alternate")!, 0);
        if (this.isProvableBoolean(testNode)) {
          return `(${consequent} if ${testText} else ${alternate})`;
        }
        const tmp = this.freshTmp();
        this.pendingStatement(`${tmp} = ${testText}`);
        return `(${consequent} if ${this.truthyOperand(testNode, tmp)} else ${alternate})`;
      }
      case "CallExpression":
      case "NewExpression":
        return this.printCall(node);
      case "MemberExpression":
        return this.printMember(node);
      case "ParenthesizedExpression":
        return this.printExpression(kid(node, "expression")!, 0);
      case "ChainExpression": {
        const inner = kid(node, "expression")!;
        if (inner.kind === "MemberExpression" && inner.fields["optional"] === true) {
          return this.printOptionalMember(inner);
        }
        return this.printExpression(inner, 0);
      }
      case "SequenceExpression": {
        // Sequences evaluate left-to-right; only the last value is the result.
        const expressions = kids(node, "expressions");
        const parts = expressions
          .slice(0, -1)
          .map((expression) => this.printExpression(expression, 0));
        for (const part of parts) this.pendingStatement(part);
        return this.printExpression(expressions[expressions.length - 1]!, 0);
      }
      case "AwaitExpression":
        return `await ${this.printExpression(kid(node, "argument")!, 0)}`;
      case "YieldExpression": {
        const delegate = node.fields["delegate"] === true;
        const argument = kid(node, "argument");
        if (delegate) {
          return `yield from ${argument === null ? "" : this.printExpression(argument, 0)}`;
        }
        return `yield${argument === null ? "" : ` ${this.printExpression(argument, 0)}`}`;
      }
      case "SpreadElement":
        return this.unsupported(
          node,
          "spread outside a call/array/object",
          "spread form outside the M7 reverse subset",
        );
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
      case "TSTypeAssertion": {
        if (node.kind !== "TSNonNullExpression") this.eraseTypeNode(node);
        const inner = kid(node, "expression") ?? kid(node, "operand");
        return inner === null ? "" : this.printExpression(inner, 0);
      }
      default:
        return this.unsupported(node, node.kind, "expression form outside the M7 reverse subset");
    }
  }

  // Statements that had to be emitted to preserve evaluation order (sequence
  // expressions, post-update, logical short-circuit temps).
  private pendingStatement(text: string): void {
    this.line(text);
  }

  private assignmentTargetText(node: PyNode): string {
    if (node.kind === "MemberExpression") {
      const objectNode = kid(node, "object")!;
      const objectText = this.printExpression(objectNode, 0);
      const propertyName = String(scalar(kid(node, "property"), "name") ?? "");
      // Instance state writes are attribute writes (self.x = v).
      if (objectNode.kind === "ThisExpression") {
        return `self.${this.mangle(propertyName)}`;
      }
      if (node.fields["computed"] === true) {
        return `${objectText}[${this.printExpression(kid(node, "property")!, 0)}]`;
      }
      // Class-instance receivers take real attribute writes; JS objects that
      // are dicts in the target model keep dict writes (missing keys create
      // entries) for dict receivers AND untyped receivers alike.
      if (this.receiverKindOf(objectNode) === "instance") {
        return `${objectText}.${this.mangle(propertyName)}`;
      }
      if (
        this.receiverKindOf(objectNode) !== "string" &&
        this.receiverKindOf(objectNode) !== "array" &&
        this.receiverKindOf(objectNode) !== "number"
      ) {
        return `${objectText}[${JSON.stringify(propertyName)}]`;
      }
      return `${objectText}.${this.mangle(propertyName)}`;
    }
    return this.printExpression(node, 0);
  }

  private isProvableNumber(node: PyNode): boolean {
    if (node.kind === "Literal") return typeof node.fields["value"] === "number";
    if (node.kind === "Identifier")
      return this.kindOf(String(scalar(node, "name") ?? "")) === "number";
    if (node.kind === "BinaryExpression") {
      const operator = String(node.fields["operator"] ?? "");
      return ["+", "-", "*", "/", "%", "**"].includes(operator);
    }
    return false;
  }

  private isProvableBoolean(node: PyNode): boolean {
    if (node.kind === "Literal") return typeof node.fields["value"] === "boolean";
    if (node.kind === "BinaryExpression") {
      return ["==", "!=", "===", "!==", "<", "<=", ">", ">="].includes(
        String(node.fields["operator"] ?? ""),
      );
    }
    if (node.kind === "Identifier") return false;
    return false;
  }

  // Boolean contexts: JS truthiness via helper unless provably equivalent.
  private truthyTest(node: PyNode): string {
    const text = this.printExpression(node, 0);
    return this.truthyOperand(node, text);
  }

  private truthyOperand(node: PyNode, text: string): string {
    if (this.isProvableBoolean(node)) return text;
    if (node.kind === "Literal") {
      const value = node.fields["value"];
      if (typeof value === "string") return text; // "" falsy, non-empty truthy in both
      if (typeof value === "number") {
        // 0/NaN falsy in JS; Python: 0 falsy, NaN TRUTHY — NaN literals only.
        return text;
      }
      if (value === null) return "False";
      return text;
    }
    if (node.kind === "Identifier") {
      const kind = this.kindOf(String(scalar(node, "name") ?? ""));
      if (kind === "string") return text;
      if (kind === "array" || kind === "dict") return `len(${text}) > 0`;
      const truthy = this.useHelper("truthy");
      return `${truthy}(${text})`;
    }
    const truthy = this.useHelper("truthy");
    return `${truthy}(${text})`;
  }

  private printBinary(node: PyNode): string {
    const operator = String(node.fields["operator"] ?? "");
    const left = kid(node, "left")!;
    const right = kid(node, "right")!;
    if (operator === "==") {
      const loose = this.useHelper("js_loose_eq");
      this.semantic(
        node,
        "js.BinaryExpression(==)",
        "js.==→py.js_loose_eq",
        "JS == coerces scalars; the helper covers the tested null/boolean/number/string subset",
        "js_loose_eq helper",
        "==",
      );
      return `${loose}(${this.printExpression(left, 0)}, ${this.printExpression(right, 0)})`;
    }
    if (operator === "!=") {
      const loose = this.useHelper("js_loose_eq");
      this.semantic(
        node,
        "js.BinaryExpression(!=)",
        "js.!=→py.not-js_loose_eq",
        "JS != negates the tested loose-equality scalar mapping",
        "not js_loose_eq helper",
        "!=",
      );
      return `not ${loose}(${this.printExpression(left, 0)}, ${this.printExpression(right, 0)})`;
    }
    if (operator === "===") {
      this.semantic(
        node,
        "js.BinaryExpression(===)",
        "js.===→py.==",
        "JS strict equality maps to Python == (identical for primitives; object identity vs __eq__ documented)",
        "==",
        "==",
      );
      return `(${this.printExpression(left, 7)} == ${this.printExpression(right, 7)})`;
    }
    if (operator === "!==") {
      this.semantic(
        node,
        "js.BinaryExpression(!==)",
        "js.!==→py.!=",
        "JS strict inequality maps to Python != (same primitive/object note as ===)",
        "!=",
        "!==",
      );
      return `(${this.printExpression(left, 7)} != ${this.printExpression(right, 7)})`;
    }
    if (operator === "instanceof") {
      const fn = this.useHelper("js_instanceof");
      this.semantic(
        node,
        "js.BinaryExpression(instanceof)",
        "js.instanceof→py.js_instanceof",
        "instanceof maps to isinstance over the translated class model",
        "isinstance",
        "instanceof",
      );
      return `${fn}(${this.printExpression(left, 0)}, ${this.printExpression(right, 0)})`;
    }
    if (operator === "in") {
      const fn = this.useHelper("js_in");
      this.semantic(
        node,
        "js.BinaryExpression(in)",
        "js.in→py.js_in",
        "JS in checks keys on objects, INDICES on arrays, substrings on strings — the helper reproduces all three (Python in only covers dicts/strings)",
        "js_in",
        "in",
      );
      return `${fn}(${this.printExpression(left, 0)}, ${this.printExpression(right, 0)})`;
    }
    if (operator === "%") {
      const mod = this.useHelper("js_mod");
      this.semantic(
        node,
        "js.BinaryExpression(%)",
        "js.%→py.js_mod",
        "JS % truncates toward zero and yields NaN for a zero divisor; the helper preserves both",
        "js_mod",
        "%",
      );
      return `${mod}(${this.printExpression(left, 0)}, ${this.printExpression(right, 0)})`;
    }
    if (operator === "/") {
      const divide = this.useHelper("js_div");
      this.semantic(
        node,
        "js.BinaryExpression(/)",
        "js./→py.js_div",
        "JS division by zero yields signed Infinity or NaN instead of Python's ZeroDivisionError",
        "js_div",
        "/",
      );
      return `${divide}(${this.printExpression(left, 0)}, ${this.printExpression(right, 0)})`;
    }
    const leftText = this.printExpression(left, PRECEDENCE[operator] ?? 0);
    const rightText = this.printExpression(
      right,
      (PRECEDENCE[operator] ?? 0) + (operator === "**" ? 0 : 1),
    );
    if (operator === "+") {
      const add = this.useHelper("js_add");
      if (this.isProvableString(left) || this.isProvableString(right)) {
        // JS string concatenation coerces the other side; Python raises.
        this.semantic(
          node,
          "js.BinaryExpression(+)",
          "js.+→py.js_add",
          "JS + coerces with String() spellings; Python raises on mixed types",
          "js_add",
          "…",
        );
        return `${add}(${this.printExpression(left, 0)}, ${this.printExpression(right, 0)})`;
      }
      if (!this.isProvableNumber(left) || !this.isProvableNumber(right)) {
        this.semantic(
          node,
          "js.BinaryExpression(+)",
          "js.+→py.js_add",
          "operands are statically unknown — JS + may add or concatenate; the helper decides at runtime exactly like JS",
          "js_add",
          "…",
        );
        return `${add}(${this.printExpression(left, 0)}, ${this.printExpression(right, 0)})`;
      }
    }
    this.deterministic(
      node,
      "js.BinaryExpression",
      `js.${operator}→py.${operator}`,
      "operator correspondence (numeric semantics match for the mapped operand types)",
      `${leftText} ${operator} ${rightText}`,
    );
    return `${leftText} ${operator} ${rightText}`;
  }

  private isProvableString(node: PyNode): boolean {
    if (node.kind === "Literal") return typeof node.fields["value"] === "string";
    if (node.kind === "TemplateLiteral") return true;
    if (node.kind === "Identifier")
      return this.kindOf(String(scalar(node, "name") ?? "")) === "string";
    return false;
  }

  private printTemplate(node: PyNode): string {
    this.deterministic(
      node,
      "js.TemplateLiteral",
      "js.template→py.fstring",
      "template literal correspondence (interpolations of non-string values stringify with JS String() spellings)",
      "f-string",
    );
    const quasis = kids(node, "quasis");
    const expressions = kids(node, "expressions");
    let text = 'f"';
    for (let index = 0; index < quasis.length; index += 1) {
      const raw = String(quasis[index]!.fields["value.raw"] ?? "");
      text += raw.replaceAll('"', '\\"').replaceAll("{", "{{").replaceAll("}", "}}");
      if (index < expressions.length) {
        const expression = expressions[index]!;
        const expressionText = this.printExpression(expression, 0);
        const needsStr = !this.isProvableString(expression);
        text += needsStr
          ? `{${this.useHelper("str_js")}(${expressionText})}`
          : `{${expressionText}}`;
      }
    }
    return `${text}"`;
  }

  private printCall(node: PyNode): string {
    const isNew = node.kind === "NewExpression";
    const callee = kid(node, "callee")!;
    // String(x) → the JS-stringification helper (true/null spellings).
    if (
      !isNew &&
      callee.kind === "Identifier" &&
      String(scalar(callee, "name") ?? "") === "String"
    ) {
      const args = kids(node, "arguments");
      return `${this.useHelper("str_js")}(${args.length > 0 ? this.printExpression(args[0]!, 0) : "None"})`;
    }
    if (
      !isNew &&
      callee.kind === "Identifier" &&
      String(scalar(callee, "name") ?? "") === "Number"
    ) {
      const args = kids(node, "arguments");
      const converted = args.length > 0 ? this.printExpression(args[0]!, 0) : "0";
      this.semantic(
        node,
        "js.Number",
        "js.Number→py.js_number",
        "JS Number coercion for the tested scalar subset; null/undefined collapse is semantic",
        "js_number helper",
        "Number(...)",
      );
      return `${this.useHelper("js_number")}(${converted})`;
    }
    // Math.* surface.
    if (callee.kind === "MemberExpression") {
      const objectNode = kid(callee, "object")!;
      if (
        objectNode.kind === "Identifier" &&
        String(scalar(objectNode, "name") ?? "") === "Math" &&
        node.fields["computed"] !== true
      ) {
        const method = String(scalar(kid(callee, "property"), "name") ?? "");
        const args = kids(node, "arguments").map((argument) => this.printExpression(argument, 0));
        this.semantic(
          node,
          `js.Math.${method}`,
          `js.Math.${method}→py.math-entry`,
          "Math entry maps the documented JS boundary cases (NaN, infinity, signed zero) rather than Python math exceptions",
          "math_entry helper",
          `Math.${method}(…)`,
        );
        const mathFn = this.useHelper("math_entry");
        return `${mathFn}(${JSON.stringify(method)}${args.length > 0 ? `, ${args.join(", ")}` : ""})`;
      }
      if (
        objectNode.kind === "Identifier" &&
        String(scalar(objectNode, "name") ?? "") === "console" &&
        node.fields["computed"] !== true
      ) {
        const method = String(scalar(kid(callee, "property"), "name") ?? "");
        if (method === "log" || method === "info" || method === "warn" || method === "error") {
          const args = kids(node, "arguments").map((argument) => this.printExpression(argument, 0));
          // Any string-literal argument may carry printf-style directives (JS
          // console.log scans every argument, not just the first).
          const formatDirective = kids(node, "arguments").some(
            (argument) =>
              argument.kind === "Literal" &&
              typeof argument.fields["value"] === "string" &&
              (argument.fields["value"] as string).includes("%"),
          );
          this.record({
            span: node.span,
            sourceKind: `js.console.${method}`,
            rule: `js.console.${method}→py.console_${method === "warn" || method === "error" ? "error" : "log"}`,
            decision: "semantic",
            rationale: formatDirective
              ? "basic space-separated JS String() output; printf-style directives are not interpreted"
              : "basic space-separated JS String() output on the console method's stream",
            adaptation: `${method === "warn" || method === "error" ? "error" : "log"} helper`,
            warnings: formatDirective ? ["CTW-CONSOLE-FORMAT-DIRECTIVE"] : [],
            targetSummary: `console.${method}(…)`,
          });
          const helper = this.useHelper(
            method === "warn" || method === "error" ? "console_error" : "console_log",
          );
          return `${helper}(${args.join(", ")})`;
        }
      }
      if (
        objectNode.kind === "Identifier" &&
        String(scalar(objectNode, "name") ?? "") === "JSON" &&
        node.fields["computed"] !== true
      ) {
        const method = String(scalar(kid(callee, "property"), "name") ?? "");
        const args = kids(node, "arguments").map((argument) => this.printExpression(argument, 0));
        if (method === "stringify") {
          return `__import__("json").dumps(${args[0] ?? "None"})`;
        }
        if (method === "parse") {
          return `__import__("json").loads(${args[0] ?? "None"})`;
        }
      }
      if (
        objectNode.kind === "Identifier" &&
        String(scalar(objectNode, "name") ?? "") === "Object" &&
        node.fields["computed"] !== true
      ) {
        const method = String(scalar(kid(callee, "property"), "name") ?? "");
        const args = kids(node, "arguments").map((argument) => this.printExpression(argument, 0));
        if (method === "keys") {
          this.semantic(
            node,
            "js.Object.keys",
            "js.Object.keys→py.object_keys",
            "Object.keys maps to the dict-keys helper (list() materializes the JS-array shape)",
            "keys helper",
            "Object.keys(…)",
          );
          return `${this.useHelper("js_object_keys")}(${args[0] ?? "{}"})`;
        }
        if (method === "values") return `${this.useHelper("js_object_values")}(${args[0] ?? "{}"})`;
        if (method === "entries")
          return `${this.useHelper("js_object_entries")}(${args[0] ?? "{}"})`;
        if (method === "assign") {
          const target = args[0] ?? "{}";
          const merges = args.slice(1).map((source) => `**${source}`);
          return `{**${target}${merges.length > 0 ? `, ${merges.join(", ")}` : ""}}`;
        }
      }
    }
    // Array method mappings on provably-array receivers.
    if (callee.kind === "MemberExpression") {
      const mapped = this.tryArrayMethod(callee, node);
      if (mapped !== null) return mapped;
      const dictMapped = this.tryDictMethod(callee, node);
      if (dictMapped !== null) return dictMapped;
      const stringMapped = this.tryStringMethod(callee, node);
      if (stringMapped !== null) return stringMapped;
      // Known class-instance receiver: a direct attribute call. JS prototype
      // method lookup is approximated by Python attribute lookup (identical
      // resolution for the supported single-inheritance subset; a missing
      // method raises AttributeError where JS raises TypeError).
      const objectNode = kid(callee, "object")!;
      if (callee.fields["computed"] !== true && this.receiverKindOf(objectNode) === "instance") {
        const args = kids(node, "arguments").map((argument) =>
          argument.kind === "SpreadElement"
            ? `*${this.printExpression(kid(argument, "argument")!, 0)}`
            : this.printExpression(argument, 0),
        );
        const receiverText = this.printExpression(objectNode, 0);
        const methodName = String(scalar(kid(callee, "property"), "name") ?? "");
        const callText = `${receiverText}.${this.mangle(methodName)}(${args.join(", ")})`;
        this.semantic(
          node,
          "js.CallExpression(instance-method)",
          "js.instance-method→py.attribute-call",
          "method call on a known class-instance receiver resolves through Python attribute lookup; identical resolution for the supported class subset (a missing method raises AttributeError, not JS TypeError)",
          "obj.method(…)",
          callText,
        );
        return callText;
      }
    }
    const calleeText =
      callee.kind === "MemberExpression"
        ? this.printMember(callee)
        : this.printExpression(callee, 0);
    const args = kids(node, "arguments").map((argument) =>
      argument.kind === "SpreadElement"
        ? `*${this.printExpression(kid(argument, "argument")!, 0)}`
        : this.printExpression(argument, 0),
    );
    const prefix = isNew ? "" : "";
    if (isNew) {
      // `new X(args)` → `X(args)`.
      this.deterministic(
        node,
        "js.NewExpression",
        "js.new→py.constructor",
        "construction correspondence (Python has no new)",
        calleeText,
      );
      return `${calleeText}(${args.join(", ")})`;
    }
    void prefix;
    const directCalleeName =
      callee.kind === "Identifier" ? String(scalar(callee, "name") ?? "") : null;
    const unresolved =
      directCalleeName !== null &&
      directCalleeName !== "" &&
      !this.isValueNameDefined(directCalleeName);
    const dynamicMemberCall = callee.kind === "MemberExpression";
    this.record({
      span: node.span,
      sourceKind: "js.CallExpression",
      rule: unresolved || dynamicMemberCall ? "js.call→py.dynamic-call" : "js.call→py.call",
      decision: unresolved || dynamicMemberCall ? "semantic" : "deterministic",
      rationale: unresolved
        ? "callee has no value binding in the analyzed module; Python emits the same name, but external linkage and behavior are not proven"
        : dynamicMemberCall
          ? "member call receiver/method resolution is dynamic; Python emits the attribute call without proving JS behavior"
          : "call correspondence for a value binding in the analyzed module",
      adaptation: unresolved ? "unresolved call passed through" : null,
      warnings: unresolved ? ["CTW-CALL-UNRESOLVED"] : [],
      targetSummary: `${calleeText}(${args.join(", ")})`,
    });
    return `${calleeText}(${args.join(", ")})`;
  }

  private arrayMethodCallback(
    argument: PyNode,
    arity: number,
  ): { text: string; usesHelper: boolean } {
    if (argument.kind === "ArrowFunctionExpression" || argument.kind === "FunctionExpression") {
      const params = kids(argument, "params");
      if (params.length >= 1 && params.every((param) => param.kind === "Identifier")) {
        const names = params.map((param) => String(scalar(param, "name") ?? ""));
        // The helper invokes the callback at the full JS arity; JS tolerates
        // callbacks that declare fewer parameters, so surplus positions bind
        // through the translator-reserved rest name instead of raising.
        const rest = params.length < arity ? ", *_ctrans_extra" : "";
        return { text: `${names.join(", ")}${rest}`, usesHelper: false };
      }
    }
    return { text: this.printExpression(argument, 0), usesHelper: true };
  }

  private tryArrayMethod(member: PyNode, call: PyNode): string | null {
    const objectNode = kid(member, "object")!;
    const receiverKind = this.receiverKindOf(objectNode);
    if (receiverKind !== "array" && receiverKind !== "unknown") return null;
    const propertyName =
      member.fields["computed"] === true
        ? null
        : String(scalar(kid(member, "property"), "name") ?? "");
    const args = kids(call, "arguments");
    const receiverText = this.printExpression(objectNode, 0);
    switch (propertyName) {
      case "map": {
        this.recordMethodHelper(call, "array", "map", "js_map");
        const callback = this.arrayMethodCallback(args[0]!, 3);
        if (!callback.usesHelper) {
          const mapFn = this.useHelper("js_map");
          return `${mapFn}(${receiverText}, lambda ${callback.text}: ${this.printExpression(kid(args[0]!, "body")!, 0)})`;
        }
        return `${this.useHelper("js_map")}(${receiverText}, ${callback.text})`;
      }
      case "filter": {
        this.recordMethodHelper(call, "array", "filter", "js_filter");
        const callback = this.arrayMethodCallback(args[0]!, 3);
        const filterFn = this.useHelper("js_filter");
        if (!callback.usesHelper) {
          return `${filterFn}(${receiverText}, lambda ${callback.text}: ${this.printExpression(kid(args[0]!, "body")!, 0)})`;
        }
        return `${filterFn}(${receiverText}, ${callback.text})`;
      }
      case "reduce": {
        this.recordMethodHelper(call, "array", "reduce", "js_reduce");
        const reduceFn = this.useHelper("js_reduce");
        const hasInitial = args.length > 1;
        // The reduce callback receives (accumulator, item, index); a lambda
        // built here keeps every declared parameter and tolerates the rest.
        const callback = this.arrayMethodCallback(args[0]!, 4);
        const callbackText = callback.usesHelper
          ? callback.text
          : `lambda ${callback.text}: ${this.printExpression(kid(args[0]!, "body")!, 0)}`;
        return `${reduceFn}(${receiverText}, ${callbackText}, ${args.length > 1 ? this.printExpression(args[1]!, 0) : "None"}, ${hasInitial ? "True" : "False"})`;
      }
      case "find": {
        this.recordMethodHelper(call, "array", "find", "js_find");
        const callback = this.arrayMethodCallback(args[0]!, 3);
        const findFn = this.useHelper("js_find");
        if (!callback.usesHelper) {
          return `${findFn}(${receiverText}, lambda ${callback.text}: ${this.printExpression(kid(args[0]!, "body")!, 0)})`;
        }
        return `${findFn}(${receiverText}, ${callback.text})`;
      }
      case "forEach": {
        this.recordMethodHelper(call, "array", "forEach", "js_for_each");
        const callback = this.arrayMethodCallback(args[0]!, 3);
        const forEachFn = this.useHelper("js_for_each");
        if (!callback.usesHelper) {
          return `${forEachFn}(${receiverText}, lambda ${callback.text}: ${this.printExpression(kid(args[0]!, "body")!, 0)})`;
        }
        return `${forEachFn}(${receiverText}, ${callback.text})`;
      }
      case "includes":
        this.recordMethodHelper(call, "array", "includes", "js_includes");
        return `${this.useHelper("js_includes")}(${receiverText}, ${this.printExpression(args[0]!, 0)})`;
      case "indexOf":
        this.recordMethodHelper(call, "array", "indexOf", "js_index_of");
        return `${this.useHelper("js_index_of")}(${receiverText}, ${this.printExpression(args[0]!, 0)})`;
      case "join":
        this.recordMethodHelper(call, "array", "join", "js_join");
        return `${this.useHelper("js_join")}(${receiverText}, ${args.length > 0 ? this.printExpression(args[0]!, 0) : '","'})`;
      case "concat": {
        this.recordMethodHelper(call, "array", "concat", "js_concat");
        return `${this.useHelper("js_concat")}(${receiverText}${args.length > 0 ? `, ${args.map((argument) => this.printExpression(argument, 0)).join(", ")}` : ""})`;
      }
      case "sort": {
        this.recordMethodHelper(call, "array", "sort", "js_sort");
        return `${this.useHelper("js_sort")}(${receiverText}${args.length > 0 ? `, ${this.printExpression(args[0]!, 0)}` : ""})`;
      }
      case "reverse": {
        this.recordMethodHelper(call, "array", "reverse", "js_reverse");
        return `${this.useHelper("js_reverse")}(${receiverText})`;
      }
      case "push": {
        this.recordMethodHelper(call, "array", "push", "push_value");
        const values = args.map((argument) => this.printExpression(argument, 0));
        return `${this.useHelper("push_value")}(${receiverText}${values.length > 0 ? `, ${values.join(", ")}` : ""})`;
      }
      case "unshift": {
        this.recordMethodHelper(call, "array", "unshift", "unshift_value");
        const values = args.map((argument) => this.printExpression(argument, 0));
        return `${this.useHelper("unshift_value")}(${receiverText}${values.length > 0 ? `, ${values.join(", ")}` : ""})`;
      }
      case "pop":
        this.recordMethodHelper(call, "array", "pop", null);
        return `${receiverText}.pop()`;
      case "shift":
        this.semantic(
          call,
          "js.Array.shift",
          "js.shift→py.pop(0)",
          "shift is pop(0); the O(n) cost matches JS array semantics",
          ".pop(0)",
          `${receiverText}.pop(0)`,
        );
        return `${receiverText}.pop(0)`;
      case "slice": {
        const startNode = args[0];
        const endNode = args[1];
        const start = startNode === undefined ? "" : this.printExpression(startNode, 0);
        const end = endNode === undefined ? "" : this.printExpression(endNode, 0);
        this.deterministic(
          call,
          "js.Array.slice",
          "js.slice→py.slice",
          "slice correspondence (negative bounds match; JS has no step)",
          `${receiverText}[${start}:${end}]`,
        );
        return `${receiverText}[${start}:${end}]`;
      }
      default:
        return null;
    }
  }

  // One ledger entry per helper-emitted method mapping (AGENTS §3: no
  // construct is emitted without provenance). tryStringMethod records its own
  // entry; array/dict routes go through here.
  private recordMethodHelper(
    call: PyNode,
    surface: "array" | "dict",
    method: string,
    helperName: string | null,
  ): void {
    this.record({
      span: call.span,
      sourceKind: `js.${surface === "array" ? "Array" : "Object"}.${method}`,
      rule: `js.${surface}-method(${method})→py.${helperName ?? "native"}`,
      decision: "semantic",
      rationale:
        helperName === null
          ? "method correspondence on a provable receiver; JS-specific edge behavior is documented per method"
          : "JS method semantics (callback arity, edge cases) provided by the generated runtime helper; Python-native equivalents differ where JS defines different edge behavior",
      adaptation: helperName === null ? null : helperName,
      targetSummary: `.${method}(…)`,
    });
  }

  private tryDictMethod(member: PyNode, call: PyNode): string | null {
    const objectNode = kid(member, "object")!;
    const receiverKind = this.receiverKindOf(objectNode);
    if (receiverKind !== "dict") return null;
    const propertyName =
      member.fields["computed"] === true
        ? null
        : String(scalar(kid(member, "property"), "name") ?? "");
    const args = kids(call, "arguments");
    const receiverText = this.printExpression(objectNode, 0);
    switch (propertyName) {
      case "has":
        this.recordMethodHelper(call, "dict", "has", null);
        return `(${this.printExpression(args[0]!, 0)} in ${receiverText})`;
      case "get":
        this.recordMethodHelper(call, "dict", "get", "js_get");
        return `${this.useHelper("js_get")}(${receiverText}, ${this.printExpression(args[0]!, 0)})`;
      case "keys":
        this.recordMethodHelper(call, "dict", "keys", null);
        return `list(${receiverText}.keys())`;
      case "values":
        this.recordMethodHelper(call, "dict", "values", null);
        return `list(${receiverText}.values())`;
      case "entries":
        this.recordMethodHelper(call, "dict", "entries", "js_object_entries");
        return `${this.useHelper("js_object_entries")}(${receiverText})`;
      case "delete":
        this.recordMethodHelper(call, "dict", "delete", "js_delete");
        return `${this.useHelper("js_delete")}(${receiverText}, ${this.printExpression(args[0]!, 0)})`;
      default:
        return null;
    }
  }

  private tryStringMethod(member: PyNode, call: PyNode): string | null {
    const objectNode = kid(member, "object")!;
    const receiverKind = this.receiverKindOf(objectNode);
    // UNKNOWN receivers route through too: a .toUpperCase() call on an unknown
    // value is a STRING call in JS (a non-string receiver throws, and the Python
    // form throws the same class of error — documented). Dict/number receivers skip.
    if (receiverKind === "dict" || receiverKind === "number" || receiverKind === "array")
      return null;
    const propertyName =
      member.fields["computed"] === true
        ? null
        : String(scalar(kid(member, "property"), "name") ?? "");
    const mappedStringMethods = new Set([
      "toUpperCase",
      "toLowerCase",
      "trim",
      "trimStart",
      "trimEnd",
      "startsWith",
      "endsWith",
      "includes",
      "indexOf",
      "charAt",
      "charCodeAt",
      "padStart",
      "substring",
      "slice",
      "split",
      "repeat",
      "replace",
      "replaceAll",
    ]);
    if (propertyName === null || !mappedStringMethods.has(propertyName)) return null;
    const args = kids(call, "arguments");
    const receiverText = this.printExpression(objectNode, 0);
    this.semantic(
      call,
      "js.String.method",
      `js.string-method→py.${String(propertyName)}`,
      "string method correspondence over the mapped surface (JS-specific behaviors pinned per method)",
      String(propertyName),
      `${receiverText}.${String(propertyName)}`,
    );
    switch (propertyName) {
      case "toUpperCase":
        return `${receiverText}.upper()`;
      case "toLowerCase":
        return `${receiverText}.lower()`;
      case "trim":
        return `${receiverText}.strip()`;
      case "trimStart":
        return `${receiverText}.lstrip()`;
      case "trimEnd":
        return `${receiverText}.rstrip()`;
      case "split": {
        const separator = args[0];
        if (separator === undefined) {
          return `${this.useHelper("js_split")}(${receiverText}, None)`;
        }
        return `${this.useHelper("js_split")}(${receiverText}, ${this.printExpression(separator, 0)})`;
      }
      case "replace": {
        // JS string.replace replaces the FIRST occurrence (Python replaces all).
        this.semantic(
          call,
          "js.String.replace",
          "js.replace→py.replace-first",
          "JS replaces the first occurrence only; Python's count=1 preserves that",
          "replace(…, 1)",
          `${receiverText}.replace(…, 1)`,
        );
        return `${receiverText}.replace(${this.printExpression(args[0]!, 0)}, ${this.printExpression(args[1]!, 0)}, 1)`;
      }
      case "replaceAll":
        return `${receiverText}.replace(${this.printExpression(args[0]!, 0)}, ${this.printExpression(args[1]!, 0)})`;
      case "startsWith":
        return `${receiverText}.startswith(${this.printExpression(args[0]!, 0)})`;
      case "endsWith":
        return `${receiverText}.endswith(${this.printExpression(args[0]!, 0)})`;
      case "charAt":
        return `${receiverText}[${this.printExpression(args[0]!, 0)}:${this.printExpression(args[0]!, 0)} + 1]`;
      case "indexOf":
        return `${receiverText}.find(${this.printExpression(args[0]!, 0)})`;
      case "repeat":
        return `${this.useHelper("js_repeat")}(${receiverText}, ${this.printExpression(args[0]!, 0)})`;
      case "padStart":
        return `${this.useHelper("js_pad_start")}(${receiverText}, ${this.printExpression(args[0]!, 0)}${args.length > 1 ? `, ${this.printExpression(args[1]!, 0)}` : ""})`;
      case "charCodeAt":
        return `${this.useHelper("js_char_code_at")}(${receiverText}, ${this.printExpression(args[0]!, 0)})`;
      case "substring":
        return `${this.useHelper("js_substring")}(${receiverText}, ${this.printExpression(args[0]!, 0)}${args.length > 1 ? `, ${this.printExpression(args[1]!, 0)}` : ""})`;
      case "slice": {
        const start = args[0] === undefined ? "" : this.printExpression(args[0], 0);
        const end = args[1] === undefined ? "" : this.printExpression(args[1], 0);
        return `${receiverText}[${start}:${end}]`;
      }
      default:
        return null;
    }
  }

  private receiverKindOf(node: PyNode): ReceiverKind {
    if (node.kind === "Identifier") return this.kindOf(String(scalar(node, "name") ?? ""));
    return this.inferReceiverKind(node);
  }

  private printMember(node: PyNode, isCallTarget = false): string {
    const objectNode = kid(node, "object")!;
    const property = kid(node, "property")!;
    if (node.fields["optional"] === true) {
      return this.printOptionalMember(node);
    }
    const objectText = this.printExpression(objectNode, 0);
    // `.length` on arrays/strings → len(); on UNKNOWN receivers the helper is the
    // honest mapping (JS .length exists on arrays/strings; functions diverge —
    // documented), because `x.length` as a Python attribute would raise AttributeError.
    if (node.fields["computed"] !== true && String(scalar(property, "name") ?? "") === "length") {
      const kind = this.receiverKindOf(objectNode);
      if (kind === "array" || kind === "string" || kind === "unknown") {
        this.record({
          span: node.span,
          sourceKind: "js.MemberExpression(.length)",
          rule: "js.length→py.len",
          decision: "deterministic",
          rationale:
            "JS .length on arrays/strings maps to len() (functions carry a different .length semantics — documented)",
          adaptation: "len()",
          targetSummary: `len(${objectText})`,
        });
        return `len(${objectText})`;
      }
    }
    if (node.fields["computed"] === true) {
      const indexText = this.printExpression(property, 0);
      const kind = this.receiverKindOf(objectNode);
      if (kind === "array" || kind === "string" || kind === "dict") {
        return `${objectText}[${indexText}]`;
      }
      const get = this.useHelper("js_get");
      this.semantic(
        node,
        "js.MemberExpression(computed)",
        "js.member→py.js_get",
        "dynamic member access on an untyped receiver: JS yields undefined for a missing key, Python raises — the helper preserves the JS contract",
        "js_get",
        "o[key]",
      );
      return `${get}(${objectText}, ${indexText})`;
    }
    let name = String(scalar(property, "name") ?? "");
    if (property.kind === "PrivateIdentifier") name = `_${name}`;
    // Instance state reads are attribute reads (self.x).
    if (objectNode.kind === "ThisExpression") {
      return `self.${this.mangle(name)}`;
    }
    if (this.receiverKindOf(objectNode) === "dict") {
      // Property access on a provable dict: missing keys read undefined→None via
      // the helper (JS semantics); Python's direct [] would raise KeyError.
      const get = this.useHelper("js_get");
      this.semantic(
        node,
        "js.MemberExpression",
        "js.member→py.js_get",
        "property access on a JS object maps to the undefined-for-missing helper (Python [] would raise KeyError)",
        "js_get",
        `o.${name}`,
      );
      return `${get}(${objectText}, ${JSON.stringify(name)})`;
    }
    if (this.receiverKindOf(objectNode) === "instance") {
      this.semantic(
        node,
        "js.MemberExpression(instance)",
        "js.instance-field→py.attribute",
        "attribute read on a known class-instance receiver (a missing field raises AttributeError where JS yields undefined)",
        "obj.field",
        `o.${name}`,
      );
      return `${objectText}.${this.mangle(name)}`;
    }
    if (!isCallTarget && this.receiverKindOf(objectNode) === "unknown") {
      // Property READ on an untyped receiver: undefined-for-missing semantics via
      // the helper. Call targets keep the attribute form (helpers are callable).
      const get = this.useHelper("js_get");
      this.semantic(
        node,
        "js.MemberExpression",
        "js.member→py.js_get",
        "property read on an untyped receiver maps to the undefined-for-missing helper (JS contract)",
        "js_get",
        `o.${name}`,
      );
      return `${get}(${objectText}, ${JSON.stringify(name)})`;
    }
    return `${objectText}.${this.mangle(name)}`;
  }

  private printOptionalMember(node: PyNode): string {
    const objectNode = kid(node, "object")!;
    const property = kid(node, "property")!;
    const opt = this.useHelper("opt_attr");
    this.semantic(
      node,
      "js.MemberExpression(optional)",
      "js.?.→py.opt_attr",
      "optional chaining maps to the nullish-guard helper (None stands in for null/undefined — tri-state collapse)",
      "opt_attr",
      "?.",
    );
    if (node.fields["computed"] === true) {
      return `${opt}(${this.printExpression(objectNode, 0)}, ${this.printExpression(property, 0)})`;
    }
    return `${opt}(${this.printExpression(objectNode, 0)}, ${JSON.stringify(String(scalar(property, "name") ?? ""))})`;
  }

  private propertyKeyText(node: PyNode, computed: boolean): string {
    if (computed) {
      if (node.kind === "Literal" && typeof node.fields["value"] === "string") {
        return String(node.fields["value"]);
      }
      return this.unsupported(
        node,
        "computed member key",
        "computed member names have no Python equivalent at class-definition time",
      ).replace("#", "# ");
    }
    if (node.kind === "PrivateIdentifier") {
      // §2.5: #field → _name convention.
      const name = `_${String(scalar(node, "name") ?? "")}`;
      this.semantic(
        node,
        "js.PrivateIdentifier",
        "js.#field→py._name",
        "JS private fields map to the underscore convention (Python name-mangling not reproduced)",
        "_name",
        name,
      );
      return name;
    }
    if (node.kind === "Identifier") return String(scalar(node, "name") ?? "");
    return String(scalar(node, "value") ?? "");
  }

  // ---- plumbing -----------------------------------------------------------------
  private line(text: string): void {
    this.lines.push(`${"    ".repeat(this.indent)}${text}`);
  }
}
