// Rule-based lowering for the Python → JS/TS M4 subset (docs/language-support.md §2).
// Every rule application records a ledger entry (AGENTS.md §3 — provenance is not
// optional). Semantics-critical divergences use __ctrans_runtime helpers: Python
// truthiness, floor division/modulo/true division (ZeroDivisionError), sequence ==
// and `in`, negative indexing, arbitrary slices, string repetition, and the Python
// exception hierarchy. Unsupported constructs are never silently translated: they
// emit a marker comment plus an `unsupported` ledger entry and count as failures in
// the report (the claim ladder caps accordingly).
import {
  UNKNOWN,
  NO_REGISTRY,
  type AnnotatedType,
  type CommonType,
  type RegistryLookup,
} from "@ctrans/core";
import type { AstNode } from "@ctrans/core";

import {
  CTW_CLASS_ATTR_STATIC,
  CTW_DEFAULT_EVAL,
  CTW_DICT_KEY_COERCION,
  CTW_GENERATOR_EAGER,
  CTW_KWARGS,
  CTW_METHOD_ADAPTED,
  CTW_METHOD_UNMAPPED,
  CTW_MUTABLE_DEFAULT,
  CTW_NUM_BIGINT_BOUNDARY,
  CTW_NUM_BITWISE,
  CTW_NUM_PRECISION,
  CTW_TUPLE_ARRAY,
  CTW_WITH_EXIT_ARGS,
  LoweringContext,
  ScopeStack,
} from "./context.js";

interface Span {
  readonly line: number | null;
  readonly column: number | null;
}

const pySpan = (node: AstNode | null): Span => ({
  line: node?.span?.start.line ?? null,
  column: node?.span?.start.column ?? null,
});

function kid(node: AstNode, name: string): AstNode | null {
  const value = node.fields[name];
  return typeof value === "object" && value !== null && !Array.isArray(value) && "kind" in value
    ? (value as AstNode)
    : null;
}

function kids(node: AstNode, name: string): AstNode[] {
  const value = node.fields[name];
  return Array.isArray(value) ? (value as AstNode[]) : [];
}

// List fields whose entries may be null (kw_defaults uses null = "no default").
function nullableKids(node: AstNode, name: string): (AstNode | null)[] {
  const value = node.fields[name];
  return Array.isArray(value) ? (value as (AstNode | null)[]) : [];
}

function scalar(node: AstNode, name: string): string | number | boolean | null {
  const value = node.fields[name];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

function taggedDecimal(value: unknown): string | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const tagged = value as { tag?: string; decimal?: unknown };
    if (tagged.tag === "int" && typeof tagged.decimal === "string") return tagged.decimal;
  }
  return null;
}

function escapeTemplate(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}

function escapeDoubleQuoted(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t");
}

function singleLine(text: string): string {
  return text.replaceAll("\n", " ");
}

// Destructuring pattern text for a tuple/list assignment target. Member/index
// sub-targets are only legal in assignment (never let-declaration) position.
function destructurePattern(node: AstNode, emitter: Emitter): string {
  return `[${kids(node, "elts")
    .map((element) => {
      if (element.kind === "Name") return String(scalar(element, "id") ?? "");
      if (element.kind === "Tuple" || element.kind === "List") {
        return destructurePattern(element, emitter);
      }
      return emitter.lowerExpr(element);
    })
    .join(", ")}]`;
}

// Recursively collects the plain Name leaves of a tuple/list target.
function collectLeafNames(target: AstNode): string[] {
  if (target.kind === "Name") return [String(scalar(target, "id") ?? "")];
  if (target.kind === "Tuple" || target.kind === "List") {
    return kids(target, "elts").flatMap((element) => collectLeafNames(element));
  }
  return [];
}

// A pattern made only of Names (possibly nested tuples) — the only shape that can
// appear in a JS let-declaration.
function isNamePattern(target: AstNode): boolean {
  if (target.kind === "Name") return true;
  if (target.kind === "Tuple" || target.kind === "List") {
    return kids(target, "elts").every((element) => isNamePattern(element));
  }
  return false;
}

// Deterministic CTW-UNSUPPORTED-* code per construct category (language-support §4
// requires a warning code per unsupported classification).
function unsupportedWarningCode(sourceKind: string): string {
  const stem = sourceKind
    .replace(/^py\./, "")
    .replace(
      /^(Call|Compare|BinOp|UnaryOp|Assign|AugAssign|While|For|Try|AsyncFor|AsyncWith|With|ExceptHandler|MethodDef|ClassDef)\((.*)\)$/,
      (_match, head: string, tail: string) => `${head}-${tail}`,
    )
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `CTW-UNSUPPORTED-${stem.toUpperCase()}`;
}

// Python builtin callables with no M4 mapping. A call to one of these names cannot
// be emitted as a bare identifier (it cannot resolve in the target), so it is
// classified unsupported with a marker and warning — never silently verbatim
// (docs/language-support.md §4, AGENTS.md §3). Mapped builtins (len, range, int,
// float, sum, str, isinstance, print, super) are consumed by lowerBuiltinCall before
// this set is consulted.
const UNMAPPED_PYTHON_BUILTINS: ReadonlySet<string> = new Set([
  "abs",
  "aiter",
  "all",
  "anext",
  "any",
  "ascii",
  "bin",
  "bool",
  "breakpoint",
  "bytearray",
  "bytes",
  "callable",
  "chr",
  "classmethod",
  "compile",
  "complex",
  "delattr",
  "dict",
  "dir",
  "divmod",
  "enumerate",
  "eval",
  "exec",
  "filter",
  "format",
  "frozenset",
  "getattr",
  "globals",
  "hasattr",
  "hash",
  "help",
  "hex",
  "id",
  "input",
  "issubclass",
  "iter",
  "list",
  "locals",
  "map",
  "max",
  "memoryview",
  "min",
  "next",
  "object",
  "oct",
  "open",
  "ord",
  "pow",
  "property",
  "repr",
  "reversed",
  "round",
  "set",
  "setattr",
  "slice",
  "sorted",
  "staticmethod",
  "tuple",
  "type",
  "vars",
  "zip",
  "__import__",
]);

export class Emitter {
  private readonly lines: string[] = [];
  private indent = 0;
  private readonly declaredPerScope: Array<Set<string>> = [new Set()];
  // Python binds names at function/module scope. scopeAssignedNames pre-scans each
  // scope's body for assignment targets; when the FIRST binding of such a name
  // happens inside a nested control-flow block, the declaration is hoisted to the
  // scope top (hoistedLines, spliced in at flushHoists) and the assignment is
  // emitted plain — a block-scoped `let` would hide the name from later statements.
  private readonly scopeAssignedNames: Array<Set<string>> = [new Set()];
  private readonly hoistedLines: string[][] = [[]];
  private readonly scopeBaseIndent: number[] = [0];
  // Unit-level def/class names: a Python builtin shadowed by a unit definition is a
  // genuine forward reference, not an unmapped builtin.
  private readonly unitDefinedNames = new Set<string>();
  private readonly selfNames: string[] = [];
  private selfFieldTypes: Map<string, AnnotatedType> = new Map();
  private readonly classFieldTypes = new Map<string, Map<string, AnnotatedType>>();
  private exceptBinding: string | null = null;
  private tempCounter = 0;
  private readonly ctx: LoweringContext;
  private readonly scopes: ScopeStack;
  private readonly exportedNames: ReadonlySet<string>;

  private readonly importedKinds: ReadonlyMap<string, "class" | "function">;

  // WS F: functions of this unit that must be emitted async (sync-to-async
  // boundary propagation, docs/dependency-mapping.md §6). Absent = none.
  private readonly asyncFunctions: ReadonlySet<string>;
  // WS F: variables assigned directly from `requests.<verb>(...)` calls — the
  // documented response surface (text/json/status_code/raise_for_status/ok) maps
  // on these receivers (fetch Response).
  private readonly fetchAssigned = new Set<string>();
  // WS F: local names bound to async functions of OTHER units (from-imports) —
  // call sites await them.
  private readonly importedAsync = new Set<string>();

  // D-017: the registry lookup is injected (core interface); default = no registry.
  private readonly registry: RegistryLookup;

  constructor(
    ctx: LoweringContext,
    scopes: ScopeStack,
    exportedNames: ReadonlySet<string>,
    importedKinds: ReadonlyMap<string, "class" | "function"> = new Map(),
    asyncFunctions: ReadonlySet<string> = new Set(),
    importedAsyncNames: ReadonlySet<string> = new Set(),
    registry: RegistryLookup = NO_REGISTRY,
  ) {
    for (const name of importedAsyncNames) this.importedAsync.add(name);
    // Explicit field assignment (not parameter properties): the unbuilt CLI runs
    // sources through Node strip-only mode, which rejects transform-only syntax.
    this.ctx = ctx;
    this.scopes = scopes;
    this.exportedNames = exportedNames;
    this.importedKinds = importedKinds;
    this.asyncFunctions = asyncFunctions;
    this.registry = registry;
  }

  lowerModuleBody(statements: readonly AstNode[]): void {
    this.collectAssignedNames(statements, this.scopeAssignedNames[0]!);
    this.collectDefinedNames(statements);
    for (const statement of statements) this.lowerStmt(statement);
    this.flushHoists(0);
  }

  // Render ONE statement to text (test-mapper reuse): the full statement-lowering
  // machinery runs (assign/let-hoist/if-truthy/aug-assign helpers/ledger), and the
  // produced lines are captured and removed from the module buffer. Nested
  // statements carry their relative indentation.
  renderStatement(node: AstNode): string {
    const start = this.lines.length;
    this.lowerStmt(node);
    const text = this.lines.slice(start).join("\n");
    this.lines.length = start;
    return text;
  }

  // Pre-declare a binding the surrounding template owns (test-mapper fixture
  // params): body Assigns then emit plain rebinding assignments, matching Python's
  // rebindable names without a colliding second declaration.
  preDeclareBinding(name: string): void {
    this.scopes.declare(name, annotateUnknown());
    this.declareLocally(name);
  }

  // Test-mapper scope brackets: params pre-declared in a fresh function scope.
  pushScopeForTest(params: readonly string[]): void {
    this.scopes.push();
    this.declaredPerScope.push(new Set());
    for (const param of params) {
      if (param === "") continue;
      this.scopes.declare(param, annotateUnknown());
      this.declareLocally(param);
    }
  }

  popScopeForTest(): void {
    this.scopes.pop();
    this.declaredPerScope.pop();
  }

  // Public hook for the pytest mapper (which renders import statements itself):
  // registers the bound names' scope kinds so class construction lowers to `new`.
  noteImportBindings(node: AstNode): void {
    this.declareImportBindings(node);
  }

  render(): string {
    return this.lines.join("\n");
  }

  private line(text: string): void {
    this.lines.push(text.length > 0 ? `${"  ".repeat(this.indent)}${text}` : "");
  }

  private isDeclared(name: string): boolean {
    return this.declaredPerScope.some((frame) => frame.has(name));
  }

  private declareLocally(name: string): boolean {
    const frame = this.declaredPerScope[this.declaredPerScope.length - 1]!;
    if (frame.has(name)) return false;
    frame.add(name);
    return true;
  }

  // ---- Python-scope binding pre-scan and hoisting ---------------------------------

  // Names assigned anywhere in this Python scope's body, walking through
  // control-flow blocks. Nested defs/classes/lambdas own their scopes and are not
  // entered (their bindings never leak into this scope).
  private collectAssignedNames(statements: readonly AstNode[], into: Set<string>): void {
    for (const statement of statements) {
      switch (statement.kind) {
        case "Assign":
          for (const target of kids(statement, "targets")) {
            this.collectTargetNames(target, into);
          }
          break;
        case "AnnAssign":
        case "AugAssign": {
          const target = kid(statement, "target");
          if (target !== null) this.collectTargetNames(target, into);
          break;
        }
        case "For":
        case "AsyncFor": {
          const target = kid(statement, "target");
          if (target !== null) this.collectTargetNames(target, into);
          this.collectAssignedNames(kids(statement, "body"), into);
          this.collectAssignedNames(kids(statement, "orelse"), into);
          break;
        }
        case "While":
        case "If":
          this.collectAssignedNames(kids(statement, "body"), into);
          this.collectAssignedNames(kids(statement, "orelse"), into);
          break;
        case "Try":
          this.collectAssignedNames(kids(statement, "body"), into);
          for (const handler of kids(statement, "handlers")) {
            this.collectAssignedNames(kids(handler, "body"), into);
          }
          this.collectAssignedNames(kids(statement, "orelse"), into);
          this.collectAssignedNames(kids(statement, "finalbody"), into);
          break;
        case "With": {
          for (const item of kids(statement, "items")) {
            const vars = kid(item, "optional_vars");
            if (vars !== null) this.collectTargetNames(vars, into);
          }
          this.collectAssignedNames(kids(statement, "body"), into);
          break;
        }
        // FunctionDef/ClassDef/Lambda/comprehensions own their scopes.
      }
    }
  }

  // Name leaves of an assignment target; Attribute/Subscript targets write members,
  // they do not bind scope names.
  private collectTargetNames(target: AstNode, into: Set<string>): void {
    if (target.kind === "Name") {
      into.add(String(scalar(target, "id") ?? ""));
      return;
    }
    if (target.kind === "Tuple" || target.kind === "List") {
      for (const element of kids(target, "elts")) this.collectTargetNames(element, into);
    }
  }

  // Top-level def/class names of the unit: a builtin name shadowed by one of these
  // is a genuine forward reference, not an unmapped builtin call.
  private collectDefinedNames(statements: readonly AstNode[]): void {
    for (const statement of statements) {
      if (
        statement.kind === "FunctionDef" ||
        statement.kind === "AsyncFunctionDef" ||
        statement.kind === "ClassDef"
      ) {
        const name = String(scalar(statement, "name") ?? "");
        if (name !== "") this.unitDefinedNames.add(name);
        continue;
      }
      // Conditional definitions (if/try-wrapped defs) still define the name for the
      // unit's later call sites.
      if (statement.kind === "If") {
        this.collectDefinedNames(kids(statement, "body"));
        this.collectDefinedNames(kids(statement, "orelse"));
      }
      if (statement.kind === "Try") {
        this.collectDefinedNames(kids(statement, "body"));
        this.collectDefinedNames(kids(statement, "orelse"));
      }
    }
  }

  // Python binds at function/module scope: a first assignment to a pre-scanned name
  // inside a nested control-flow block must hoist its declaration to the scope top.
  private bindingRequiresHoist(name: string): boolean {
    return (
      this.indent > this.scopeBaseIndent[this.scopeBaseIndent.length - 1]! &&
      this.scopeAssignedNames[this.scopeAssignedNames.length - 1]!.has(name)
    );
  }

  private hoistBinding(name: string, tsType: string | null): void {
    const frame = this.hoistedLines[this.hoistedLines.length - 1]!;
    if (frame.some((text) => text.endsWith(` ${name};`))) {
      this.declareLocally(name);
      return;
    }
    const exportPrefix =
      this.exportedNames.has(name) && this.scopeBaseIndent.length === 1 ? "export " : "";
    const typeSuffix = this.ctx.target === "typescript" ? `: ${tsType ?? "unknown"}` : "";
    const baseIndent = this.scopeBaseIndent[this.scopeBaseIndent.length - 1]!;
    frame.push(`${"  ".repeat(baseIndent)}${exportPrefix}let ${name}${typeSuffix};`);
    this.declareLocally(name);
  }

  private flushHoists(insertIndex: number): void {
    const hoists = this.hoistedLines.pop()!;
    this.scopeAssignedNames.pop();
    this.scopeBaseIndent.pop();
    if (hoists.length > 0) this.lines.splice(insertIndex, 0, ...hoists);
  }

  private unsupportedExpr(node: AstNode, sourceKind: string, why: string): string {
    const code = unsupportedWarningCode(sourceKind);
    this.ctx.record({
      span: pySpan(node),
      sourceKind,
      rule: `${sourceKind}→unsupported`,
      decision: "unsupported",
      rationale: why,
      warnings: [code],
      targetSummary: null,
    });
    return `/* ctrans: unsupported ${sourceKind}: ${singleLine(why)} */ undefined`;
  }

  private unsupportedStmt(node: AstNode, sourceKind: string, why: string): void {
    const code = unsupportedWarningCode(sourceKind);
    this.ctx.record({
      span: pySpan(node),
      sourceKind,
      rule: `${sourceKind}→unsupported`,
      decision: "unsupported",
      rationale: why,
      warnings: [code],
      targetSummary: null,
    });
    this.line(`/* ctrans: unsupported ${sourceKind}: ${singleLine(why)} */`);
  }

  private helperCall(name: string, args: readonly string[]): string {
    this.ctx.useHelper(name);
    return `__ctrans_${name}(${args.join(", ")})`;
  }

  // ---- expressions ----------------------------------------------------------------

  lowerExpr(node: AstNode): string {
    switch (node.kind) {
      case "Constant":
        return this.lowerConstant(node);
      case "Name": {
        const name = String(scalar(node, "id") ?? "");
        if (this.selfNames.includes(name)) return "this";
        return name;
      }
      case "Attribute":
        return this.lowerAttribute(node);
      case "BinOp":
        return this.lowerBinOp(node);
      case "UnaryOp":
        return this.lowerUnaryOp(node);
      case "BoolOp":
        return this.lowerBoolOp(node);
      case "Compare":
        return this.lowerCompare(node);
      case "IfExp": {
        const test = this.lowerExpr(kid(node, "test")!);
        const body = this.lowerExpr(kid(node, "body")!);
        const orelse = this.lowerExpr(kid(node, "orelse")!);
        this.ctx.useHelper("truthy");
        this.ctx.record({
          span: pySpan(node),
          sourceKind: "py.IfExp",
          rule: "py.conditional→js.ternary+truthy",
          decision: "semantic",
          rationale: "Python test truthiness differs from JS coercion; helper applies Python rules",
          adaptation: "test wrapped in __ctrans_truthy",
          targetSummary: `truthy(${test}) ? ${body} : ${orelse}`,
        });
        // The ledger claims the truthy wrapper — the emitted code must match it
        // (audit regression: the wrapper was dropped, letting JS coercion diverge
        // from Python for [] / {} / NaN tests).
        return `(__ctrans_truthy(${test}) ? ${body} : ${orelse})`;
      }
      case "Call":
        return this.lowerCall(node);
      case "List": {
        this.ctx.record({
          span: pySpan(node),
          sourceKind: "py.List",
          rule: "py.list→js.array",
          decision: "deterministic",
          rationale: "array literal preserves order, indexing and mutation",
          targetSummary: "array literal",
        });
        return `[${kids(node, "elts")
          .map((element) => this.lowerExpr(element))
          .join(", ")}]`;
      }
      case "Tuple": {
        this.ctx.record({
          span: pySpan(node),
          sourceKind: "py.Tuple",
          rule: "py.tuple→js.array",
          decision: "semantic",
          rationale: "JS has no tuple type; immutability is not preserved (documented tradeoff)",
          adaptation: "tuple emitted as array",
          warnings: [CTW_TUPLE_ARRAY],
          targetSummary: "array literal",
        });
        return `[${kids(node, "elts")
          .map((element) => this.lowerExpr(element))
          .join(", ")}]`;
      }
      case "Set": {
        this.ctx.record({
          span: pySpan(node),
          sourceKind: "py.Set",
          rule: "py.set→js.Set",
          decision: "deterministic",
          rationale: "Set preserves membership, iteration and insertion behavior",
          targetSummary: "new Set(...)",
        });
        return `new Set([${kids(node, "elts")
          .map((element) => this.lowerExpr(element))
          .join(", ")}])`;
      }
      case "Dict":
        return this.lowerDict(node);
      case "JoinedStr":
        return this.lowerJoinedStr(node);
      case "Subscript":
        return this.lowerSubscript(node);
      case "ListComp":
      case "SetComp":
      case "GeneratorExp":
        return this.lowerSequenceComp(node);
      case "DictComp":
        return this.lowerDictComp(node);
      case "Lambda": {
        const params = this.lowerLambdaParams(kid(node, "args")!);
        const body = kid(node, "body");
        const bodyText = body === null ? "undefined" : this.lowerExpr(body);
        this.ctx.record({
          span: pySpan(node),
          sourceKind: "py.Lambda",
          rule: "py.lambda→js.arrow",
          decision: "deterministic",
          rationale: "single-expression arrow matches lambda semantics",
          targetSummary: "arrow function",
        });
        return `(${params}) => ${bodyText}`;
      }
      case "Await": {
        this.ctx.record({
          span: pySpan(node),
          sourceKind: "py.Await",
          rule: "py.await→js.await",
          decision: "deterministic",
          rationale: "await syntax and promise/coroutine sequencing correspond",
          targetSummary: "await expression",
        });
        return `await ${this.lowerExpr(kid(node, "value")!)}`;
      }
      case "Yield": {
        const value = kid(node, "value");
        this.ctx.record({
          span: pySpan(node),
          sourceKind: "py.Yield",
          rule: "py.yield→js.yield",
          decision: "deterministic",
          rationale: "generator suspension corresponds (send/throw protocols unsupported)",
          targetSummary: "yield expression",
        });
        return value === null ? "yield" : `yield ${this.lowerExpr(value)}`;
      }
      case "YieldFrom": {
        const value = this.lowerExpr(kid(node, "value")!);
        this.ctx.record({
          span: pySpan(node),
          sourceKind: "py.YieldFrom",
          rule: "py.yieldfrom→js.yield*",
          decision: "deterministic",
          rationale: "delegating generator suspension corresponds to yield*",
          targetSummary: "yield* expression",
        });
        return `yield* ${value}`;
      }
      case "Starred":
        return `...${this.lowerExpr(kid(node, "value") ?? node)}`;
      case "Slice":
        return this.unsupportedExpr(node, "py.Slice", "bare slice expression");
      default:
        return this.unsupportedExpr(
          node,
          `py.${node.kind}`,
          "construct is outside the supported M4 subset",
        );
    }
  }

  private lowerConstant(node: AstNode): string {
    const value = node.fields["value"];
    if (value === null) {
      this.ctx.record({
        span: pySpan(node),
        sourceKind: "py.Constant(None)",
        rule: "py.None→js.undefined",
        decision: "semantic",
        rationale: "None/null/undefined tri-state collapses to undefined (nullMode=undefined)",
        adaptation: "None emitted as undefined",
        targetSummary: "undefined",
      });
      return "undefined";
    }
    if (typeof value === "boolean") {
      this.ctx.record({
        span: pySpan(node),
        sourceKind: "py.Constant(bool)",
        rule: "py.bool→js.boolean",
        decision: "deterministic",
        rationale: "boolean literal correspondence",
        targetSummary: String(value),
      });
      return value ? "true" : "false";
    }
    if (typeof value === "number") {
      if (this.ctx.intMode === "bigint" && Number.isInteger(value)) {
        // D-006 exact mode: Python ints are JS bigint literals.
        this.ctx.record({
          span: pySpan(node),
          sourceKind: "py.Constant(int)",
          rule: "py.int→js.bigint",
          decision: "deterministic",
          rationale: "intMode=bigint: integer literal emitted exactly as a bigint literal",
          targetSummary: `${String(value)}n`,
        });
        return `${String(value)}n`;
      }
      const risky = Number.isInteger(value) && !Number.isSafeInteger(value);
      this.ctx.record({
        span: pySpan(node),
        sourceKind: "py.Constant(number)",
        rule: "py.number→js.number",
        decision: risky ? "semantic" : "deterministic",
        rationale: risky
          ? "integer literal exceeds 2^53 - precision would be lost (D-006: intMode=bigint is the exact mode)"
          : "numeric literal correspondence (D-006 number mode)",
        adaptation: risky ? "emitted as number with precision warning" : null,
        warnings: risky ? [CTW_NUM_PRECISION] : [],
        targetSummary: String(value),
      });
      return String(value);
    }
    if (typeof value === "string") {
      this.ctx.record({
        span: pySpan(node),
        sourceKind: "py.Constant(str)",
        rule: "py.str→js.string",
        decision: "deterministic",
        rationale: "string literal correspondence",
        targetSummary: "string literal",
      });
      return `"${escapeDoubleQuoted(value)}"`;
    }
    const decimal = taggedDecimal(value);
    if (decimal !== null) {
      if (this.ctx.intMode === "bigint") {
        // D-006 exact mode: arbitrarily large integers stay exact.
        this.ctx.record({
          span: pySpan(node),
          sourceKind: "py.Constant(int)",
          rule: "py.int→js.bigint",
          decision: "deterministic",
          rationale:
            "intMode=bigint: integer literal beyond 2^53 emitted exactly as a bigint literal",
          targetSummary: `${decimal}n`,
        });
        return `${decimal}n`;
      }
      this.ctx.record({
        span: pySpan(node),
        sourceKind: "py.Constant(int)",
        rule: "py.int→js.number",
        decision: "semantic",
        rationale: "integer literal exceeds 2^53 - precision would be lost (D-006)",
        adaptation: "emitted as number with precision warning",
        warnings: [CTW_NUM_PRECISION],
        targetSummary: decimal,
      });
      return decimal;
    }
    if (typeof value === "object" && "tag" in (value as Record<string, unknown>)) {
      const tag = (value as { tag: string }).tag;
      if (tag === "bytes")
        return this.unsupportedExpr(
          node,
          "py.Constant(bytes)",
          "bytes literals are outside the M4 subset",
        );
      if (tag === "complex")
        return this.unsupportedExpr(
          node,
          "py.Constant(complex)",
          "complex literals are outside the M4 subset",
        );
      if (tag === "ellipsis")
        return this.unsupportedExpr(node, "py.Ellipsis", "Ellipsis is outside the M4 subset");
    }
    return this.unsupportedExpr(node, "py.Constant", "unsupported literal kind");
  }

  private lowerAttribute(node: AstNode): string {
    const receiverNode = kid(node, "value")!;
    // CPython's Attribute.attr is a plain identifier STRING, not an AST node.
    const attributeName = String(scalar(node, "attr") ?? "");
    // WS F: the requests->fetch response surface on fetch-assigned receivers.
    if (
      receiverNode.kind === "Name" &&
      this.fetchAssigned.has(String(scalar(receiverNode, "id") ?? ""))
    ) {
      const surface: Record<string, string> = {
        text: "await ${r}.text()",
        json: "await ${r}.json()",
        status_code: "${r}.status",
        ok: "${r}.ok",
      };
      const shape = surface[attributeName];
      if (shape !== undefined) {
        const receiver = String(scalar(receiverNode, "id") ?? "");
        const expanded = shape.replaceAll("${r}", receiver);
        this.ctx.record({
          span: pySpan(node),
          sourceKind: `py.Attribute(response.${attributeName})`,
          rule: `py.requests-response→js.${attributeName}`,
          decision: "semantic",
          rationale:
            "sync-to-async boundary response surface (registry v1): Python properties/methods map to the fetch Response API — text/json are async methods in JS",
          adaptation: expanded,
          targetSummary: expanded,
        });
        return expanded;
      }
      if (attributeName === "raise_for_status") {
        const receiver = String(scalar(receiverNode, "id") ?? "");
        // raise_for_status is a METHOD in Python; attribute lowering returns a
        // bound marker — the call lowering produces the throw. Approximate here.
        this.ctx.record({
          span: pySpan(node),
          sourceKind: "py.Attribute(response.raise_for_status)",
          rule: "py.requests-response→js.raise-for-status",
          decision: "semantic",
          rationale: "raise_for_status maps to an HTTP-status guard over the fetch Response",
          adaptation: "status guard",
          targetSummary: "raise_for_status guard",
        });
        return `__ctrans_raiseForStatus(${receiver})`;
      }
    }
    const receiverText = this.lowerExpr(receiverNode);
    const span = pySpan(node);
    if (this.memberAccessNative(receiverNode)) {
      this.ctx.record({
        span,
        sourceKind: "py.Attribute",
        rule: "py.attribute→js.member",
        decision: "deterministic",
        rationale:
          "member access correspondence (library method renames arrive with the registry, M5)",
        targetSummary: `${receiverText}.${attributeName}`,
      });
      return `${receiverText}.${attributeName}`;
    }
    // Dynamically typed receiver: TS forbids property access on `unknown`, and Python
    // raises AttributeError for missing names — the helper reproduces both.
    this.ctx.record({
      span,
      sourceKind: "py.Attribute",
      rule: "py.attribute→__ctrans.getattr",
      decision: "semantic",
      rationale:
        "receiver type is statically unknown; property access on unknown is not expressible in TS and Python raises AttributeError for missing names",
      adaptation: "__ctrans_getattr",
      targetSummary: `getattr(${receiverText}, "${attributeName}")`,
    });
    return this.helperCall("getattr", [receiverText, JSON.stringify(attributeName)]);
  }

  // True when member/index/slice access on this receiver node is statically sound in
  // the target (imports resolve to real module types, self is the class instance,
  // locals carry container/value types; declared-unknown values do NOT qualify).
  private memberAccessNative(receiverNode: AstNode | null): boolean {
    if (receiverNode === null) return false;
    if (receiverNode.kind === "Name") {
      const name = String(scalar(receiverNode, "id") ?? "");
      if (this.selfNames.includes(name)) return true; // this.<member> on the class type
      const hit = this.scopes.lookup(name);
      if (hit === null) return true; // unresolved identifiers stay verbatim (policy)
      return hit.type.kind !== "unknown" && hit.type.kind !== "any";
    }
    if (receiverNode.kind === "Attribute") {
      return this.memberAccessNative(kid(receiverNode, "value"));
    }
    if (receiverNode.kind === "Call") {
      // `compute().field` — call results carry no tracked type.
      return false;
    }
    return false;
  }

  // Operand kind from the AST node, plus the emitted text: target-helper calls have
  // statically typed results even when the Python expression tree does not.
  private operandKind(node: AstNode, emittedText: string): "number" | "string" | "array" | null {
    const nodeKind = this.inferOperandKind(node);
    if (nodeKind !== null) return nodeKind;
    // D-006 bigint mode: widened numeric helpers may return bigint, so their
    // results are dynamic for native-op decisions (emissions chain through helpers
    // instead of applying native operators to a `number | bigint` value).
    const widenedText =
      this.ctx.intMode === "bigint" &&
      /^__ctrans_(sub|floorDiv|mod|pow|sum|neg|pos|bitAnd|bitOr|bitXor|lShift|rShift)\(/.test(
        emittedText,
      );
    if (
      !widenedText &&
      /^__ctrans_(sub|div|floorDiv|mod|pow|len|sum|toInt|toFloat|neg|pos|bitAnd|bitOr|bitXor|lShift|rShift|listIndex)\(/.test(
        emittedText,
      )
    ) {
      return "number";
    }
    if (/^__ctrans_(str|strJoin)\(/.test(emittedText)) return "string";
    return null;
  }

  private lowerBinOp(node: AstNode): string {
    const leftNode = kid(node, "left")!;
    const rightNode = kid(node, "right")!;
    const operator = kid(node, "op")!.kind;
    const left = this.lowerExpr(leftNode);
    const right = this.lowerExpr(rightNode);
    const span = pySpan(node);
    const leftKind = this.operandKind(leftNode, left);
    const rightKind = this.operandKind(rightNode, right);
    const bothNumbers = leftKind === "number" && rightKind === "number";
    const bothStrings = leftKind === "string" && rightKind === "string";
    const bothArrays = leftKind === "array" && rightKind === "array";
    const dynamic = !bothNumbers && !bothStrings;
    // D-006 bigint mode: statically-provable int operands keep exact native bigint
    // operators; a provable int mixed with a provable float converts across the
    // documented Number boundary; unknown operands go through the bigint-aware
    // helpers exactly as in number mode.
    const bigintMode = this.ctx.intMode === "bigint";
    const leftIsInt = bigintMode && this.exprIsInt(leftNode);
    const rightIsInt = bigintMode && this.exprIsInt(rightNode);
    const bothInts = leftIsInt && rightIsInt;
    const mixedIntFloat =
      bigintMode &&
      ((leftIsInt && !rightIsInt && rightKind === "number") ||
        (rightIsInt && !leftIsInt && leftKind === "number"));
    const convertToIntSide = (text: string, node: AstNode): string =>
      this.exprIsInt(node) ? this.helperCall("toFloat", [text]) : text;
    switch (operator) {
      case "Add": {
        this.ctx.record({
          span,
          sourceKind: "py.BinOp(Add)",
          rule: bothArrays
            ? "py.add-sequences→js.spread-concat"
            : dynamic
              ? "py.add→__ctrans.add"
              : "py.add→js.+",
          decision: dynamic && !bothArrays ? "semantic" : "deterministic",
          rationale: bothStrings
            ? "string concatenation correspondence (both operands statically str)"
            : bothNumbers
              ? "numeric addition correspondence"
              : bothArrays
                ? "Python list concatenation corresponds to array spread concat (statically typed sequences)"
                : "Python raises on str+number while JS concatenates - operand types are not statically known, __ctrans_add preserves Python semantics",
          adaptation: dynamic ? "__ctrans_add" : bothArrays ? "spread concat" : null,
          targetSummary: dynamic ? "add(left, right)" : `${left} + ${right}`,
        });
        if (bothArrays) return `([...${left}, ...${right}])`;
        if (mixedIntFloat) {
          // Python int + float -> float: the int operand crosses the D-006 Number
          // boundary explicitly (documented precision note).
          const leftText = convertToIntSide(left, leftNode);
          const rightText = convertToIntSide(right, rightNode);
          this.ctx.record({
            span,
            sourceKind: "py.BinOp(Add)",
            rule: "py.add-mixed→js.float-boundary",
            decision: "semantic",
            rationale:
              "intMode=bigint: int/float mix follows Python (float result); the int operand converts through Number (precision boundary above 2^53)",
            adaptation: "__ctrans_toFloat boundary conversion",
            warnings: [CTW_NUM_BIGINT_BOUNDARY],
            targetSummary: "float addition (int converted)",
          });
          return `(${leftText} + ${rightText})`;
        }
        if (bothInts) return `(${left} + ${right})`;
        if (dynamic) return this.helperCall("add", [left, right]);
        return `(${left} + ${right})`;
      }
      case "Sub": {
        this.ctx.record({
          span,
          sourceKind: "py.BinOp(Sub)",
          rule: dynamic ? "py.sub→__ctrans.sub" : "py.sub→js.-",
          decision: dynamic ? "semantic" : "deterministic",
          rationale: bothNumbers
            ? "numeric subtraction correspondence"
            : "operands are statically unknown; JS would coerce - __ctrans_sub raises the Python TypeError",
          adaptation: dynamic ? "__ctrans_sub" : null,
          targetSummary: dynamic ? "sub(left, right)" : `${left} - ${right}`,
        });
        if (mixedIntFloat) {
          const leftText = convertToIntSide(left, leftNode);
          const rightText = convertToIntSide(right, rightNode);
          this.ctx.record({
            span,
            sourceKind: "py.BinOp(Sub)",
            rule: "py.sub-mixed→js.float-boundary",
            decision: "semantic",
            rationale:
              "intMode=bigint: int/float mix follows Python (float result); the int operand converts through Number (precision boundary above 2^53)",
            adaptation: "__ctrans_toFloat boundary conversion",
            warnings: [CTW_NUM_BIGINT_BOUNDARY],
            targetSummary: "float subtraction (int converted)",
          });
          return `(${leftText} - ${rightText})`;
        }
        if (bothInts) return `(${left} - ${right})`;
        if (dynamic) return this.helperCall("sub", [left, right]);
        return `(${left} - ${right})`;
      }
      case "Mult": {
        if (leftKind === "string" || rightKind === "string") {
          this.ctx.record({
            span,
            sourceKind: "py.BinOp(Mult)",
            rule: "py.mul→__ctrans.mul",
            decision: "semantic",
            rationale: "string repetition has no JS operator; helper replicates Python semantics",
            adaptation: "sequence repetition via __ctrans_mul",
            targetSummary: "__ctrans_mul(left, right)",
          });
          return this.helperCall("mul", [left, right]);
        }
        this.ctx.record({
          span,
          sourceKind: "py.BinOp(Mult)",
          rule: bothNumbers ? "py.mul→js.*" : "py.mul→__ctrans.mul",
          decision: bothNumbers ? "deterministic" : "semantic",
          rationale: bothNumbers
            ? "numeric multiplication correspondence"
            : "operands are statically unknown; __ctrans_mul preserves repetition/numeric Python semantics",
          adaptation: bothNumbers ? null : "__ctrans_mul",
          targetSummary: bothNumbers ? `${left} * ${right}` : "__ctrans_mul(left, right)",
        });
        if (mixedIntFloat) {
          const leftText = convertToIntSide(left, leftNode);
          const rightText = convertToIntSide(right, rightNode);
          this.ctx.record({
            span,
            sourceKind: "py.BinOp(Mult)",
            rule: "py.mul-mixed→js.float-boundary",
            decision: "semantic",
            rationale:
              "intMode=bigint: int/float mix follows Python (float result); the int operand converts through Number (precision boundary above 2^53)",
            adaptation: "__ctrans_toFloat boundary conversion",
            warnings: [CTW_NUM_BIGINT_BOUNDARY],
            targetSummary: "float multiplication (int converted)",
          });
          return `(${leftText} * ${rightText})`;
        }
        if (bothInts) return `(${left} * ${right})`;
        if (bothNumbers) return `(${left} * ${right})`;
        return this.helperCall("mul", [left, right]);
      }
      case "Div":
        this.ctx.record({
          span,
          sourceKind: "py.BinOp(Div)",
          rule: "py.div→__ctrans.div",
          decision: "semantic",
          rationale: "Python raises ZeroDivisionError; JS yields Infinity/NaN",
          adaptation: "true division via __ctrans_div (ZeroDivisionError preserved)",
          targetSummary: "__ctrans_div(left, right)",
        });
        return this.helperCall("div", [left, right]);
      case "FloorDiv": {
        // D-006 bigint mode: floor division of provable ints is always a Python
        // int (bigint), so the widened helper result is soundly narrowed here.
        const intArgs = bigintMode && leftIsInt && rightIsInt;
        this.ctx.record({
          span,
          sourceKind: "py.BinOp(FloorDiv)",
          rule: "py.floordiv→__ctrans.floorDiv",
          decision: "semantic",
          rationale: intArgs
            ? "intMode=bigint: floor division of provable ints is exact (result narrowed to bigint)"
            : "JS division truncates toward zero; Python floors toward negative infinity",
          adaptation: "floor division via __ctrans_floorDiv",
          targetSummary: "__ctrans_floorDiv(left, right)",
        });
        const floorText = this.helperCall("floorDiv", [left, right]);
        return intArgs && this.ctx.target === "typescript" ? `${floorText} as bigint` : floorText;
      }
      case "Mod": {
        const intArgs = bigintMode && leftIsInt && rightIsInt;
        this.ctx.record({
          span,
          sourceKind: "py.BinOp(Mod)",
          rule: "py.mod→__ctrans.mod",
          decision: "semantic",
          rationale: intArgs
            ? "intMode=bigint: modulo of provable ints is exact (result narrowed to bigint)"
            : "Python modulo takes the divisor's sign; JS takes the dividend's",
          adaptation: "modulo via __ctrans_mod",
          targetSummary: "__ctrans_mod(left, right)",
        });
        const modText = this.helperCall("mod", [left, right]);
        return intArgs && this.ctx.target === "typescript" ? `${modText} as bigint` : modText;
      }
      case "Pow": {
        // bigint mode: provable ints go through the helper — Python returns a float
        // for negative exponents, and native bigint ** would RangeError on them.
        // A provably NON-NEGATIVE literal exponent keeps the exact native operator.
        const powExponent = kid(node, "right")!;
        const powExponentLiteral =
          bigintMode &&
          powExponent.kind === "Constant" &&
          typeof powExponent.fields["value"] === "number" &&
          Number.isInteger(powExponent.fields["value"]) &&
          (powExponent.fields["value"] as number) >= 0;
        if (bothInts && powExponentLiteral) {
          this.ctx.record({
            span,
            sourceKind: "py.BinOp(Pow)",
            rule: "py.pow→js.**",
            decision: "deterministic",
            rationale:
              "intMode=bigint: non-negative literal exponent keeps exact native bigint exponentiation",
            targetSummary: `${left} ** ${right}`,
          });
          return `(${left} ** ${right})`;
        }
        if (bothInts) {
          this.ctx.record({
            span,
            sourceKind: "py.BinOp(Pow)",
            rule: "py.pow→__ctrans.pow",
            decision: "semantic",
            rationale:
              "intMode=bigint: __ctrans_pow keeps exact bigint results for non-negative exponents and Python's float result for negative ones",
            adaptation: "__ctrans_pow",
            targetSummary: "__ctrans_pow(left, right)",
          });
          return this.helperCall("pow", [left, right]);
        }
        this.ctx.record({
          span,
          sourceKind: "py.BinOp(Pow)",
          rule: bothNumbers ? "py.pow→js.**" : "py.pow→__ctrans.pow",
          decision: bothNumbers ? "deterministic" : "semantic",
          rationale: bothNumbers
            ? "exponentiation correspondence for numeric bases"
            : "operands are statically unknown; __ctrans_pow validates numbers",
          adaptation: bothNumbers ? null : "__ctrans_pow",
          targetSummary: bothNumbers ? `${left} ** ${right}` : "__ctrans_pow(left, right)",
        });
        if (bothNumbers) return `(${left} ** ${right})`;
        return this.helperCall("pow", [left, right]);
      }
      case "BitOr":
      case "BitAnd":
      case "BitXor":
      case "LShift":
      case "RShift": {
        const jsOperator = { BitOr: "|", BitAnd: "&", BitXor: "^", LShift: "<<", RShift: ">>" }[
          operator
        ]!;
        if (bothInts) {
          // D-006 exact mode: native bigint bitwise operators are exact — no int32
          // truncation, so the number-mode precision warning does not apply.
          this.ctx.record({
            span,
            sourceKind: `py.BinOp(${operator})`,
            rule: "py.bitwise→js.bigint-bitwise",
            decision: "deterministic",
            rationale: "intMode=bigint: native bigint bitwise operators are exact",
            targetSummary: `${left} ${jsOperator} ${right}`,
          });
          return `(${left} ${jsOperator} ${right})`;
        }
        if (bothNumbers) {
          this.ctx.record({
            span,
            sourceKind: `py.BinOp(${operator})`,
            rule: "py.bitwise→js.bitwise",
            decision: "semantic",
            rationale: "JS bitwise ops coerce to int32 - results differ above 32 bits (D-006)",
            adaptation: "native operator with precision warning",
            warnings: [CTW_NUM_BITWISE],
            targetSummary: `${left} ${jsOperator} ${right}`,
          });
          return `(${left} ${jsOperator} ${right})`;
        }
        const helperNames: Record<string, string> = {
          BitOr: "bitOr",
          BitAnd: "bitAnd",
          BitXor: "bitXor",
          LShift: "lShift",
          RShift: "rShift",
        };
        this.ctx.record({
          span,
          sourceKind: `py.BinOp(${operator})`,
          rule: `py.bitwise→__ctrans.${helperNames[operator]!}`,
          decision: "semantic",
          rationale:
            "operands are statically unknown and JS bitwise coerces to int32 (D-006) - __ctrans_bit* validates numbers",
          adaptation: `__ctrans_${helperNames[operator]}`,
          warnings: [CTW_NUM_BITWISE],
          targetSummary: `__ctrans_${helperNames[operator]}(left, right)`,
        });
        return this.helperCall(helperNames[operator]!, [left, right]);
      }
      default:
        return this.unsupportedExpr(node, `py.BinOp(${operator})`, "unsupported binary operator");
    }
  }

  // Conservative bigint-mode classification (D-006 exact mode): does this expression
  // carry a Python INT value at runtime, so native bigint operators are exact?
  // Only statically provable int-ness qualifies (constants, int-annotated bindings,
  // int-preserving operations on ints); everything else routes through the helpers,
  // which resolve the int/float mix at runtime.
  private exprIsInt(node: AstNode): boolean {
    switch (node.kind) {
      case "Constant":
        return typeof node.fields["value"] === "number" && Number.isInteger(node.fields["value"]);
      case "UnaryOp": {
        const op = kid(node, "op")!.kind;
        return (op === "USub" || op === "UAdd") && this.exprIsInt(kid(node, "operand") ?? node);
      }
      case "Name": {
        const hit = this.scopes.lookup(String(scalar(node, "id") ?? ""));
        return hit !== null && hit.type.kind === "number" && hit.type.numberKind === "int";
      }
      case "Attribute": {
        if (this.selfNames.length > 0) {
          const receiver = kid(node, "value");
          const receiverName =
            receiver !== null && receiver.kind === "Name"
              ? String(scalar(receiver, "id") ?? "")
              : null;
          const activeSelf = this.selfNames[this.selfNames.length - 1];
          if (receiverName !== null && activeSelf === receiverName) {
            const fieldType = this.selfFieldTypes.get(String(scalar(node, "attr") ?? ""));
            return (
              fieldType !== undefined &&
              fieldType.type.kind === "number" &&
              fieldType.type.numberKind === "int"
            );
          }
        }
        return false;
      }
      case "Call": {
        const func = kid(node, "func");
        if (func !== null && func.kind === "Name") {
          const id = String(scalar(func, "id") ?? "");
          if (id.startsWith("__ctrans_")) {
            // Only helpers whose bigint-mode result is ALWAYS bigint qualify.
            return ["toIntBig"].includes(id.slice("__ctrans_".length));
          }
          const hit = this.scopes.lookup(id);
          return (
            hit !== null &&
            hit.type.kind === "function" &&
            hit.type.returnType.kind === "number" &&
            hit.type.returnType.numberKind === "int"
          );
        }
        return false;
      }
      case "BinOp": {
        const op = kid(node, "op")!.kind;
        if (op === "Pow") {
          // base ** exponent is an int only when the exponent is a provably
          // non-negative int literal (a negative exponent yields a float).
          const exponent = kid(node, "right")!;
          const exponentValue = exponent.fields["value"];
          const exponentConstant =
            exponent.kind === "Constant" &&
            typeof exponentValue === "number" &&
            Number.isInteger(exponentValue) &&
            exponentValue >= 0;
          if (!exponentConstant) return false;
          return this.exprIsInt(kid(node, "left")!);
        }
        // / is Python true division (always float); arithmetic and bitwise
        // operators preserve int-ness for int operands.
        if (
          ![
            "Add",
            "Sub",
            "Mult",
            "FloorDiv",
            "Mod",
            "BitOr",
            "BitAnd",
            "BitXor",
            "LShift",
            "RShift",
          ].includes(op)
        ) {
          return false;
        }
        return this.exprIsInt(kid(node, "left")!) && this.exprIsInt(kid(node, "right")!);
      }
      default:
        return false;
    }
  }

  // Statically provable Python-float-ness (used for Python-exact float str() at
  // f-string/str() sites): float literals, float-annotated bindings, and operations
  // with a float operand. Python `/` ALWAYS yields a float. Conservative: dynamic
  // values are not proven float (the runtime str helper keeps int-like output for
  // integral numbers — the documented number-mode limitation).
  private exprIsFloat(node: AstNode): boolean {
    switch (node.kind) {
      case "Constant":
        return typeof node.fields["value"] === "number" && !Number.isInteger(node.fields["value"]);
      case "UnaryOp": {
        const op = kid(node, "op")!.kind;
        return (op === "USub" || op === "UAdd") && this.exprIsFloat(kid(node, "operand") ?? node);
      }
      case "Name": {
        const hit = this.scopes.lookup(String(scalar(node, "id") ?? ""));
        return hit !== null && hit.type.kind === "number" && hit.type.numberKind === "float";
      }
      case "Attribute": {
        if (this.selfNames.length > 0) {
          const receiver = kid(node, "value");
          const receiverName =
            receiver !== null && receiver.kind === "Name"
              ? String(scalar(receiver, "id") ?? "")
              : null;
          const activeSelf = this.selfNames[this.selfNames.length - 1];
          if (receiverName !== null && activeSelf === receiverName) {
            const fieldType = this.selfFieldTypes.get(String(scalar(node, "attr") ?? ""));
            return (
              fieldType !== undefined &&
              fieldType.type.kind === "number" &&
              fieldType.type.numberKind === "float"
            );
          }
        }
        return false;
      }
      case "Call": {
        const func = kid(node, "func");
        if (func !== null && func.kind === "Name") {
          const hit = this.scopes.lookup(String(scalar(func, "id") ?? ""));
          return (
            hit !== null &&
            hit.type.kind === "function" &&
            hit.type.returnType.kind === "number" &&
            hit.type.returnType.numberKind === "float"
          );
        }
        return false;
      }
      case "BinOp": {
        const op = kid(node, "op")!.kind;
        if (op === "Div") return true; // Python true division is always a float
        if (!["Add", "Sub", "Mult", "FloorDiv", "Mod", "Pow"].includes(op)) return false;
        return this.exprIsFloat(kid(node, "left")!) || this.exprIsFloat(kid(node, "right")!);
      }
      default:
        return false;
    }
  }

  private inferOperandKind(node: AstNode): "number" | "string" | "array" | null {
    switch (node.kind) {
      case "Constant":
        return typeof node.fields["value"] === "number"
          ? "number"
          : typeof node.fields["value"] === "string"
            ? "string"
            : null;
      case "JoinedStr":
        return "string";
      case "List":
        return "array";
      case "Await":
        return this.inferOperandKind(kid(node, "value")!);
      case "Name": {
        const hit = this.scopes.lookup(String(scalar(node, "id") ?? ""));
        if (hit?.type.kind === "number") return "number";
        if (hit?.type.kind === "string") return "string";
        if (hit?.type.kind === "array" || hit?.type.kind === "set") return "array";
        return null;
      }
      case "Attribute": {
        // self.<field> references the declaring class's field type.
        if (this.selfNames.length > 0) {
          const receiver = kid(node, "value");
          const receiverName =
            receiver !== null && receiver.kind === "Name"
              ? String(scalar(receiver, "id") ?? "")
              : null;
          const activeSelf = this.selfNames[this.selfNames.length - 1];
          if (receiverName !== null && activeSelf === receiverName) {
            const attributeName = String(scalar(node, "attr") ?? "");
            const fieldType = this.selfFieldTypes.get(attributeName);
            if (fieldType?.type.kind === "number") return "number";
            if (fieldType?.type.kind === "string") return "string";
            return null;
          }
        }
        return null;
      }
      case "Call": {
        // Calls of unit-local annotated functions carry the declared return type;
        // collection-relevant runtime helpers have known result kinds too.
        const func = kid(node, "func");
        if (func !== null && func.kind === "Name") {
          const id = String(scalar(func, "id") ?? "");
          if (id.startsWith("__ctrans_")) {
            const helper = id.slice("__ctrans_".length);
            // D-006 bigint mode: widened numeric helpers may return bigint, so
            // their results are dynamic for native-op decisions (helpers chain).
            if (this.ctx.intMode === "bigint" && HELPER_WIDENED_RETURNS.has(helper)) {
              return null;
            }
            if (HELPER_NUMBER_RETURNS.has(helper)) return "number";
          }
          const hit = this.scopes.lookup(id);
          if (hit?.type.kind === "function") {
            const returnType = hit.type.returnType;
            if (returnType.kind === "number") return "number";
            if (returnType.kind === "string") return "string";
          }
        }
        return null;
      }
      case "BinOp": {
        const left = this.inferOperandKind(kid(node, "left")!);
        const right = this.inferOperandKind(kid(node, "right")!);
        if (left === "string" || right === "string") return "string";
        if (left === "array" && right === "array") return "array";
        if (left === "number" && right === "number") {
          // D-006 bigint mode: sub/floorDiv/mod/pow/bitwise on dynamic operands
          // lower to widened helpers (result `number | bigint`) — only `/` keeps a
          // guaranteed-number helper result here.
          if (this.ctx.intMode === "bigint") {
            const op = kid(node, "op")!.kind;
            return op === "Div" ? "number" : null;
          }
          return "number";
        }
        return null;
      }
      default:
        return null;
    }
  }

  // Scope-declared AnnotatedType for an annotation node; honest unknown when the
  // annotation is absent or outside the mappable subset.
  private declaredType(annotation: AstNode | null): AnnotatedType {
    if (annotation === null) return annotateUnknown();
    const type = commonTypeFromAnnotation(annotation);
    if (type === null) return annotateUnknown();
    return {
      type,
      origin: "explicit",
      confidence: type.kind === "number" ? "approximate" : "exact",
      span: annotation.span ?? null,
    };
  }

  // Initializer-derived type for Name assignments: Python literals, class
  // constructions (unit-local classes), annotated calls, names, and await results.
  private valueAnnotatedType(node: AstNode): AnnotatedType | null {
    if (node.kind === "Call" && kid(node, "func")?.kind === "Name") {
      const hit = this.scopes.lookup(String(scalar(kid(node, "func")!, "id") ?? ""));
      if (hit?.type.kind === "class") {
        return {
          type: { kind: "instance", className: hit.type.name ?? "" },
          origin: "inferred",
          confidence: "approximate",
          span: node.span ?? null,
        };
      }
      if (hit?.type.kind === "function") {
        const returnType = hit.type.returnType;
        if (returnType.kind !== "unknown") {
          return {
            type: returnType,
            origin: "inferred",
            confidence: "approximate",
            span: node.span ?? null,
          };
        }
      }
      return null;
    }
    if (node.kind === "Await" || node.kind === "Name") {
      const inner = node.kind === "Await" ? kid(node, "value") : node;
      if (inner !== null && inner.kind === "Name") {
        const hit = this.scopes.lookup(String(scalar(inner, "id") ?? ""));
        if (hit !== null && hit.type.kind !== "unknown" && hit.type.kind !== "module") {
          return {
            type: hit.type,
            origin: "inferred",
            confidence: hit.confidence,
            span: node.span ?? null,
          };
        }
      }
      if (inner !== null && node.kind === "Await" && inner.kind === "Call") {
        return this.valueAnnotatedType(inner);
      }
      return null;
    }
    return constantAnnotatedType(node);
  }

  // Type annotation a fresh `let` must carry so TypeScript inference matches
  // Python's open, rebindable semantics: an empty list has no element to infer
  // (implicit any[] fails strict S2), and a dict is an open string-keyed mapping —
  // a narrow object literal type would reject later key writes. null adds nothing.
  private freshLetTypeSuffix(valueNode: AstNode | null): string {
    if (valueNode === null || this.ctx.target !== "typescript") return "";
    if (valueNode.kind === "List" && kids(valueNode, "elts").length === 0) return ": unknown[]";
    if (valueNode.kind === "Dict") {
      const valueTypes = new Set<string>();
      for (const element of kids(valueNode, "values")) {
        valueTypes.add(literalTsTypeText(element));
      }
      // An empty dict has no value elements: the honest value type is unknown.
      const union = valueTypes.size === 0 ? "unknown" : [...valueTypes].sort().join(" | ");
      return `: Record<string, ${union}>`;
    }
    return "";
  }

  private lowerUnaryOp(node: AstNode): string {
    const operandNode = kid(node, "operand")!;
    const operand = this.lowerExpr(operandNode);
    const operator = kid(node, "op")!.kind;
    const span = pySpan(node);
    const operandNumber = this.inferOperandKind(operandNode) === "number";
    if (operator === "Not") {
      this.ctx.useHelper("truthy");
      this.ctx.record({
        span,
        sourceKind: "py.UnaryOp(Not)",
        rule: "py.not→js.!truthy",
        decision: "semantic",
        rationale: "Python truthiness differs from JS coercion",
        adaptation: "operand wrapped in __ctrans_truthy",
        targetSummary: `!truthy(${operand})`,
      });
      return `!__ctrans_truthy(${operand})`;
    }
    const jsOperator: Record<string, string> = { USub: "-", UAdd: "+", Invert: "~" };
    const native = jsOperator[operator];
    if (native === undefined) {
      return this.unsupportedExpr(node, `py.UnaryOp(${operator})`, "unsupported unary operator");
    }
    if (operandNumber) {
      this.ctx.record({
        span,
        sourceKind: `py.UnaryOp(${operator})`,
        rule: "py.unary→js.unary",
        decision: "deterministic",
        rationale: "unary operator correspondence (number-typed operand)",
        targetSummary: `${native}${operand}`,
      });
      return `(${native}${operand})`;
    }
    const helperName: Record<string, string> = { USub: "neg", UAdd: "pos" };
    const dynamicHelper = helperName[operator];
    if (dynamicHelper === undefined) {
      // Python ~x on a dynamic value: int32 semantics would differ; unsupported.
      return this.unsupportedExpr(
        node,
        "py.UnaryOp(Invert)",
        "bitwise inversion of a dynamically typed value is outside the M4 subset",
      );
    }
    this.ctx.record({
      span,
      sourceKind: `py.UnaryOp(${operator})`,
      rule: `py.unary→__ctrans.${dynamicHelper}`,
      decision: "semantic",
      rationale:
        "operand is statically unknown; Python raises TypeError for non-numbers while JS coerces",
      adaptation: `__ctrans_${dynamicHelper}`,
      targetSummary: `__ctrans_${dynamicHelper}(${operand})`,
    });
    return this.helperCall(dynamicHelper, [operand]);
  }

  private lowerBoolOp(node: AstNode): string {
    const values = kids(node, "values");
    const isAnd = kid(node, "op")!.kind === "And";
    // D-016 provability: when EVERY operand's Python truthiness is provably equal
    // to JS truthiness, the value semantics coincide with native &&/||. Otherwise
    // the ternary chain preserves Python's operand-value semantics.
    if (values.every((operand) => this.nativeTruthyProvable(operand))) {
      const native = values.map((operand) => this.lowerExpr(operand));
      this.ctx.record({
        span: pySpan(node),
        sourceKind: `py.BoolOp(${isAnd ? "And" : "Or"})`,
        rule: "py.boolop→js.native",
        decision: "deterministic",
        rationale:
          "all operand truthinesses are provably equivalent, so native &&/|| preserves Python's operand-value semantics",
        targetSummary: isAnd ? "native and-chain" : "native or-chain",
      });
      return `(${native.join(isAnd ? " && " : " || ")})`;
    }
    // Python and/or return OPERAND values gated on Python truthiness; JS &&/|| use JS
    // truthiness (diverges for NaN/[]/{}). The ternary chain preserves Python values.
    this.ctx.useHelper("truthy");
    const build = (index: number): string => {
      const current = this.lowerExpr(values[index]!);
      if (index === values.length - 1) return current;
      const rest = build(index + 1);
      return isAnd
        ? `(__ctrans_truthy(${current}) ? ${rest} : ${current})`
        : `(__ctrans_truthy(${current}) ? ${current} : ${rest})`;
    };
    this.ctx.record({
      span: pySpan(node),
      sourceKind: `py.BoolOp(${isAnd ? "And" : "Or"})`,
      rule: "py.boolop→js.ternary-truthy",
      decision: "semantic",
      rationale:
        "and/or return operand values gated on Python truthiness; JS &&/|| diverge for NaN/[]/{}",
      adaptation: "truthiness-gated ternary chain",
      targetSummary: isAnd ? "and-chain" : "or-chain",
    });
    return build(0);
  }

  private lowerCompare(node: AstNode): string {
    const operators = kids(node, "ops");
    const comparators = kids(node, "comparators");
    if (operators.length !== comparators.length) {
      return this.unsupportedExpr(node, "py.Compare", "operator/comparator count mismatch");
    }
    if (operators.length > 1) {
      // Chained comparisons evaluate middle operands once; expression-position temps
      // are not available in M4, so the honest classification is unsupported.
      return this.unsupportedExpr(
        node,
        "py.Compare(chained)",
        "chained comparisons require single-evaluation temporaries (outside the M4 subset)",
      );
    }
    const leftNode = kid(node, "left")!;
    const left = this.lowerExpr(leftNode);
    const comparator = comparators[0]!;
    const right = this.lowerExpr(comparator);
    return this.compareOperator(operators[0]!, leftNode, comparator, left, right);
  }

  private compareOperator(
    operator: AstNode,
    leftNode: AstNode,
    comparator: AstNode,
    left: string,
    right: string,
  ): string {
    const span = pySpan(comparator);
    const leftKind = this.inferOperandKind(leftNode);
    const rightKind = this.inferOperandKind(comparator);
    const sameKnownKind =
      (leftKind === "number" && rightKind === "number") ||
      (leftKind === "string" && rightKind === "string");
    const orderingHelpers: Record<string, string> = { Lt: "lt", LtE: "lte", Gt: "gt", GtE: "ge" };
    switch (operator.kind) {
      case "Eq":
        this.ctx.useHelper("eq");
        this.ctx.record({
          span,
          sourceKind: "py.Compare(Eq)",
          rule: "py.eq→__ctrans.eq",
          decision: "semantic",
          rationale: "Python == compares sequences elementwise; JS === does not",
          adaptation: "equality via __ctrans_eq",
          targetSummary: "eq(left, right)",
        });
        return `__ctrans_eq(${left}, ${right})`;
      case "NotEq":
        this.ctx.useHelper("eq");
        this.ctx.record({
          span,
          sourceKind: "py.Compare(NotEq)",
          rule: "py.ne→!__ctrans.eq",
          decision: "semantic",
          rationale: "Python != is the negation of value equality",
          adaptation: "negated __ctrans_eq",
          targetSummary: "!eq(left, right)",
        });
        return `!__ctrans_eq(${left}, ${right})`;
      case "Is": {
        const none = comparator.kind === "Constant" && comparator.fields["value"] === null;
        this.ctx.record({
          span,
          sourceKind: "py.Compare(Is)",
          rule: "py.is→js.===",
          decision: "deterministic",
          rationale: none
            ? "identity on the None singleton (nullMode=undefined)"
            : "object identity correspondence",
          targetSummary: `${left} === ${right}`,
        });
        return `(${left} === ${right})`;
      }
      case "IsNot": {
        const none = comparator.kind === "Constant" && comparator.fields["value"] === null;
        this.ctx.record({
          span,
          sourceKind: "py.Compare(IsNot)",
          rule: "py.isnot→js.!==",
          decision: "deterministic",
          rationale: none
            ? "identity on the None singleton (nullMode=undefined)"
            : "object identity correspondence",
          targetSummary: `${left} !== ${right}`,
        });
        return `(${left} !== ${right})`;
      }
      case "Lt":
      case "LtE":
      case "Gt":
      case "GtE": {
        const helper = orderingHelpers[operator.kind]!;
        const jsOperator = { Lt: "<", LtE: "<=", Gt: ">", GtE: ">=" }[operator.kind]!;
        this.ctx.record({
          span,
          sourceKind: `py.Compare(${operator.kind})`,
          rule: sameKnownKind ? `py.${helper}→js.${jsOperator}` : `py.${helper}→__ctrans.${helper}`,
          decision: sameKnownKind ? "deterministic" : "semantic",
          rationale: sameKnownKind
            ? "ordering comparison correspondence (both operands statically number or str)"
            : "operands are statically unknown; JS relational operators coerce and TS cannot compile them on unknown - __ctrans_compare raises the Python TypeError for mixed types",
          adaptation: sameKnownKind ? null : `__ctrans_${helper}`,
          targetSummary: sameKnownKind
            ? `${left} ${jsOperator} ${right}`
            : `__ctrans_${helper}(left, right)`,
        });
        if (sameKnownKind) return `(${left} ${jsOperator} ${right})`;
        return this.helperCall(helper, [left, right]);
      }
      case "In":
        this.ctx.useHelper("contains");
        this.ctx.record({
          span,
          sourceKind: "py.Compare(In)",
          rule: "py.in→__ctrans.contains",
          decision: "semantic",
          rationale: "Python membership uses == on members; JS includes uses ===",
          adaptation: "membership via __ctrans_contains",
          targetSummary: "contains(container, item)",
        });
        return `__ctrans_contains(${right}, ${left})`;
      case "NotIn":
        this.ctx.useHelper("contains");
        this.ctx.record({
          span,
          sourceKind: "py.Compare(NotIn)",
          rule: "py.notin→!__ctrans.contains",
          decision: "semantic",
          rationale: "negated membership with == semantics",
          adaptation: "negated __ctrans_contains",
          targetSummary: "!contains(container, item)",
        });
        return `!__ctrans_contains(${right}, ${left})`;
      default:
        return this.unsupportedExpr(
          comparator,
          `py.Compare(${operator.kind})`,
          "unsupported comparison operator",
        );
    }
  }

  private lowerCall(node: AstNode): string {
    const func = kid(node, "func")!;
    const args = kids(node, "args");
    const keywords = kids(node, "keywords");
    const span = pySpan(node);
    if (keywords.length > 0) {
      return this.unsupportedExpr(
        node,
        "py.Call(kwargs)",
        "keyword arguments are outside the M4 subset (registry-backed mapping arrives in M5)",
      );
    }
    if (func.kind === "Name" && scalar(func, "id") === "print") {
      this.ctx.record({
        span,
        sourceKind: "py.Call(print)",
        rule: "py.print→__ctrans.print",
        decision: "semantic",
        rationale: "Python print converts arguments with str() and joins with spaces",
        adaptation: "__ctrans_print",
        targetSummary: "print(...)",
      });
      return this.helperCall(
        "print",
        args.map((arg) => this.lowerExpr(arg)),
      );
    }
    if (func.kind === "Name") {
      const builtin = this.lowerBuiltinCall(node, String(scalar(func, "id") ?? ""), args, span);
      if (builtin !== null) return builtin;
    }
    const argsText = args.map((arg) =>
      arg.kind === "Starred"
        ? `...${this.lowerExpr(kid(arg, "value") ?? arg)}`
        : this.lowerExpr(arg),
    );

    // Callee routing: statically known callees (local functions/classes, module
    // members, self methods) call natively; dynamically typed callees go through the
    // __ctrans call helpers so Python's "not callable" TypeError is preserved.
    if (func.kind === "Attribute") {
      const receiverNode = kid(func, "value")!;
      const attrName = String(scalar(func, "attr") ?? "");
      // WS F: `requests.<verb>(...)` -> `await fetch(...)` (sync-to-async boundary,
      // docs/dependency-mapping.md §6). The documented subset: GET/POST/HEAD/DELETE
      // with data=/json= kwargs unsupported (kwargs calls are outside the M4/M5
      // call surface) — anything else stays an honest unsupported marker.
      if (receiverNode.kind === "Name" && scalar(receiverNode, "id") === "requests") {
        const verb = attrName.toLowerCase();
        const methodMap: Record<string, string> = {
          get: "GET",
          post: "POST",
          head: "HEAD",
          delete: "DELETE",
        };
        const method = methodMap[verb];
        if (method !== undefined && args.length === 1) {
          this.ctx.record({
            span,
            sourceKind: `py.Call(requests.${verb})`,
            rule: `py.requests-${verb}→js.fetch`,
            decision: "semantic",
            rationale:
              "sync-to-async boundary (D-011): Python requests is synchronous, JS fetch is async-only — the call awaits and the response surface is the documented subset (status/text/json/raise_for_status)",
            adaptation: `await fetch(...) (${method})`,
            targetSummary: `fetch(${args.map((arg) => this.lowerExpr(arg)).join(", ")})`,
          });
          return `await fetch(${args.map((arg) => this.lowerExpr(arg)).join(", ")}, { method: "${method}" })`;
        }
        return this.unsupportedExpr(
          node,
          `py.Call(requests.${attrName})`,
          "requests surface outside the mapped subset (methods/data=/json=/sessions) — the registry documents the boundary",
        );
      }
      // `super().__init__(...)` calls the parent constructor: JS needs `super(...)`.
      if (receiverNode.kind === "Call" && isSuperCall(receiverNode) && attrName === "__init__") {
        this.ctx.record({
          span,
          sourceKind: "py.Call(super.__init__)",
          rule: "py.super-init→js.super",
          decision: "deterministic",
          rationale: "parent constructor invocation corresponds to super(...)",
          targetSummary: `super(${argsText.join(", ")})`,
        });
        return `super(${argsText.join(", ")})`;
      }
      const receiverText = this.lowerExpr(receiverNode);
      if (this.memberAccessNative(receiverNode)) {
        const receiverType = this.receiverCommonType(receiverNode);
        // Registry v1 (D-011): mapped (receiver kind, method) pairs lower through
        // their registry entry; unmapped container methods keep the M4 warning.
        const receiverKind: "array" | "map" | "string" | "set" | null =
          receiverType !== null &&
          (receiverType.type.kind === "array" ||
            receiverType.type.kind === "map" ||
            receiverType.type.kind === "string" ||
            receiverType.type.kind === "set")
            ? (receiverType.type.kind as "array" | "map" | "string" | "set")
            : null;
        const mapping =
          receiverKind !== null ? this.registry.lookupMethod(receiverKind, attrName) : null;
        if (mapping !== null && mapping.emit.kind !== "unsupported") {
          if (mapping.emit.kind === "rename") {
            const method = mapping.emit.method;
            let callText: string;
            let decision: "deterministic" | "semantic" = "deterministic";
            if (method === "length-zero") {
              callText = `(${receiverText}.length = 0)`;
              decision = "semantic";
            } else if (method === "slice" || method === "keys-object") {
              callText =
                method === "slice" ? `${receiverText}.slice()` : `Object.keys(${receiverText})`;
              decision = "semantic";
            } else if (method === "values-object") {
              callText = `Object.values(${receiverText})`;
              decision = "semantic";
            } else if (method === "entries-object") {
              callText = `Object.entries(${receiverText})`;
              decision = "semantic";
            } else if (method === "push-spread") {
              callText = `${receiverText}.push(...${argsText.join(", ")})`;
              decision = "semantic";
            } else if (method === "splice") {
              // insert(i, v) -> splice(i, 0, v)
              callText = `${receiverText}.splice(${argsText.join(", ")}, 0)`;
              decision = "semantic";
            } else {
              callText = `${receiverText}.${method}(${argsText.join(", ")})`;
            }
            const notes = mapping.emit.notes.join("; ");
            this.ctx.record({
              span,
              sourceKind: "py.Call",
              rule: `py.${receiverKind}-method→js.${mapping.id}`,
              decision,
              rationale: `registry v1 mapping (${mapping.id}): ${notes === "" ? "identical semantics" : notes}`,
              adaptation: method,
              warnings: decision === "semantic" ? [CTW_METHOD_ADAPTED] : [],
              targetSummary: callText,
            });
            return callText;
          }
          // helper mapping: Python semantics via the runtime helper.
          const helperArgs = [receiverText, ...argsText];
          const notes = mapping.emit.notes.join("; ");
          this.ctx.record({
            span,
            sourceKind: "py.Call",
            rule: `py.${receiverKind}-method→__ctrans.${mapping.emit.helper}`,
            decision: "semantic",
            rationale: `registry v1 mapping (${mapping.id}): ${notes === "" ? "Python semantics via the runtime helper" : notes}`,
            adaptation: `__ctrans_${mapping.emit.helper}`,
            warnings: [CTW_METHOD_ADAPTED],
            targetSummary: `${mapping.emit.helper}(receiver, ...)`,
          });
          return this.helperCall(mapping.emit.helper, helperArgs);
        }
        const containerReceiver =
          receiverType !== null &&
          (receiverType.type.kind === "array" || receiverType.type.kind === "map");
        this.ctx.record({
          span,
          sourceKind: "py.Call",
          rule: "py.call→js.call",
          decision: "deterministic",
          rationale: containerReceiver
            ? "method call on a statically typed Python container with no registry mapping: JS has no corresponding method (e.g. list.append without the registry entry) — documented verbatim surface"
            : "method call correspondence on a statically typed receiver",
          warnings: containerReceiver ? [CTW_METHOD_UNMAPPED] : [],
          targetSummary: `${receiverText}.${attrName}(${argsText.join(", ")})`,
        });
        return `${receiverText}.${attrName}(${argsText.join(", ")})`;
      }
      this.ctx.record({
        span,
        sourceKind: "py.Call",
        rule: "py.call→__ctrans.callMethod",
        decision: "semantic",
        rationale:
          "receiver type is statically unknown; TS cannot infer the member and Python's AttributeError/TypeError behavior is preserved via __ctrans_callMethod",
        adaptation: "__ctrans_callMethod",
        targetSummary: `callMethod(${receiverText}, "${attrName}", ...)`,
      });
      return this.helperCall("callMethod", [receiverText, JSON.stringify(attrName), ...argsText]);
    }
    if (func.kind === "Name") {
      const name = String(scalar(func, "id") ?? "");
      // WS F: calls to propagated-async functions await (the callee's signature
      // changed; Python callers are synchronous and must become async too). The
      // set covers BOTH this unit's functions and from-imported ones.
      if (this.asyncFunctions.has(name) || this.importedAsync.has(name)) {
        this.ctx.record({
          span,
          sourceKind: "py.Call",
          rule: "py.call→js.await-asyncified",
          decision: "semantic",
          rationale:
            "callee is asyncified (sync-to-async boundary propagation) — the call site awaits to preserve Python's synchronous control flow",
          adaptation: "await",
          targetSummary: `await ${name}(...)`,
        });
        const argsText0 = args
          .map((arg) =>
            arg.kind === "Starred"
              ? `...${this.lowerExpr(kid(arg, "value") ?? arg)}`
              : this.lowerExpr(arg),
          )
          .join(", ");
        return `await ${name}(${argsText0})`;
      }
      const hit = this.scopes.lookup(name);
      if (hit !== null && hit.type.kind === "class") {
        // Python construction; JS classes need `new` (deterministic here because the
        // class is defined in this unit).
        this.ctx.record({
          span,
          sourceKind: "py.Call",
          rule: "py.call-ctor→js.new",
          decision: "deterministic",
          rationale: "class construction correspondence (unit-local class)",
          targetSummary: `new ${name}(${argsText.join(", ")})`,
        });
        return `new ${name}(${argsText.join(", ")})`;
      }
      if (hit !== null && (hit.type.kind === "unknown" || hit.type.kind === "any")) {
        // Declared but untyped (parameter, captured dynamic value, imported symbol).
        // __ctrans_call constructs classes and calls plain functions, preserving
        // Python's "not callable" TypeError either way.
        this.ctx.record({
          span,
          sourceKind: "py.Call",
          rule: "py.call→__ctrans.call",
          decision: "semantic",
          rationale:
            "callee is a dynamically typed value (parameter or import); TS cannot call unknown and class-vs-function construction is resolved at runtime by __ctrans_call",
          adaptation: "__ctrans_call",
          targetSummary: `call(${name}, ...)`,
        });
        return this.helperCall("call", [name, ...argsText]);
      }
      if (
        hit === null &&
        UNMAPPED_PYTHON_BUILTINS.has(name) &&
        this.registry.lookupBuiltin(name) === null &&
        !this.unitDefinedNames.has(name)
      ) {
        // An unmapped Python builtin cannot be emitted as a bare identifier (the
        // target has no such binding): unsupported with marker + warning, counted
        // as a failure — never a silent verbatim call (AGENTS.md §3, §11).
        return this.unsupportedExpr(
          node,
          "py.Call(builtin)",
          `builtin "${name}" has no M4 mapping (the dependency/method registry arrives in M5)`,
        );
      }
      this.ctx.record({
        span,
        sourceKind: "py.Call",
        rule: "py.call→js.call",
        decision: "deterministic",
        rationale:
          hit === null
            ? "callee is not defined in this unit - emitted verbatim (unit-local function declarations hoist like Python's late resolution; unresolved non-builtin names are flagged by validation)"
            : "call correspondence (function declarations hoist like Python's late resolution)",
        targetSummary: `${name}(${argsText.join(", ")})`,
      });
      return `${name}(${argsText.join(", ")})`;
    }
    const funcText = this.lowerExpr(func);
    this.ctx.record({
      span,
      sourceKind: "py.Call",
      rule: "py.call→__ctrans.call",
      decision: "semantic",
      rationale:
        "callee expression carries no static type; TS cannot invoke unknown values directly",
      adaptation: "__ctrans_call",
      targetSummary: "call(fn, ...)",
    });
    return this.helperCall("call", [funcText, ...argsText]);
  }

  private lowerBuiltinCall(
    node: AstNode,
    name: string,
    args: readonly AstNode[],
    span: Span,
  ): string | null {
    const lowered = (): string[] => args.map((arg) => this.lowerExpr(arg));
    // Registry v1 (D-011): mapped builtins lower through Python-semantics helpers.
    // Arity outside the entry's supported surface stays unsupported (never guessed).
    const mapped = this.registry.lookupBuiltin(name);
    if (mapped !== null) {
      const arityOk = args.length >= mapped.arity.min && args.length <= mapped.arity.max;
      const hasKwargs = args.some((arg) => arg.kind === "keyword");
      if (arityOk && !hasKwargs) {
        const notes = mapped.notes.join("; ");
        this.ctx.record({
          span,
          sourceKind: `py.Call(${name})`,
          rule: `py.${name}→__ctrans.${mapped.helper}`,
          decision: mapped.fidelity === "full" ? "deterministic" : "semantic",
          rationale: `registry v1 mapping (${mapped.id}): ${
            notes === "" ? "exact Python semantics via the generated runtime helper" : notes
          }`,
          adaptation: `__ctrans_${mapped.helper}`,
          targetSummary: `${name}(...)`,
        });
        return this.helperCall(mapped.helper, lowered());
      }
    }
    switch (name) {
      case "len": {
        if (args.length !== 1) break;
        this.ctx.record({
          span,
          sourceKind: "py.Call(len)",
          rule: "py.len→__ctrans.len",
          decision: "semantic",
          rationale: "length/size surface differs across JS types",
          adaptation: "__ctrans_len",
          targetSummary: "len(x)",
        });
        return this.helperCall("len", lowered());
      }
      case "range": {
        if (this.ctx.intMode === "bigint") {
          // D-006 exact mode: range elements are Python ints -> bigints so
          // downstream integer arithmetic stays exact.
          this.ctx.record({
            span,
            sourceKind: "py.Call(range)",
            rule: "py.range→__ctrans.rangeBig",
            decision: "semantic",
            rationale:
              "intMode=bigint: range elements are bigints (the helper still materializes - memory divergence for huge ranges)",
            adaptation: "__ctrans_rangeBig",
            targetSummary: "range(...)",
          });
          return this.helperCall("rangeBig", lowered());
        }
        this.ctx.record({
          span,
          sourceKind: "py.Call(range)",
          rule: "py.range→__ctrans.range",
          decision: "semantic",
          rationale:
            "Python range is lazy; the helper materializes (memory divergence for huge ranges)",
          adaptation: "__ctrans_range",
          targetSummary: "range(...)",
        });
        return this.helperCall("range", lowered());
      }
      case "int": {
        if (args.length !== 1) break;
        if (this.ctx.intMode === "bigint") {
          // D-006 exact mode: int() produces a Python int -> bigint.
          this.ctx.record({
            span,
            sourceKind: "py.Call(int)",
            rule: "py.int→__ctrans.toIntBig",
            decision: "semantic",
            rationale:
              "intMode=bigint: int() returns a bigint; strict integer-string validation and exact float truncation preserved",
            adaptation: "__ctrans_toIntBig",
            targetSummary: "toIntBig(x)",
          });
          return this.helperCall("toIntBig", lowered());
        }
        this.ctx.record({
          span,
          sourceKind: "py.Call(int)",
          rule: "py.int→__ctrans.toInt",
          decision: "semantic",
          rationale: "Python int() raises ValueError on non-integer strings and truncates floats",
          adaptation: "__ctrans_toInt",
          targetSummary: "toInt(x)",
        });
        return this.helperCall("toInt", lowered());
      }
      case "float": {
        if (args.length !== 1) break;
        this.ctx.record({
          span,
          sourceKind: "py.Call(float)",
          rule: "py.float→__ctrans.toFloat",
          decision: "semantic",
          rationale: "Python float() raises ValueError on invalid strings",
          adaptation: "__ctrans_toFloat",
          targetSummary: "toFloat(x)",
        });
        return this.helperCall("toFloat", lowered());
      }
      case "sum": {
        if (args.length !== 1) break;
        this.ctx.record({
          span,
          sourceKind: "py.Call(sum)",
          rule: "py.sum→__ctrans.sum",
          decision: "semantic",
          rationale: "Python sum() over iterables; JS reduce is the equivalent",
          adaptation: "__ctrans_sum",
          targetSummary: "sum(xs)",
        });
        return this.helperCall("sum", lowered());
      }
      case "str": {
        if (args.length !== 1) break;
        this.ctx.record({
          span,
          sourceKind: "py.Call(str)",
          rule: "py.str→__ctrans.str",
          decision: "semantic",
          rationale: "Python str() uses Python spellings (True/None, sequence repr)",
          adaptation: "__ctrans_str",
          targetSummary: "str(x)",
        });
        return this.helperCall("str", lowered());
      }
      case "isinstance": {
        const target = args[1];
        const targetName =
          target !== undefined && target.kind === "Name"
            ? String(scalar(target, "id") ?? "")
            : null;
        if (targetName === null || BUILTIN_TYPE_NAMES.has(targetName)) {
          return this.unsupportedExpr(
            node,
            "py.Call(isinstance)",
            "isinstance against builtin types has no JS constructor equivalent (type-directed mapping arrives with the registry)",
          );
        }
        const text = `(${lowered()[0] ?? "undefined"} instanceof ${targetName})`;
        this.ctx.record({
          span,
          sourceKind: "py.Call(isinstance)",
          rule: "py.isinstance→js.instanceof",
          decision: "semantic",
          rationale: "instanceof covers user classes; builtin-type checks are unsupported",
          adaptation: "instanceof",
          targetSummary: text,
        });
        return text;
      }
      default:
        return null;
    }
    return this.unsupportedExpr(node, `py.Call(${name})`, "unsupported builtin arity");
  }

  private lowerDict(node: AstNode): string {
    const keys = kids(node, "keys");
    const values = kids(node, "values");
    const entries: string[] = [];
    let nonStringKey = false;
    keys.forEach((key, index) => {
      if (key === null) {
        entries.push(`...${this.lowerExpr(values[index]!)}`); // {**a, **b} spread
        return;
      }
      if (
        !(key.kind === "Constant" && typeof key.fields["value"] === "string") &&
        key.kind !== "Name"
      ) {
        nonStringKey = true;
      }
      entries.push(`[${this.lowerExpr(key)}]: ${this.lowerExpr(values[index]!)}`);
    });
    this.ctx.record({
      span: pySpan(node),
      sourceKind: "py.Dict",
      rule: "py.dict→js.object",
      decision: "semantic",
      rationale:
        "object keys are strings: non-string keys are coerced (Python allows any hashable key)",
      adaptation: "computed keys with documented coercion",
      warnings: nonStringKey ? [CTW_DICT_KEY_COERCION] : [],
      targetSummary: "object literal",
    });
    return `{ ${entries.join(", ")} }`;
  }

  private lowerJoinedStr(node: AstNode): string {
    const parts: string[] = [];
    let hasUnsupportedSpec = false;
    for (const value of kids(node, "values")) {
      if (value.kind === "Constant") {
        const text = value.fields["value"];
        if (typeof text === "string") parts.push(escapeTemplate(text));
        continue;
      }
      if (value.kind === "FormattedValue") {
        // CPython field names (bridge is source-shaped): format_spec is the JoinedStr
        // spec node (null = none); conversion is -1 when absent, else !s/!r/!a.
        const spec = kid(value, "format_spec");
        const conversion = value.fields["conversion"];
        const conversionActive = typeof conversion === "number" && conversion !== -1;
        if (spec !== null || conversionActive) {
          hasUnsupportedSpec = true;
          // Lower the inner value anyway so diagnostics flow for its subexpressions.
          this.lowerExpr(kid(value, "value")!);
          continue;
        }
        const valueNode = kid(value, "value")!;
        // Python f"{x}" interpolates str(x): bools print True/False, floats keep
        // Python's repr layout (100.0), None prints None. Statically float-typed
        // sites emit __ctrans_floatStr for the exact float layout.
        const lowered = this.exprIsFloat(valueNode)
          ? this.helperCall("floatStr", [this.lowerExpr(valueNode)])
          : this.helperCall("str", [this.lowerExpr(valueNode)]);
        parts.push(`\${${lowered}}`);
      }
    }
    if (hasUnsupportedSpec) {
      // Dropping a format spec would silently change output - unsupported, honestly.
      return this.unsupportedExpr(
        node,
        "py.JoinedStr(format-spec)",
        "format specifications (!r/!s/:format) are outside the M4 subset",
      );
    }
    this.ctx.record({
      span: pySpan(node),
      sourceKind: "py.JoinedStr",
      rule: "py.fstring→js.template",
      decision: "deterministic",
      rationale:
        "interpolation and literal text correspond; interpolations apply str() like Python (float-typed sites use the Python float layout)",
      targetSummary: "template literal",
    });
    return "`" + parts.join("") + "`";
  }

  private lowerSubscript(node: AstNode): string {
    const valueNode = kid(node, "value")!;
    const value = this.lowerExpr(valueNode);
    const slice = kid(node, "slice")!;
    const span = pySpan(node);
    // Statically typed receivers (str/list annotations, self fields) may use native
    // indexing; "unknown"-typed receivers go through the Python-semantics helpers
    // (TS cannot index unknown, and Python raises IndexError/KeyError, not undefined).
    const receiverTyped = this.memberAccessNative(valueNode);
    if (slice.kind === "Slice") {
      const lowerNode = kid(slice, "lower");
      const upperNode = kid(slice, "upper");
      const stepNode = kid(slice, "step");
      const constantBound = (candidate: AstNode | null): number | null => {
        if (candidate === null) return null;
        if (candidate.kind === "Constant") {
          const value2 = scalar(candidate, "value");
          return typeof value2 === "number" ? value2 : null;
        }
        return null;
      };
      const simplePositive =
        stepNode === null &&
        (lowerNode === null ||
          (constantBound(lowerNode) !== null && constantBound(lowerNode)! >= 0)) &&
        (upperNode === null ||
          (constantBound(upperNode) !== null && constantBound(upperNode)! >= 0));
      if (simplePositive && receiverTyped) {
        const lower = lowerNode === null ? undefined : String(constantBound(lowerNode));
        const upper = upperNode === null ? undefined : String(constantBound(upperNode));
        this.ctx.record({
          span,
          sourceKind: "py.Subscript(slice)",
          rule: "py.slice→js.slice",
          decision: "deterministic",
          rationale:
            "non-negative constant-bound slices map to Array/String.prototype.slice (receiver is statically typed)",
          targetSummary: `.slice(${lower ?? ""}, ${upper ?? ""})`,
        });
        return `${value}.slice(${lower ?? "0"}${upper !== undefined ? `, ${upper}` : ""})`;
      }
      this.ctx.record({
        span,
        sourceKind: "py.Subscript(slice)",
        rule: "py.slice→__ctrans.slice",
        decision: "semantic",
        rationale:
          stepNode !== null || !receiverTyped
            ? "negative bounds/steps have no JS equivalent, or the receiver type is unknown - __ctrans_slice reproduces Python clamping"
            : "negative bounds and steps have no JS equivalent",
        adaptation: "__ctrans_slice (clamping + step loop)",
        targetSummary: "slice(...)",
      });
      return this.helperCall("slice", [
        value,
        lowerNode === null ? "undefined" : this.lowerExpr(lowerNode),
        upperNode === null ? "undefined" : this.lowerExpr(upperNode),
        stepNode === null ? "undefined" : this.lowerExpr(stepNode),
      ]);
    }
    const isNumericScalar = slice.kind === "Constant" && typeof scalar(slice, "value") === "number";
    const nonNegativeLiteral = isNumericScalar && (scalar(slice, "value") as number) >= 0;
    const keyKind = slice.kind === "Name" ? this.receiverCommonType(slice) : null;
    const keyTyped =
      (slice.kind === "Constant" && typeof scalar(slice, "value") === "string") ||
      keyKind?.type.kind === "string";
    const receiverKindNamed = this.receiverCommonType(valueNode);
    // Provable native shapes: array/string receivers with non-negative constant
    // indices; record (dict) receivers with constant string keys. Everything else
    // keeps Python semantics via the index helper (negative indices → IndexError,
    // missing mapping keys → KeyError, out-of-range → IndexError).
    if (receiverTyped && nonNegativeLiteral) {
      this.ctx.record({
        span,
        sourceKind: "py.Subscript(index)",
        rule: "py.index→js.[]",
        decision: "deterministic",
        rationale: "non-negative constant index on a statically typed receiver",
        targetSummary: `${value}[${String(scalar(slice, "value"))}]`,
      });
      return `${value}[${String(scalar(slice, "value"))}]`;
    }
    if (receiverTyped && keyTyped && receiverKindNamed?.type.kind === "map") {
      this.ctx.record({
        span,
        sourceKind: "py.Subscript(index)",
        rule: "py.index→js.[]",
        decision: "semantic",
        rationale:
          "string-keyed dict lookups on statically typed mappings index natively; a missing key yields undefined instead of KeyError (documented divergence for typed lookups; dynamic lookups keep the KeyError helper)",
        adaptation: "native index (typed lookup)",
        targetSummary: `${value}[${this.lowerExpr(slice)}]`,
      });
      return `${value}[${this.lowerExpr(slice)}]`;
    }
    this.ctx.record({
      span,
      sourceKind: "py.Subscript(index)",
      rule: "py.index→__ctrans.index",
      decision: "semantic",
      rationale:
        "negative/out-of-range indices raise IndexError and mappings raise KeyError in Python while JS returns undefined; __ctrans_index reproduces both",
      adaptation: "__ctrans_index",
      targetSummary: "index(value, key)",
    });
    return this.helperCall("index", [value, this.lowerExpr(slice)]);
  }

  // Scope-declared CommonType of a name/attribute receiver, for type-directed choices.
  private receiverCommonType(node: AstNode | null): AnnotatedType | null {
    if (node === null) return null;
    if (node.kind === "Name") {
      return this.scopes.lookup(String(scalar(node, "id") ?? ""));
    }
    if (node.kind === "Attribute") {
      // The type the attribute VALUE denotes — for `self.<attr>` inside a method
      // body that is the class's collected field type (e.g. self.books -> array),
      // which drives method mappings, slicing, and iteration typing. The inner
      // receiver's own type (e.g. self -> class) is NOT the attribute's type.
      const parts: string[] = [];
      let current: AstNode | null = node;
      while (current !== null && current.kind === "Attribute") {
        parts.unshift(String(scalar(current, "attr") ?? ""));
        current = kid(current, "value");
      }
      if (current !== null && current.kind === "Name" && parts.length > 0) {
        const root = String(scalar(current, "id") ?? "");
        if (root === "self" || root === "cls") {
          return this.selfFieldTypes.get(parts[0]!) ?? null;
        }
      }
      return null;
    }
    return null;
  }

  private lowerSequenceComp(node: AstNode): string {
    const generators = kids(node, "generators");
    if (generators.length !== 1) {
      return this.unsupportedExpr(
        node,
        `py.${node.kind}(multi-for)`,
        "multi-for comprehensions are outside the M4 subset",
      );
    }
    const generator = generators[0]!;
    if (kids(generator, "ifs").length > 1) {
      return this.unsupportedExpr(
        node,
        `py.${node.kind}(multi-if)`,
        "multiple comprehension conditions are outside the M4 subset",
      );
    }
    const target = kid(generator, "target");
    const targetName =
      target !== null && target.kind === "Name" ? String(scalar(target, "id") ?? "") : null;
    if (targetName === null) {
      return this.unsupportedExpr(
        node,
        `py.${node.kind}(target)`,
        "non-name comprehension targets are outside the M4 subset",
      );
    }
    // PEP 709: the comprehension target lives in the enclosing scope for our
    // lowering; inherit the iterable's element type when statically known.
    const iterNode = kid(generator, "iter")!;
    this.declareIterationTarget(iterNode, targetName);
    const iterText = this.lowerExpr(iterNode);
    const reroute = this.comprehensionIterableText(iterNode, iterText);
    const element = this.lowerExpr(kid(node, "elt") ?? node);
    const condition = kids(generator, "ifs")[0] ?? null;
    this.ctx.useHelper("truthy");
    const filter =
      condition === null
        ? ""
        : `.filter((${targetName}) => __ctrans_truthy(${this.lowerExpr(condition)}))`;
    const kind = node.kind;
    const mapText = `${reroute ?? iterText}${filter}.map((${targetName}) => ${element})`;
    if (kind === "ListComp") {
      this.ctx.record({
        span: pySpan(node),
        sourceKind: "py.ListComp",
        rule: "py.listcomp→js.map/filter",
        decision: reroute === null ? "deterministic" : "semantic",
        rationale:
          reroute === null
            ? "single-for comprehension correspondence (order and filtering preserved)"
            : "single-for comprehension over a non-array iterable: Python iteration (dict keys, code points, any iterable) applied via a rerouted source sequence",
        adaptation: reroute === null ? null : "rerouted iterable",
        targetSummary: "map/filter chain",
      });
      return mapText;
    }
    if (kind === "SetComp") {
      this.ctx.record({
        span: pySpan(node),
        sourceKind: "py.SetComp",
        rule: "py.setcomp→js.Set(map)",
        decision: reroute === null ? "deterministic" : "semantic",
        rationale:
          reroute === null
            ? "set comprehension correspondence via Set of the mapped sequence"
            : "set comprehension over a non-array iterable: Python iteration applied via a rerouted source sequence",
        adaptation: reroute === null ? null : "rerouted iterable",
        targetSummary: "new Set(map chain)",
      });
      return `new Set(${mapText})`;
    }
    // GeneratorExp: eager evaluation diverges from Python laziness - documented.
    this.ctx.record({
      span: pySpan(node),
      sourceKind: "py.GeneratorExp",
      rule: "py.genexp→js.eager-map",
      decision: "semantic",
      rationale: "generator expressions are lazy in Python; the mapped array is eager",
      adaptation: "eager map",
      warnings: [CTW_GENERATOR_EAGER],
      targetSummary: "eager map chain",
    });
    return mapText;
  }

  private lowerDictComp(node: AstNode): string {
    const generators = kids(node, "generators");
    if (generators.length !== 1) {
      return this.unsupportedExpr(
        node,
        "py.DictComp(multi-for)",
        "multi-for comprehensions are outside the M4 subset",
      );
    }
    const generator = generators[0]!;
    if (kids(generator, "ifs").length > 1) {
      return this.unsupportedExpr(
        node,
        "py.DictComp(multi-if)",
        "multiple comprehension conditions are outside the M4 subset",
      );
    }
    const target = kid(generator, "target");
    const targetName =
      target !== null && target.kind === "Name" ? String(scalar(target, "id") ?? "") : null;
    if (targetName === null) {
      return this.unsupportedExpr(
        node,
        "py.DictComp(target)",
        "non-name comprehension targets are outside the M4 subset",
      );
    }
    this.declareIterationTarget(kid(generator, "iter"), targetName);
    const iterNode = kid(generator, "iter")!;
    const iterText = this.lowerExpr(iterNode);
    const reroute = this.comprehensionIterableText(iterNode, iterText);
    const key = this.lowerExpr(kid(node, "key") ?? node);
    const value = this.lowerExpr(kid(node, "value") ?? node);
    const condition = kids(generator, "ifs")[0] ?? null;
    this.ctx.useHelper("truthy");
    const filter =
      condition === null
        ? ""
        : `.filter((${targetName}) => __ctrans_truthy(${this.lowerExpr(condition)}))`;
    this.ctx.record({
      span: pySpan(node),
      sourceKind: "py.DictComp",
      rule: "py.dictcomp→js.fromEntries",
      decision: "semantic",
      rationale:
        reroute === null
          ? "dict comprehensions become Object.fromEntries over a mapped key/value pair sequence (string-keyed)"
          : "dict comprehensions become Object.fromEntries over a mapped key/value pair sequence (string-keyed); the non-array iterable is rerouted through Python iteration",
      adaptation:
        reroute === null ? "Object.fromEntries" : "Object.fromEntries + rerouted iterable",
      targetSummary: "Object.fromEntries(map chain)",
    });
    return `Object.fromEntries(${reroute ?? iterText}${filter}.map((${targetName}) => [${key}, ${value}]))`;
  }

  // Comprehensions lower to .map/.filter chains, which only exist on arrays. Python
  // iterates dicts (keys), strings (code points) and any iterable — the same
  // classification for-loops apply: known maps iterate Object.keys, strings and
  // statically unknown iterables go through __ctrans_iter. null keeps the native
  // chain (known arrays/sets, __ctrans_range results).
  private comprehensionIterableText(iterNode: AstNode, iterText: string): string | null {
    if (
      iterNode.kind === "Call" &&
      kid(iterNode, "func")?.kind === "Name" &&
      String(scalar(kid(iterNode, "func")!, "id") ?? "") === "range"
    ) {
      return null; // __ctrans_range results are arrays
    }
    const iterType = this.receiverCommonType(iterNode);
    if (iterType !== null && iterType.type.kind === "map") {
      return `Object.keys(${iterText})`;
    }
    if (
      iterType === null ||
      iterType.type.kind === "unknown" ||
      iterType.type.kind === "any" ||
      iterType.type.kind === "string"
    ) {
      return this.helperCall("iter", [iterText]);
    }
    return null;
  }

  // ---- statements -----------------------------------------------------------------

  lowerStmt(node: AstNode): void {
    switch (node.kind) {
      case "Expr": {
        const value = kid(node, "value");
        if (value === null) return;
        if (value.kind === "Constant" && typeof value.fields["value"] === "string") {
          this.emitDocstring(String(value.fields["value"]));
          return;
        }
        this.ctx.record({
          span: pySpan(node),
          sourceKind: "py.Expr",
          rule: "py.expr-stmt→js.expr-stmt",
          decision: "deterministic",
          rationale: "expression statement correspondence",
          targetSummary: "expression statement",
        });
        this.line(`${this.lowerExpr(value)};`);
        return;
      }
      case "Assign":
        this.lowerAssign(node);
        return;
      case "AnnAssign":
        this.lowerAnnAssign(node);
        return;
      case "AugAssign":
        this.lowerAugAssign(node);
        return;
      case "If":
        this.lowerIf(node);
        return;
      case "While": {
        if (kids(node, "orelse").length > 0) {
          this.unsupportedStmt(node, "py.While(else)", "while-else is outside the M4 subset");
          return;
        }
        // truthyTest already emits the __ctrans_truthy wrapper.
        const test = this.truthyTest(kid(node, "test")!, "py.While");
        this.ctx.record({
          span: pySpan(node),
          sourceKind: "py.While",
          rule: "py.while→js.while",
          decision: "deterministic",
          rationale: "loop correspondence (test uses Python truthiness)",
          targetSummary: "while loop",
        });
        this.block(`while (${test})`, () => {
          this.lowerBody(node, "body");
        });
        return;
      }
      case "For":
      case "AsyncFor":
        this.lowerFor(node);
        return;
      case "FunctionDef":
      case "AsyncFunctionDef":
        this.lowerFunctionDef(node);
        return;
      case "Return": {
        const value = kid(node, "value");
        this.ctx.record({
          span: pySpan(node),
          sourceKind: "py.Return",
          rule: "py.return→js.return",
          decision: "deterministic",
          rationale: "return correspondence",
          targetSummary: value === null ? "return;" : "return value;",
        });
        this.line(value === null ? "return;" : `return ${this.lowerExpr(value)};`);
        return;
      }
      case "Break":
        this.ctx.record({
          span: pySpan(node),
          sourceKind: "py.Break",
          rule: "py.break→js.break",
          decision: "deterministic",
          rationale: "break correspondence",
          targetSummary: "break;",
        });
        this.line("break;");
        return;
      case "Continue":
        this.ctx.record({
          span: pySpan(node),
          sourceKind: "py.Continue",
          rule: "py.continue→js.continue",
          decision: "deterministic",
          rationale: "continue correspondence",
          targetSummary: "continue;",
        });
        this.line("continue;");
        return;
      case "Pass":
        this.ctx.record({
          span: pySpan(node),
          sourceKind: "py.Pass",
          rule: "py.pass→omitted",
          decision: "deterministic",
          rationale: "pass is a syntactic placeholder with no behavior",
          targetSummary: "omitted",
        });
        this.line("// pass");
        return;
      case "Raise":
        this.lowerRaise(node);
        return;
      case "Try":
        this.lowerTry(node);
        return;
      case "TryStar":
        this.unsupportedStmt(
          node,
          "py.TryStar",
          "exception groups (except*) are outside the M4 subset",
        );
        return;
      case "With":
        this.lowerWith(node);
        return;
      case "AsyncWith":
        this.unsupportedStmt(
          node,
          "py.AsyncWith",
          "async context managers are outside the M4 subset",
        );
        return;
      case "ClassDef":
        this.lowerClassDef(node);
        return;
      case "Import":
      case "ImportFrom":
        this.ctx.record({
          span: pySpan(node),
          sourceKind: `py.${node.kind}`,
          rule: "py.import→module-prologue",
          decision: "deterministic",
          rationale: "imports are collected into the emitted module prologue",
          targetSummary: "moved to prologue",
        });
        this.declareImportBindings(node);
        return;
      case "Global":
      case "Nonlocal":
        this.ctx.record({
          span: pySpan(node),
          sourceKind: `py.${node.kind}`,
          rule: `py.${node.kind.toLowerCase()}→resolved-binding`,
          decision: "deterministic",
          rationale: "binding scope is handled by resolution; no JS statement is needed",
          targetSummary: "omitted",
        });
        return;
      case "Delete":
      case "Assert":
      case "Match":
        this.unsupportedStmt(node, `py.${node.kind}`, `${node.kind} is outside the M4 subset`);
        return;
      default:
        this.unsupportedStmt(
          node,
          `py.${node.kind}`,
          "statement is outside the supported M4 subset",
        );
    }
  }

  private emitDocstring(text: string): void {
    this.ctx.record({
      span: null,
      sourceKind: "py.Expr(docstring)",
      rule: "py.docstring→comment",
      decision: "deterministic",
      rationale: "docstrings are documentation, not behavior",
      targetSummary: "block comment",
    });
    this.line("/*");
    for (const docLine of text.split("\n")) this.line(` * ${docLine}`);
    this.line(" */");
  }

  private lowerBody(node: AstNode, key: string): void {
    for (const statement of kids(node, key)) this.lowerStmt(statement);
  }

  private block(header: string, body: () => void): void {
    this.line(`${header} {`);
    this.indent += 1;
    body();
    this.indent -= 1;
    this.line("}");
  }

  // Bound names of import statements become scope entries: namespace-style bindings
  // (import a.b / import a) are module-typed so member access lowers natively;
  // from-imports inherit their dep-module symbol kinds (classes/functions), other
  // values are honest unknowns.
  private declareImportBindings(node: AstNode): void {
    if (node.kind === "Import") {
      for (const alias of kids(node, "names")) {
        const asName = scalar(alias, "asname");
        const name = String(scalar(alias, "name") ?? "");
        const local = asName !== null ? String(asName) : name.split(".")[0]!;
        this.registerImportBinding(local, true, null);
      }
      return;
    }
    // ImportFrom: `from . import helper` and `from .helper import thing as t`.
    for (const alias of kids(node, "names")) {
      const local = String(scalar(alias, "asname") ?? scalar(alias, "name") ?? "");
      if (local === "") continue;
      // `from package import module` binds a module object when the imported name is
      // itself a project module (the graph resolved this earlier); approximate M4.
      this.registerImportBinding(local, false, this.importedKinds.get(local) ?? null);
    }
  }

  private registerImportBinding(
    local: string,
    isModuleObject: boolean,
    symbolKind: "class" | "function" | null,
  ): void {
    if (isModuleObject) {
      this.scopes.declare(local, {
        type: { kind: "module", name: local },
        origin: "explicit",
        confidence: "exact",
        span: null,
      });
      return;
    }
    if (symbolKind === "class") {
      this.scopes.declare(local, {
        type: { kind: "class", name: local },
        origin: "inferred",
        confidence: "exact",
        span: null,
      });
      return;
    }
    if (symbolKind === "function") {
      this.scopes.declare(local, {
        type: { kind: "function", paramTypes: [], returnType: UNKNOWN, async: false },
        origin: "inferred",
        confidence: "exact",
        span: null,
      });
      return;
    }
    this.scopes.declare(local, annotateUnknown());
  }

  private lowerAssign(node: AstNode): void {
    const targets = kids(node, "targets");
    const valueNode = kid(node, "value");
    const span = pySpan(node);

    // Tuple targets: parallel assignment (a, b = b, a) or sequence unpacking
    // (a, b = f()). Elements evaluate once, then bind left-to-right.
    if (
      targets.length === 1 &&
      (targets[0]!.kind === "Tuple" || targets[0]!.kind === "List") &&
      valueNode !== null
    ) {
      const targetNode = targets[0]!;
      const elements = kids(targetNode!, "elts");
      const parallelTuple = valueNode.kind === "Tuple";
      const valueTexts = parallelTuple
        ? kids(valueNode, "elts").map((element) => this.lowerExpr(element))
        : [this.lowerExpr(valueNode)];
      const assignable = elements.every(
        (element) =>
          element.kind === "Name" ||
          element.kind === "Tuple" ||
          element.kind === "List" ||
          element.kind === "Attribute" ||
          element.kind === "Subscript",
      );
      if (!assignable || (parallelTuple && elements.length !== valueTexts.length)) {
        // Mismatched arity (a, b = 1) or starred/other patterns rely on Python tuple
        // iteration semantics — outside the M4 subset.
        this.unsupportedStmt(
          node,
          "py.Assign(tuple-target)",
          "tuple assignment target is outside the supported M4 subset",
        );
        return;
      }
      // Declared status must be captured BEFORE binding the target names. Leaves
      // whose first binding happens in this nested block are hoisted first so the
      // emitted destructure is a rebinding, not a block-scoped declaration.
      const leafNames = collectLeafNames(targetNode);
      // Snapshot for nested-pattern arms: by element-emission time the parent has
      // declared every leaf, so nested-fresh detection must use this snapshot.
      const preDeclared = new Set(leafNames.filter((name) => this.isDeclared(name)));
      // D-006 bigint mode: a parallel assignment whose elements are all provable
      // ints binds int-typed names — the rebind idiom (a, b = b, a + b) then
      // lowers to exact native bigint operators.
      const bigintIntTuple =
        this.ctx.intMode === "bigint" &&
        parallelTuple &&
        valueNode !== null &&
        kids(valueNode, "elts").every((element) => this.exprIsInt(element));
      for (const name of leafNames) {
        if (!this.isDeclared(name) && this.bindingRequiresHoist(name)) {
          this.hoistBinding(name, null);
        }
      }
      const declared = leafNames.filter((name) => this.isDeclared(name));
      for (const name of leafNames) {
        this.scopes.declare(
          name,
          bigintIntTuple
            ? {
                type: { kind: "number", numberKind: "int" },
                origin: "inferred",
                confidence: "approximate",
                span: null,
              }
            : annotateUnknown(),
        );
        this.declareLocally(name);
      }
      // Parallel assignment packs the value elements into one tuple; unpacking has a
      // single iterable expression.
      const rhsText = parallelTuple ? `[${valueTexts.join(", ")}]` : valueTexts[0]!;
      const rule = parallelTuple ? "py.parallel-assign→js.destructure" : "py.unpack→js.destructure";
      if (leafNames.length === 0) {
        // Member/index targets only: plain destructuring assignment is sound.
        this.ctx.record({
          span,
          sourceKind: "py.Assign(tuple-target)",
          rule,
          decision: "deterministic",
          rationale:
            "tuple-target assignment maps to array destructuring (single RHS evaluation preserved)",
          targetSummary: "destructuring assignment",
        });
        // Parenthesized: a statement starting with `[` parses as an array literal.
        this.line(`(${destructurePattern(targetNode, this)} = ${rhsText});`);
        return;
      }
      if (
        declared.length === leafNames.length &&
        declared.length > 0 &&
        isNamePattern(targetNode)
      ) {
        // All leaves already bound: plain destructuring assignment rebinds
        // left-to-right after one RHS evaluation (the swap idiom included).
        this.ctx.record({
          span,
          sourceKind: "py.Assign(tuple-target)",
          rule,
          decision: "deterministic",
          rationale: "all-targets-declared parallel assignment rebinds via destructuring",
          targetSummary: "destructuring assignment",
        });
        this.line(`${destructurePattern(targetNode, this)} = ${rhsText};`);
        return;
      }
      if (declared.length === 0 && isNamePattern(targetNode)) {
        // Every leaf is a fresh Name: let-destructuring binds them in one statement.
        // Unpack bindings from a statically typed sequence inherit its element type;
        // everything else (parallel tuples rebinding by construction, unknown RHS)
        // declares `unknown` so dynamic rebinding stays legal (a, b = b, a + b).
        const rhsElementKnown =
          !parallelTuple &&
          valueNode !== null &&
          valueNode.kind === "Name" &&
          (() => {
            const hit = this.scopes.lookup(String(scalar(valueNode, "id") ?? ""));
            return (
              hit !== null &&
              (hit.type.kind === "array" || hit.type.kind === "set") &&
              hit.type.elementType.kind !== "unknown"
            );
          })();
        // D-006 bigint mode: a parallel assignment whose elements are all provable
        // ints binds bigint-typed names — the rebind idiom (a, b = b, a + b) then
        // lowers to exact native bigint operators.
        const bigintIntTuple =
          this.ctx.intMode === "bigint" &&
          parallelTuple &&
          kids(valueNode!, "elts").every((element) => this.exprIsInt(element));
        const unpackAnnotation =
          !rhsElementKnown && this.ctx.target === "typescript"
            ? bigintIntTuple
              ? ": bigint[]"
              : ": unknown[]"
            : "";
        this.ctx.record({
          span,
          sourceKind: "py.Assign(tuple-target)",
          rule,
          decision: "deterministic",
          rationale: "tuple-target assignment maps to destructuring (fresh bindings)",
          targetSummary: "let destructuring",
        });
        this.line(`let ${destructurePattern(targetNode, this)}${unpackAnnotation} = ${rhsText};`);
        return;
      }
      if (declared.length === 0) {
        // Fresh names mixed with member/index targets: bind per element from one temp
        // (JS let-destructuring requires simple identifier patterns).
        const tmp = this.freshTemp("__ctrans_unpack");
        this.ctx.record({
          span,
          sourceKind: "py.Assign(tuple-target)",
          rule,
          decision: "semantic",
          rationale:
            "member/index targets mixed with fresh names: single RHS evaluation via temp, then per-element binding",
          adaptation: "temp + per-element binding",
          targetSummary: "temp + per-element binding",
        });
        this.line(`const ${tmp} = ${rhsText};`);
        elements.forEach((element, index) => {
          this.emitUnpackElement(element, `${tmp}[${String(index)}]`, preDeclared);
        });
        return;
      }
      // Mixed fresh/existing (or member) targets: bind per element from one temp —
      // JS let-destructuring cannot redeclare, and Python rebinds left-to-right.
      const tmp = this.freshTemp("__ctrans_unpack");
      this.ctx.record({
        span,
        sourceKind: "py.Assign(tuple-target)",
        rule,
        decision: "semantic",
        rationale:
          "mixed fresh/existing binding targets: single RHS evaluation via temp, then per-element binding (rebinding left-to-right like Python)",
        adaptation: "temp + per-element binding",
        targetSummary: "temp + per-element binding",
      });
      this.line(`const ${tmp} = ${rhsText};`);
      elements.forEach((element, index) => {
        this.emitUnpackElement(element, `${tmp}[${String(index)}]`, preDeclared);
      });
      return;
    }

    const value = valueNode === null ? "undefined" : this.lowerExpr(valueNode);
    const initType = valueNode === null ? null : this.valueAnnotatedType(valueNode);
    // WS F: `response = requests.get(...)` (now `await fetch(...)`) marks the
    // target for the documented response-surface mapping.
    if (value.includes("await fetch(")) {
      for (const target of targets) {
        if (target.kind === "Name") this.fetchAssigned.add(String(scalar(target, "id") ?? ""));
      }
    }
    for (const target of targets) {
      this.lowerAssignTarget(target, value, initType, valueNode);
    }
  }

  // One element of a tuple-target assignment from an already-evaluated temp slot.
  // preDeclared carries the leaves that were bound BEFORE this statement — the
  // parent declares every leaf up front, so isDeclared alone cannot distinguish
  // fresh nested names (a nested `let` here would shadow, a plain assignment
  // would be a TDZ error).
  private emitUnpackElement(
    element: AstNode,
    valueText: string,
    preDeclared: ReadonlySet<string> = new Set(),
  ): void {
    if (element.kind === "Name") {
      const name = String(scalar(element, "id") ?? "");
      const first = !this.isDeclared(name);
      if (first && this.bindingRequiresHoist(name)) {
        this.hoistBinding(name, null);
        this.line(`${name} = ${valueText};`);
        return;
      }
      this.declareLocally(name);
      this.line(`${first ? "let " : ""}${name} = ${valueText};`);
      return;
    }
    if (element.kind === "Tuple" || element.kind === "List") {
      const nestedLeaves = collectLeafNames(element);
      // preDeclared is authoritative here: the parent already declared every Name
      // leaf of this statement, so isDeclared is true for fresh names too.
      const nestedFresh = nestedLeaves.filter((name) => !preDeclared.has(name));
      if (nestedFresh.length === 0) {
        this.line(`${destructurePattern(element, this)} = ${valueText};`);
      } else if (nestedFresh.length === nestedLeaves.length && isNamePattern(element)) {
        this.line(`let ${destructurePattern(element, this)} = ${valueText};`);
      } else if (nestedFresh.length === nestedLeaves.length) {
        // Fully fresh nested pattern with member targets: bind through one temp per
        // layer (JS let-destructuring requires simple identifiers).
        const nestedTemp = this.freshTemp("__ctrans_unpack");
        this.line(`const ${nestedTemp} = ${valueText};`);
        kids(element, "elts").forEach((child, index) => {
          this.emitUnpackElement(child, `${nestedTemp}[${String(index)}]`);
        });
      } else {
        // Mixed fresh/existing inside a nested pattern: Python rebinds each name;
        // mixed-arity JS destructuring without temporary binding is not expressible.
        this.unsupportedStmt(
          element,
          "py.Assign(nested-pattern)",
          "nested tuple target mixes new and existing bindings",
        );
        return;
      }
      return;
    }
    // Attribute/Subscript element targets: writes go through the assigning forms —
    // lowerExpr would emit a READ (`__ctrans_index(...)`), which is not an lvalue.
    if (element.kind === "Attribute") {
      const receiverNode = kid(element, "value")!;
      const attrName = String(scalar(element, "attr") ?? "");
      const receiverText = this.lowerExpr(receiverNode);
      if (this.memberAccessNative(receiverNode)) {
        this.line(`${receiverText}.${attrName} = ${valueText};`);
      } else {
        this.line(
          `${this.helperCall("setattr", [receiverText, JSON.stringify(attrName), valueText])};`,
        );
      }
      return;
    }
    if (element.kind === "Subscript") {
      const receiverNode = kid(element, "value")!;
      const keyNode = kid(element, "slice")!;
      const receiverText = this.lowerExpr(receiverNode);
      const keyText = this.lowerExpr(keyNode);
      if (this.memberAccessNative(receiverNode) && keyNode.kind === "Constant") {
        this.line(`${receiverText}[${keyText}] = ${valueText};`);
      } else {
        this.line(`${this.helperCall("setIndex", [receiverText, keyText, valueText])};`);
      }
      return;
    }
    const targetText = this.lowerExpr(element);
    this.line(`${targetText} = ${valueText};`);
  }

  private freshTemp(base: string): string {
    this.tempCounter += 1;
    return `${base}_${String(this.tempCounter)}`;
  }

  // Declares an iteration target (for-loop / comprehension variable) in scope,
  // inheriting the element type of a statically typed array/set iterable (dict keys
  // iterate as strings via Object.keys) so element arithmetic lowers natively. Call
  // BEFORE lowering the loop body.
  private declareIterationTarget(iterNode: AstNode | null, targetName: string): void {
    const iterName =
      iterNode !== null && iterNode.kind === "Name" ? String(scalar(iterNode, "id") ?? "") : null;
    const iterType = iterName === null ? null : this.scopes.lookup(iterName);
    if (iterType !== null && iterType.type.kind === "map") {
      this.scopes.declare(targetName, {
        type: { kind: "string" },
        origin: "inferred",
        confidence: "approximate",
        span: null,
      });
      return;
    }
    if (iterType !== null && (iterType.type.kind === "array" || iterType.type.kind === "set")) {
      const elementType = iterType.type.elementType;
      this.scopes.declare(
        targetName,
        elementType.kind === "unknown"
          ? annotateUnknown()
          : { type: elementType, origin: "inferred", confidence: "approximate", span: null },
      );
      return;
    }
    this.scopes.declare(targetName, annotateUnknown());
  }

  private lowerAssignTarget(
    target: AstNode,
    value: string,
    initType: AnnotatedType | null,
    valueNode: AstNode | null,
  ): void {
    if (target.kind === "Name") {
      const name = String(scalar(target, "id") ?? "");
      const first = !this.isDeclared(name);
      const hoist = first && this.bindingRequiresHoist(name);
      if (hoist) this.hoistBinding(name, null);
      else this.declareLocally(name);
      this.scopes.declare(name, initType ?? annotateUnknown());
      const exportPrefix = this.exportedNames.has(name) && this.indent === 0 ? "export " : "";
      const letTypeSuffix = hoist ? "" : this.freshLetTypeSuffix(first ? valueNode : null);
      this.ctx.record({
        span: pySpan(target),
        sourceKind: "py.Assign",
        rule: "py.assign→js.let/assign",
        decision: "deterministic",
        rationale: hoist
          ? "first binding inside a nested block: the declaration is hoisted to the Python scope top (Python binds at function/module scope)"
          : first
            ? "binding declared with let (Python bindings are rebindable)"
            : "rebinding assignment",
        targetSummary: `${name} = ...`,
      });
      this.line(
        `${exportPrefix}${hoist ? "" : first ? "let " : ""}${name}${hoist ? "" : letTypeSuffix} = ${value};`,
      );
      return;
    }
    if (target.kind === "Attribute") {
      const receiverNode = kid(target, "value")!;
      const attrName = String(scalar(target, "attr") ?? "");
      const receiverText = this.lowerExpr(receiverNode);
      if (this.memberAccessNative(receiverNode)) {
        this.ctx.record({
          span: pySpan(target),
          sourceKind: "py.Assign(member)",
          rule: "py.member-assign→js.member-assign",
          decision: "deterministic",
          rationale: "member assignment correspondence (statically typed receiver)",
          targetSummary: `${receiverText}.${attrName} = ...`,
        });
        this.line(`${receiverText}.${attrName} = ${value};`);
        return;
      }
      this.ctx.record({
        span: pySpan(target),
        sourceKind: "py.Assign(member)",
        rule: "py.member-assign→__ctrans.setattr",
        decision: "semantic",
        rationale:
          "receiver type is statically unknown; TS cannot assign members of unknown and Python raises AttributeError on invalid receivers",
        adaptation: "__ctrans_setattr",
        targetSummary: `setattr(${receiverText}, "${attrName}", ...)`,
      });
      this.line(`${this.helperCall("setattr", [receiverText, JSON.stringify(attrName), value])};`);
      return;
    }
    if (target.kind === "Subscript") {
      const receiverNode = kid(target, "value")!;
      const keyNode = kid(target, "slice")!;
      if (keyNode.kind === "Slice") {
        this.unsupportedStmt(
          target,
          "py.Assign(subscript-slice)",
          "slice assignment is outside the M4 subset",
        );
        return;
      }
      const receiverText = this.lowerExpr(receiverNode);
      const keyText = this.lowerExpr(keyNode);
      if (this.memberAccessNative(receiverNode) && keyNode.kind === "Constant") {
        this.ctx.record({
          span: pySpan(target),
          sourceKind: "py.Assign(subscript)",
          rule: "py.subscript-assign→js.index-assign",
          decision: "deterministic",
          rationale: "subscript assignment correspondence (statically typed receiver)",
          targetSummary: `${receiverText}[${keyText}] = ...`,
        });
        this.line(`${receiverText}[${keyText}] = ${value};`);
        return;
      }
      this.ctx.record({
        span: pySpan(target),
        sourceKind: "py.Assign(subscript)",
        rule: "py.subscript-assign→__ctrans.setIndex",
        decision: "semantic",
        rationale:
          "receiver type or key is statically unknown; Python raises IndexError/TypeError for invalid stores while JS silently extends",
        adaptation: "__ctrans_setIndex",
        targetSummary: "setIndex(receiver, key, value)",
      });
      this.line(`${this.helperCall("setIndex", [receiverText, keyText, value])};`);
      return;
    }
    this.unsupportedStmt(
      target,
      `py.Assign(${target.kind})`,
      "assignment target is outside the M4 subset",
    );
  }

  private lowerAnnAssign(node: AstNode): void {
    const target = kid(node, "target");
    const annotation = kid(node, "annotation");
    const valueNode = kid(node, "value");
    if (target === null || target.kind !== "Name" || annotation === null) {
      this.unsupportedStmt(
        node,
        "py.AnnAssign",
        "annotated assignment target is outside the M4 subset",
      );
      return;
    }
    const name = String(scalar(target, "id") ?? "");
    const tsType =
      this.ctx.target === "typescript"
        ? (tsTypeFromAnnotation(annotation, this.ctx.intMode) ?? "unknown")
        : null;
    this.scopes.declare(name, this.declaredType(annotation));
    const first = !this.isDeclared(name);
    const hoist = first && this.bindingRequiresHoist(name);
    if (hoist) this.hoistBinding(name, tsType);
    else this.declareLocally(name);
    const exportPrefix = this.exportedNames.has(name) && this.indent === 0 ? "export " : "";
    this.ctx.record({
      span: pySpan(node),
      sourceKind: "py.AnnAssign",
      rule: "py.annassign→js.typed-let",
      decision: tsTypeFromAnnotation(annotation) === null ? "semantic" : "deterministic",
      rationale:
        tsTypeFromAnnotation(annotation) === null
          ? "annotation is outside the mappable subset - emitted as `unknown` rather than inventing a type"
          : "annotation maps to a TypeScript type annotation",
      adaptation: tsTypeFromAnnotation(annotation) === null ? "type unknown (documented)" : null,
      targetSummary: `let ${name}: ${tsType}`,
    });
    const typeSuffix = tsType === null ? "" : `: ${tsType}`;
    const valueText = valueNode === null ? "" : ` = ${this.lowerExpr(valueNode)}`;
    this.line(
      `${exportPrefix}${hoist ? "" : first ? "let " : ""}${name}${hoist ? "" : typeSuffix}${valueText};`,
    );
  }

  private lowerAugAssign(node: AstNode): void {
    const target = kid(node, "target");
    const operator = kid(node, "op")!.kind;
    const value = this.lowerExpr(kid(node, "value")!);
    if (
      target === null ||
      (target.kind !== "Name" && target.kind !== "Attribute" && target.kind !== "Subscript")
    ) {
      this.unsupportedStmt(
        node,
        "py.AugAssign",
        "augmented assignment target is outside the M4 subset",
      );
      return;
    }
    const span = pySpan(node);

    // Read/write pair for the target: dynamically typed receivers must read and write
    // through the __ctrans accessors (getattr/setattr/index/setIndex).
    let read: string;
    let readKind: "number" | "string" | "array" | null;
    let write: (newValue: string) => string;
    if (target.kind === "Name") {
      const name = String(scalar(target, "id") ?? "");
      const hit = this.scopes.lookup(name);
      read = name;
      readKind =
        hit?.type.kind === "number"
          ? "number"
          : hit?.type.kind === "string"
            ? "string"
            : hit?.type.kind === "array" || hit?.type.kind === "set"
              ? "array"
              : null;
      write = (newValue) => `${name} = ${newValue}`;
    } else if (target.kind === "Attribute") {
      readKind = this.inferOperandKind(target);
      const receiverNode = kid(target, "value")!;
      const attrName = String(scalar(target, "attr") ?? "");
      const receiverText = this.lowerExpr(receiverNode);
      if (this.memberAccessNative(receiverNode)) {
        read = `${receiverText}.${attrName}`;
        write = (newValue) => `${receiverText}.${attrName} = ${newValue}`;
      } else {
        read = this.helperCall("getattr", [receiverText, JSON.stringify(attrName)]);
        write = (newValue) =>
          this.helperCall("setattr", [receiverText, JSON.stringify(attrName), newValue]);
      }
    } else {
      readKind = null;
      const receiverNode = kid(target, "value")!;
      const keyNode = kid(target, "slice")!;
      const receiverText = this.lowerExpr(receiverNode);
      const keyText = this.lowerExpr(keyNode);
      const nativeStore =
        this.memberAccessNative(receiverNode) &&
        keyNode.kind === "Constant" &&
        this.keyofScalar(keyNode) !== null;
      if (nativeStore) {
        read = `${receiverText}[${keyText}]`;
        write = (newValue) => `${receiverText}[${keyText}] = ${newValue}`;
      } else {
        read = this.helperCall("index", [receiverText, keyText]);
        write = (newValue) => this.helperCall("setIndex", [receiverText, keyText, newValue]);
      }
    }

    const directOps: Record<string, string> = {
      Add: "+",
      Sub: "-",
      Pow: "**",
      BitOr: "|",
      BitAnd: "&",
      BitXor: "^",
      LShift: "<<",
      RShift: ">>",
    };
    const helperOps: Record<string, string> = {
      FloorDiv: "floorDiv",
      Mod: "mod",
      Div: "div",
      Mult: "mul",
    };
    // Mult on a proven numeric/string read lowers natively (idiomatic); dynamic
    // reads keep the helper (Python repetition/multiplication duality).
    if (operator === "Mult" && (readKind === "number" || readKind === "string")) {
      if (readKind === "number") {
        this.ctx.record({
          span,
          sourceKind: "py.AugAssign(Mult)",
          rule: "py.augassign→js.augassign",
          decision: "deterministic",
          rationale: "numeric augmented multiplication correspondence",
          targetSummary: `${read} *= ...`,
        });
        this.line(write(`${read} * ${value}`));
        return;
      }
      this.ctx.record({
        span,
        sourceKind: "py.AugAssign(Mult)",
        rule: "py.augassign→js.repeat",
        decision: "semantic",
        rationale: "string repetition has no JS compound operator; helper applies Python semantics",
        adaptation: "__ctrans_mul",
        targetSummary: `${read} = __ctrans_mul(...)`,
      });
      this.line(write(`${this.helperCall("mul", [read, value])}`));
      return;
    }
    // Dynamically typed values cannot use JS compound operators (unknown operands are
    // not TS-expressible and Python semantics diverge) — route through helpers.
    const nativeEligible = readKind !== null;
    const jsOperator = directOps[operator];
    if (nativeEligible && operator === "Add" && readKind === "array") {
      // Python list concatenation: array spread concat (statically typed sequences).
      this.ctx.record({
        span,
        sourceKind: "py.AugAssign(Add)",
        rule: "py.add-sequences→js.spread-concat",
        decision: "deterministic",
        rationale: "list concatenation corresponds to array spread concat",
        targetSummary: `${read} = [...${read}, ...]`,
      });
      this.line(write(`[...${read}, ...${value}]`));
      return;
    }
    if (helperOps[operator] !== undefined) {
      const helper = helperOps[operator]!;
      const rationales: Record<string, string> = {
        FloorDiv: "floor division via helper",
        Mod: "Python modulo sign semantics via helper",
        Div: "ZeroDivisionError preservation",
        Mult: "string repetition + numeric multiplication share the helper",
      };
      this.ctx.record({
        span,
        sourceKind: `py.AugAssign(${operator})`,
        rule: `py.${operator.toLowerCase()}-assign→__ctrans.${helper}`,
        decision: "semantic",
        rationale: rationales[operator]!,
        adaptation: `__ctrans_${helper}`,
        targetSummary: `${write("__ctrans_" + helper + "(...)")}`,
      });
      this.line(write(`${this.helperCall(helper, [read, value])}`));
      return;
    }
    if (jsOperator === undefined) {
      this.unsupportedStmt(node, `py.AugAssign(${operator})`, "unsupported augmented operator");
      return;
    }
    if (nativeEligible) {
      const bitwise = !["+", "-", "**"].includes(jsOperator);
      this.ctx.record({
        span,
        sourceKind: `py.AugAssign(${operator})`,
        rule: "py.augassign→js.augassign",
        decision: bitwise ? "semantic" : "deterministic",
        rationale: bitwise
          ? "JS bitwise coerces to int32 (D-006 warning)"
          : "augmented assignment correspondence (compound operator on a typed target)",
        warnings: bitwise ? [CTW_NUM_BITWISE] : [],
        targetSummary: `${read} ${jsOperator}= ...`,
      });
      // Typed reads are simple lvalues (names or member chains) — the compound
      // operator is idiomatic and evaluates the target once.
      this.line(`${read} ${jsOperator}= ${value};`);
      return;
    }
    // Dynamic operands: top-level Python semantics helpers per operator.
    const dynamicHelpers: Record<string, string> = {
      Add: "add",
      Sub: "sub",
      Pow: "pow",
      BitOr: "bitOr",
      BitAnd: "bitAnd",
      BitXor: "bitXor",
      LShift: "lShift",
      RShift: "rShift",
    };
    const dynamicHelper = dynamicHelpers[operator];
    if (dynamicHelper === undefined) {
      this.unsupportedStmt(node, `py.AugAssign(${operator})`, "unsupported augmented operator");
      return;
    }
    this.ctx.record({
      span,
      sourceKind: `py.AugAssign(${operator})`,
      rule: `py.augassign→__ctrans.${dynamicHelper}`,
      decision: "semantic",
      rationale:
        "target value is statically unknown; JS compound operators would coerce or fail to compile - the helper preserves Python operand rules",
      adaptation: `__ctrans_${dynamicHelper} + reassignment`,
      warnings: operator.startsWith("Bit") || operator.endsWith("Shift") ? [CTW_NUM_BITWISE] : [],
      targetSummary: `${read} = __ctrans_${dynamicHelper}(${read}, ...)`,
    });
    this.line(write(`${this.helperCall(dynamicHelper, [read, value])}`));
  }

  // Scalar number text of a constant node, or null (used for native store checks).
  private keyofScalar(node: AstNode): number | null {
    const value = scalar(node, "value");
    return typeof value === "number" ? value : null;
  }

  // Conservative provability analysis (D-016): native JS truthiness equals Python's
  // exactly for booleans, null/undefined, strings, bigint, and NON-NaN numbers
  // (Python ints cannot be NaN). Everything else — unknown values, plain-number
  // bindings (NaN diverges), arrays/maps/sets/objects (empty containers are falsy
  // in Python, truthy in JS) — keeps the __ctrans_truthy helper.
  private nativeTruthyProvable(node: AstNode): boolean {
    switch (node.kind) {
      case "Constant": {
        const value = node.fields["value"];
        if (value === null) return true; // None -> undefined: falsy in both
        if (typeof value === "boolean") return true;
        if (typeof value === "string") return true;
        if (typeof value === "number") {
          // Integer literals (and float literals) are never NaN.
          return Number.isNaN(value) === false;
        }
        return false;
      }
      case "Name": {
        const hit = this.scopes.lookup(String(scalar(node, "id") ?? ""));
        if (hit === null) return false;
        if (hit.type.kind === "boolean" || hit.type.kind === "string" || hit.type.kind === "null") {
          return true;
        }
        if (hit.type.kind === "number") {
          // Python int cannot be NaN; a plain float may be.
          return hit.type.numberKind === "int";
        }
        return false;
      }
      case "Compare":
        // Comparison results are booleans in both languages.
        return true;
      case "UnaryOp":
        return (
          kid(node, "op")!.kind === "Not" && this.nativeTruthyProvable(kid(node, "operand") ?? node)
        );
      case "BoolOp":
        return kids(node, "values").every((operand) => this.nativeTruthyProvable(operand));
      case "Await":
        return this.nativeTruthyProvable(kid(node, "value") ?? node);
      default:
        return false;
    }
  }

  private truthyTest(testNode: AstNode, sourceKind: string): string {
    const test = this.lowerExpr(testNode);
    if (this.nativeTruthyProvable(testNode)) {
      // Provably equivalent: native condition, no helper (D-016 provability).
      this.ctx.record({
        span: pySpan(testNode),
        sourceKind,
        rule: "py.test→js.native",
        decision: "deterministic",
        rationale:
          "statically provable that JS truthiness equals Python truthiness for this expression (boolean/string/null/int/bigint/comparison)",
        targetSummary: "native test",
      });
      return `(${test})`;
    }
    this.ctx.useHelper("truthy");
    this.ctx.record({
      span: pySpan(testNode),
      sourceKind,
      rule: "py.test→js.truthy",
      decision: "semantic",
      rationale: "Python truthiness (NaN, [], {}) differs from JS coercion",
      adaptation: "test wrapped in __ctrans_truthy",
      targetSummary: "truthy(test)",
    });
    return `__ctrans_truthy(${test})`;
  }

  private lowerIf(node: AstNode): void {
    const test = this.truthyTest(kid(node, "test")!, "py.If");
    this.ctx.record({
      span: pySpan(node),
      sourceKind: "py.If",
      rule: "py.if→js.if",
      decision: "deterministic",
      rationale:
        "branching correspondence (elif chains become nested else-blocks - semantically identical)",
      targetSummary: "if/else",
    });
    this.line(`if (${test}) {`);
    this.indent += 1;
    this.lowerBody(node, "body");
    this.indent -= 1;
    const orelse = kids(node, "orelse");
    if (orelse.length > 0) {
      this.line("} else {");
      this.indent += 1;
      for (const statement of orelse) this.lowerStmt(statement);
      this.indent -= 1;
    }
    this.line("}");
  }

  private lowerFor(node: AstNode): void {
    if (kids(node, "orelse").length > 0) {
      this.unsupportedStmt(node, `py.${node.kind}(else)`, "for-else is outside the M4 subset");
      return;
    }
    if (node.kind === "AsyncFor") {
      this.unsupportedStmt(node, "py.AsyncFor", "async for is outside the M4 subset");
      return;
    }
    const target = kid(node, "target");
    const iter = kid(node, "iter")!;
    const span = pySpan(node);
    const targetName =
      target !== null && target.kind === "Name" ? String(scalar(target, "id") ?? "") : null;
    if (targetName === null) {
      this.unsupportedStmt(
        node,
        "py.For(target)",
        "tuple-unpacking loop targets are outside the M4 subset",
      );
      return;
    }
    // D-006 bigint mode: C-style range counters are Python ints (bigint).
    this.scopes.declare(targetName, annotateUnknown());
    this.declareLocally(targetName);

    if (
      iter.kind === "Call" &&
      kid(iter, "func")?.kind === "Name" &&
      scalar(kid(iter, "func")!, "id") === "range"
    ) {
      const rangeArgs = kids(iter, "args");
      const step = rangeArgs[2] !== undefined ? scalar(rangeArgs[2], "value") : null;
      // C-style loops need statically numeric bounds; anything else materializes via
      // the range helper (which also validates integer-ness like Python).
      const argsNumeric =
        rangeArgs.length > 0 &&
        rangeArgs.length <= 3 &&
        rangeArgs.every((arg) => this.inferOperandKind(arg) === "number");
      if ((rangeArgs.length <= 2 || step === 1) && argsNumeric) {
        // D-006 bigint mode: the C-style counter is a bigint so the loop variable
        // stays a Python int (i++ is a valid bigint increment).
        const zeroLiteral = this.ctx.intMode === "bigint" ? "0n" : "0";
        const [startText, endText] =
          rangeArgs.length === 1
            ? [zeroLiteral, this.lowerExpr(rangeArgs[0]!)]
            : [this.lowerExpr(rangeArgs[0]!), this.lowerExpr(rangeArgs[1] ?? rangeArgs[0]!)];
        this.ctx.record({
          span,
          sourceKind: "py.For(range)",
          rule: "py.for-range→js.c-style-for",
          decision: "deterministic",
          rationale: "unit-step range loops map to C-style for loops (bounds statically numeric)",
          targetSummary: "for (let i = ...; i < ...; i++)",
        });
        if (this.ctx.intMode === "bigint") {
          this.scopes.declare(targetName, {
            type: { kind: "number", numberKind: "int" },
            origin: "inferred",
            confidence: "approximate",
            span: null,
          });
        }
        this.block(
          `for (let ${targetName} = ${startText}; ${targetName} < ${endText}; ${targetName}++)`,
          () => {
            this.lowerBody(node, "body");
          },
        );
        return;
      }
      // D-006 bigint mode: materialized range elements are Python ints (bigints).
      const rangeHelper = this.ctx.intMode === "bigint" ? "rangeBig" : "range";
      this.ctx.useHelper(rangeHelper);
      this.ctx.record({
        span,
        sourceKind: "py.For(range,step)",
        rule: `py.for-range→__ctrans.${rangeHelper}`,
        decision: "semantic",
        rationale:
          "stepped or dynamically bounded range materializes via helper (Python range is lazy; the helper validates integer-ness)",
        adaptation: `__ctrans_${rangeHelper}`,
        targetSummary: "for-of over range(...)",
      });
      const rangeCall = `__ctrans_${rangeHelper}(${rangeArgs.map((arg) => this.lowerExpr(arg)).join(", ")})`;
      this.block(`for (const ${targetName} of ${rangeCall})`, () => {
        this.lowerBody(node, "body");
      });
      return;
    }

    const iterName = iter.kind === "Name" ? String(scalar(iter, "id") ?? "") : null;
    const iterType = iterName === null ? null : this.scopes.lookup(iterName);
    this.declareIterationTarget(iter, targetName);
    this.declareLocally(targetName);
    if (iterType?.type.kind === "map") {
      this.ctx.record({
        span,
        sourceKind: "py.For(dict)",
        rule: "py.for-dict→js.Object.keys",
        decision: "semantic",
        rationale: "iterating a Python dict yields keys; JS objects iterate via Object.keys",
        adaptation: "Object.keys loop",
        targetSummary: "for-of over Object.keys(...)",
      });
      this.block(`for (const ${targetName} of Object.keys(${iterName}))`, () => {
        this.lowerBody(node, "body");
      });
      return;
    }
    if (iterType?.type.kind === "string") {
      // Python iterates strings by code points; JS for-of iterates UTF-16 units.
      this.ctx.record({
        span,
        sourceKind: "py.For(str)",
        rule: "py.for-str→__ctrans.iter",
        decision: "semantic",
        rationale: "code-point iteration via [...str] inside __ctrans_iter (astral-plane parity)",
        adaptation: "__ctrans_iter",
        targetSummary: "for-of over iter(text)",
      });
      this.block(
        `for (const ${targetName} of ${this.helperCall("iter", [this.lowerExpr(iter)])})`,
        () => {
          this.lowerBody(node, "body");
        },
      );
      return;
    }
    if (iterType === null || iterType.type.kind === "unknown" || iterType.type.kind === "any") {
      // Unknown iterable: TS cannot for-of an unknown value; __ctrans_iter applies
      // Python iteration (dict keys, code-point strings, sets).
      this.ctx.record({
        span,
        sourceKind: "py.For(unknown)",
        rule: "py.for→__ctrans.iter",
        decision: "semantic",
        rationale:
          "iterable type is statically unknown; TS cannot for-of unknown and Python iteration (dict keys/code points) is applied by __ctrans_iter",
        adaptation: "__ctrans_iter",
        targetSummary: "for-of over iter(...)",
      });
      this.block(
        `for (const ${targetName} of ${this.helperCall("iter", [this.lowerExpr(iter)])})`,
        () => {
          this.lowerBody(node, "body");
        },
      );
      return;
    }

    this.ctx.record({
      span,
      sourceKind: "py.For",
      rule: "py.for→js.for-of",
      decision: "deterministic",
      rationale: "iteration correspondence for statically typed sequences/sets",
      targetSummary: "for-of loop",
    });
    this.block(`for (const ${targetName} of ${this.lowerExpr(iter)})`, () => {
      this.lowerBody(node, "body");
    });
  }

  private lowerFunctionDef(node: AstNode): void {
    const name = String(scalar(node, "name") ?? "");
    const isAsync = node.kind === "AsyncFunctionDef";
    const decorators = kids(node, "decorator_list");
    const span = pySpan(node);
    if (decorators.length > 0) {
      this.unsupportedStmt(
        node,
        `py.${node.kind}(decorator)`,
        "function decorators are outside the M4 subset (higher-order application arrives in M5)",
      );
      return;
    }
    // Local functions/classes are known callees: calls emit natively. Return types
    // come from annotations (operand-kind inference flows through call results).
    const returnsNode = kid(node, "returns");
    const returnsCommon = returnsNode !== null ? commonTypeFromAnnotation(returnsNode) : null;
    this.scopes.declare(name, {
      type: {
        kind: "function",
        paramTypes: [],
        returnType: returnsCommon ?? UNKNOWN,
        async: isAsync,
      },
      origin: "inferred",
      confidence: "exact",
      span: node.span ?? null,
    });
    const isGenerator = containsYield(node);
    // Python async generators (async def with yield) need async function* in JS;
    // omitting the * is a syntax error, so the whole construct stays unsupported.
    if (isAsync && isGenerator) {
      this.unsupportedStmt(
        node,
        "py.AsyncFunctionDef(generator)",
        "async generators are outside the M4 subset",
      );
      return;
    }
    const args = kid(node, "args")!;
    this.scopes.push();
    this.declaredPerScope.push(new Set());
    const functionAssigned = new Set<string>();
    this.collectAssignedNames(kids(node, "body"), functionAssigned);
    this.scopeAssignedNames.push(functionAssigned);
    this.hoistedLines.push([]);
    this.scopeBaseIndent.push(this.indent + 1);
    const { params, returnType } = this.collectParams(args, node);
    const exported = this.exportedNames.has(name) && this.indent === 0;
    // WS F: the propagation engine marked this function async (a sync-to-async
    // boundary call is reachable from it). The signature change is recorded.
    const mustBeAsync = isAsync || this.asyncFunctions.has(name);
    const typeSuffix =
      this.ctx.target === "typescript" && returnType !== null
        ? `: ${mustBeAsync ? `Promise<${returnType}>` : returnType}`
        : "";
    this.ctx.record({
      span,
      sourceKind: `py.${node.kind}`,
      rule: "py.function→js.function",
      decision: "deterministic",
      rationale: isGenerator
        ? "generator function correspondence (def with yield → function*)"
        : this.asyncFunctions.has(name) && !isAsync
          ? "asyncified: a sync-to-async boundary call is reachable from this function — the JS target API is async-only, so the signature changes (recorded per docs/dependency-mapping.md §6)"
          : "function correspondence (closures via JS scoping; async syntax corresponds)",
      targetSummary: `${mustBeAsync ? "async " : ""}${isGenerator ? "function* " : "function "}${name}`,
    });
    this.line(
      `${exported ? "export " : ""}${mustBeAsync ? "async " : ""}function${isGenerator ? "*" : ""} ${name}(${params})${typeSuffix} {`,
    );
    this.indent += 1;
    const bodyInsertIndex = this.lines.length;
    // FunctionDef.body is the statement ARRAY (bridge envelope).
    for (const statement of kids(node, "body")) this.lowerStmt(statement);
    this.indent -= 1;
    this.flushHoists(bodyInsertIndex);
    this.scopes.pop();
    this.declaredPerScope.pop();
    this.line("}");
  }

  private lowerLambdaParams(args: AstNode): string {
    const parts: string[] = [];
    const positional = [...kids(args, "posonlyargs"), ...kids(args, "args")];
    // Defaults live in one list aligned to the TAIL of posonlyargs+args (CPython AST).
    const defaults = kids(args, "defaults");
    const firstDefault = positional.length - defaults.length;
    positional.forEach((arg, index) => {
      const argName = String(scalar(arg, "arg") ?? "");
      parts.push(this.defaultParamText(argName, defaults[index - firstDefault] ?? null, arg));
    });
    const vararg = kid(args, "vararg");
    if (vararg !== null) parts.push(`...${String(scalar(vararg, "arg") ?? "")}`);
    return parts.join(", ");
  }

  private collectParams(
    args: AstNode,
    functionNode: AstNode,
  ): { params: string; returnType: string | null } {
    const parts: string[] = [];
    const positional = [...kids(args, "posonlyargs"), ...kids(args, "args")];
    // CPython keeps defaults in one list aligned to the TAIL of posonlyargs+args.
    const defaults = kids(args, "defaults");
    const firstDefaultIndex = positional.length - defaults.length;
    positional.forEach((arg, index) => {
      const argName = String(scalar(arg, "arg") ?? "");
      parts.push(this.declaredParamText(argName, arg, defaults[index - firstDefaultIndex] ?? null));
    });
    // Keyword-only args have per-arg defaults in kw_defaults (null = no default).
    const kwonly = kids(args, "kwonlyargs");
    const kwDefaults = nullableKids(args, "kw_defaults");
    kwonly.forEach((arg, index) => {
      const argName = String(scalar(arg, "arg") ?? "");
      parts.push(this.declaredParamText(argName, arg, kwDefaults[index] ?? null));
      if (kwDefaults[index] !== null && kwDefaults[index] !== undefined) {
        // JS cannot enforce keyword-only call sites; kwargs call syntax is outside M4.
        this.ctx.record({
          span: pySpan(arg),
          sourceKind: "py.arg(kw-only)",
          rule: "py.kwonly→js.param",
          decision: "semantic",
          rationale:
            "keyword-only enforcement is dropped (JS has no kw-only params); kwargs call sites are outside the M4 subset",
          adaptation: "plain parameter",
          warnings: [CTW_KWARGS],
          targetSummary: argName,
        });
      }
    });
    const vararg = kid(args, "vararg");
    if (vararg !== null) {
      const argName = String(scalar(vararg, "arg") ?? "");
      parts.push(`...${argName}`);
      this.scopes.declare(argName, annotateUnknown());
      this.declareLocally(argName);
    }
    const kwarg = kid(args, "kwarg");
    if (kwarg !== null) {
      const argName = String(scalar(kwarg, "arg") ?? "");
      const recordType = this.ctx.target === "typescript" ? ": Record<string, unknown>" : "";
      parts.push(`...${argName}${recordType}`);
      this.scopes.declare(argName, annotateUnknown());
      this.declareLocally(argName);
      this.ctx.record({
        span: pySpan(kwarg),
        sourceKind: "py.arg(**kwargs)",
        rule: "py.kwargs→js.rest-object",
        decision: "semantic",
        rationale:
          "JS rest objects have string keys (matches Python kwargs keys), but **kwargs call expansion is unsupported in M4",
        adaptation: "rest object parameter",
        warnings: [CTW_KWARGS],
        targetSummary: `...${argName}${recordType}`,
      });
    }
    const returnsNode = kid(functionNode, "returns");
    const returnType =
      this.ctx.target === "typescript" && returnsNode !== null
        ? tsTypeFromAnnotation(returnsNode, this.ctx.intMode)
        : null;
    return { params: parts.join(", "), returnType };
  }

  // Parameter text with its scope type (annotation-driven so operand-kind inference
  // can prove numeric/string operations) and its default-parameter handling.
  private declaredParamText(argName: string, arg: AstNode, defaultNode: AstNode | null): string {
    const annotation = kid(arg, "annotation");
    this.declareAnnotatedParam(argName, annotation);
    this.declareLocally(argName);
    return this.defaultParamText(argName, defaultNode, arg);
  }

  // D-006: Python int is arbitrary precision; `number` mode records the precision
  // risk per int-typed parameter (semantic, never silent). float→number is exact.
  private declareAnnotatedParam(argName: string, annotation: AstNode | null): void {
    if (annotation === null) {
      this.scopes.declare(argName, annotateUnknown());
      return;
    }
    const type = commonTypeFromAnnotation(annotation);
    if (type === null) {
      this.scopes.declare(argName, annotateUnknown());
      return;
    }
    if (type.kind === "number" && type.numberKind === "int") {
      if (this.ctx.intMode === "bigint") {
        // D-006 exact mode: int annotations are bigint — no precision divergence.
        this.ctx.record({
          span: pySpan(annotation),
          sourceKind: "py.arg(annotation)",
          rule: "py.int-annotation→js.bigint",
          decision: "deterministic",
          rationale: "intMode=bigint: Python int maps to JS bigint exactly (D-006 exact mode)",
          targetSummary: `${argName}: bigint`,
        });
      } else {
        this.ctx.record({
          span: pySpan(annotation),
          sourceKind: "py.arg(annotation)",
          rule: "py.int-annotation→js.number",
          decision: "semantic",
          rationale:
            "Python int is arbitrary precision; JS number is float64 (D-006: intMode=bigint is the exact mode)",
          adaptation: "number with precision warning",
          warnings: [CTW_NUM_PRECISION],
          targetSummary: `${argName}: number`,
        });
      }
    }
    this.scopes.declare(argName, {
      type,
      origin: "explicit",
      confidence: type.kind === "number" ? "approximate" : "exact",
      span: annotation.span ?? null,
    });
  }

  private defaultParamText(argName: string, defaultNode: AstNode | null, arg: AstNode): string {
    const annotation = kid(arg, "annotation");
    // Honest typing: unannotated Python parameters are `unknown`, never implicit any.
    const tsType =
      this.ctx.target === "typescript"
        ? ((annotation !== null ? tsTypeFromAnnotation(annotation, this.ctx.intMode) : null) ??
          "unknown")
        : null;
    const typeSuffix = tsType === null ? "" : `: ${tsType}`;
    if (defaultNode === null) return `${argName}${typeSuffix}`;
    // `def f(x: T = None)` needs `T | undefined` (None → undefined null mode).
    const nullDefault = defaultNode.kind === "Constant" && defaultNode.fields["value"] === null;
    const mutableLiteral =
      defaultNode.kind === "List" ||
      defaultNode.kind === "Dict" ||
      defaultNode.kind === "Set" ||
      defaultNode.kind === "Tuple";
    const constant =
      defaultNode.kind === "Constant" ||
      (defaultNode.kind === "UnaryOp" && kid(defaultNode, "operand")?.kind === "Constant");
    // JS default parameters evaluate per omitted call; Python evaluates once at
    // definition time. Immutable constants are equivalent; everything else diverges
    // (documented): mutable literals get a fresh object per call (the Python
    // mutable-default footgun intentionally does not reproduce), and side-effecting
    // expressions no longer run at module load.
    this.ctx.record({
      span: pySpan(arg),
      sourceKind: "py.arg(default)",
      rule: "py.default→js.default-param",
      decision: constant && !mutableLiteral ? "deterministic" : "semantic",
      rationale: mutableLiteral
        ? "Python shares ONE default object across calls; a JS default parameter re-evaluates per call (fresh object — the mutable-default footgun is intentionally not reproduced)"
        : constant
          ? "immutable constant default correspondence"
          : "Python evaluates expression defaults once at definition time; JS evaluates per omitted call — side-effecting defaults diverge",
      adaptation: mutableLiteral
        ? "native default parameter (fresh per call)"
        : constant
          ? null
          : "native default parameter (deferred evaluation)",
      warnings: mutableLiteral ? [CTW_MUTABLE_DEFAULT] : constant ? [] : [CTW_DEFAULT_EVAL],
      targetSummary: `${argName} = ...`,
    });
    const effectiveType =
      tsType !== null && nullDefault && tsType !== "undefined" ? `${tsType} | undefined` : tsType;
    const effectiveSuffix = effectiveType === null ? "" : `: ${effectiveType}`;
    return `${argName}${effectiveSuffix} = ${this.lowerExpr(defaultNode)}`;
  }

  private lowerRaise(node: AstNode): void {
    const exc = kid(node, "exc");
    const cause = kid(node, "cause");
    const span = pySpan(node);
    if (cause !== null) {
      this.unsupportedStmt(node, "py.Raise(cause)", "raise-from is outside the M4 subset");
      return;
    }
    if (exc === null) {
      if (this.exceptBinding !== null) {
        this.ctx.record({
          span,
          sourceKind: "py.Raise(bare)",
          rule: "py.raise→js.throw",
          decision: "deterministic",
          rationale: "bare raise re-raises the active exception",
          targetSummary: `throw ${this.exceptBinding};`,
        });
        this.line(`throw ${this.exceptBinding};`);
        return;
      }
      this.unsupportedStmt(
        node,
        "py.Raise(bare)",
        "bare raise outside an except handler is outside the M4 subset",
      );
      return;
    }
    // `raise ValueError("m")` constructs the exception; a bare class name constructs
    // with no arguments. Instances (e.g. a caught binding) are re-thrown as values.
    let excText: string;
    if (exc.kind === "Call" && kid(exc, "func")?.kind === "Name") {
      const className = String(scalar(kid(exc, "func")!, "id") ?? "");
      if (/^[A-Z]/.test(className)) {
        const jsName = jsExceptionName(className);
        this.ctx.useException(jsName);
        excText = `new ${jsName}(${kids(exc, "args")
          .map((arg) => this.lowerExpr(arg))
          .join(", ")})`;
      } else {
        excText = this.lowerExpr(exc);
      }
    } else if (exc.kind === "Name" && /^[A-Z]/.test(String(scalar(exc, "id") ?? ""))) {
      const className = String(scalar(exc, "id") ?? "");
      const jsName = jsExceptionName(className);
      this.ctx.useException(jsName);
      excText = `new ${jsName}()`;
    } else {
      excText = this.lowerExpr(exc);
    }
    this.ctx.record({
      span,
      sourceKind: "py.Raise",
      rule: "py.raise→js.throw",
      decision: "deterministic",
      rationale: "raise corresponds to throwing a generated Python-exception-hierarchy instance",
      targetSummary: `throw ${excText};`,
    });
    this.line(`throw ${excText};`);
  }

  private lowerTry(node: AstNode): void {
    const handlers = kids(node, "handlers");
    const orelse = kids(node, "orelse");
    const finalbody = kids(node, "finalbody");
    const span = pySpan(node);
    const bareHandler = handlers.find((handler) => kid(handler, "type") === null);
    if (bareHandler !== undefined && handlers.length > 1) {
      this.unsupportedStmt(
        node,
        "py.Try",
        "bare except combined with typed handlers is outside the M4 subset",
      );
      return;
    }
    this.ctx.record({
      span,
      sourceKind: "py.Try",
      rule: "py.try→js.try/catch",
      decision: "semantic",
      rationale:
        "except clauses become instanceof chains over the generated exception hierarchy; the else-body is inlined at the tail of the try (documented divergence: exceptions raised inside else are visible to these handlers, and its bindings stay in scope for the finally)",
      adaptation: "instanceof dispatch + else inlined into the try tail",
      targetSummary: "try/catch/finally",
    });
    this.line("try {");
    this.indent += 1;
    this.lowerBody(node, "body");
    for (const statement of orelse) this.lowerStmt(statement);
    this.indent -= 1;

    if (handlers.length === 0) {
      // try/finally only (else requires handlers in Python and never occurs here).
      this.line("} finally {");
      this.indent += 1;
      for (const statement of finalbody) this.lowerStmt(statement);
      this.indent -= 1;
      this.line("}");
      return;
    }

    this.line("} catch (__ctrans_err) {");
    this.indent += 1;
    let first = true;
    let hadTypedHandler = false;
    for (const handler of handlers) {
      const typeNode = kid(handler, "type");
      if (typeNode === null) continue; // bare handled below
      const typeTargets = typeNode.kind === "Tuple" ? kids(typeNode, "elts") : [typeNode];
      const checks: string[] = [];
      let supported = true;
      for (const typeTarget of typeTargets) {
        const typeName = typeTarget.kind === "Name" ? String(scalar(typeTarget, "id") ?? "") : null;
        if (typeName === null || !KNOWN_EXCEPTIONS.has(typeName)) {
          supported = false;
          break;
        }
        this.ctx.useHelper("exceptions");
        this.ctx.useException(jsExceptionName(typeName));
        checks.push(`__ctrans_err instanceof ${jsExceptionName(typeName)}`);
      }
      if (!supported) {
        this.unsupportedStmt(
          handler,
          "py.ExceptHandler(type)",
          "exception type is outside the generated hierarchy",
        );
        continue;
      }
      // CPython ExceptHandler.name is a plain identifier STRING (or null).
      const handlerName = scalar(handler, "name");
      const binding = typeof handlerName === "string" ? handlerName : null;
      this.line(`${first ? "if" : "else if"} (${checks.join(" || ")}) {`);
      this.indent += 1;
      if (binding !== null) {
        this.line(`const ${binding} = __ctrans_err;`);
        this.scopes.declare(binding, annotateUnknown());
        this.declareLocally(binding);
      }
      const previousExcept = this.exceptBinding;
      this.exceptBinding = binding ?? "__ctrans_err";
      this.lowerBody(handler, "body");
      this.exceptBinding = previousExcept;
      this.indent -= 1;
      this.line("}");
      first = false;
      hadTypedHandler = true;
    }
    if (bareHandler !== undefined) {
      // Bare handlers: name is a plain identifier STRING (or null).
      const bareName = scalar(bareHandler, "name");
      const binding = typeof bareName === "string" ? bareName : null;
      if (!first) {
        this.line("else {");
        this.indent += 1;
      }
      if (binding !== null) {
        this.line(`const ${binding} = __ctrans_err;`);
        this.scopes.declare(binding, annotateUnknown());
        this.declareLocally(binding);
      }
      const previousExcept = this.exceptBinding;
      this.exceptBinding = binding ?? "__ctrans_err";
      this.lowerBody(bareHandler, "body");
      this.exceptBinding = previousExcept;
      if (!first) {
        this.indent -= 1;
        this.line("}");
      }
    } else if (hadTypedHandler) {
      this.line("else {");
      this.indent += 1;
      this.line("throw __ctrans_err;");
      this.indent -= 1;
      this.line("}");
    }
    this.indent -= 1;
    if (finalbody.length > 0) {
      this.line("} finally {");
      this.indent += 1;
      for (const statement of finalbody) this.lowerStmt(statement);
      this.indent -= 1;
      this.line("}");
      return;
    }
    this.line("}");
  }

  // with EXPR as NAME: BODY → NAME = EXPR.__enter__(); try { BODY } finally { __exit__ }.
  // The loop-free single-item subset; __exit__ always receives no-exception arguments
  // (JS finally cannot observe the exception) — suppression is impossible (documented).
  private lowerWith(node: AstNode): void {
    const items = kids(node, "items");
    if (items.length !== 1) {
      this.unsupportedStmt(node, "py.With", "multi-item with statements are outside the M4 subset");
      return;
    }
    const item = items[0]!;
    const contextExpr = kid(item, "context_expr");
    const optionalVars = kid(item, "optional_vars");
    if (contextExpr === null || (optionalVars !== null && optionalVars.kind !== "Name")) {
      this.unsupportedStmt(node, "py.With", "unsupported with-item target shape");
      return;
    }
    const span = pySpan(node);
    this.ctx.record({
      span,
      sourceKind: "py.With",
      rule: "py.with→js.enter/try-finally",
      decision: "semantic",
      rationale:
        "context-manager protocol emitted as __enter__()/try/finally with __exit__(undefined, undefined, undefined); exception details are not passed to __exit__ and suppression cannot occur",
      adaptation: "enter/exit protocol",
      warnings: [CTW_WITH_EXIT_ARGS],
      targetSummary: "enter + try/finally + __exit__",
    });
    const managerTemp = this.freshTemp("__ctrans_with");
    this.line(`const ${managerTemp} = ${this.lowerExpr(contextExpr)};`);
    if (optionalVars !== null) {
      const boundName = String(scalar(optionalVars, "id") ?? "");
      this.line(`const ${boundName} = ${managerTemp}.__enter__();`);
      this.scopes.declare(boundName, annotateUnknown());
      this.declareLocally(boundName);
    } else {
      this.line(`${managerTemp}.__enter__();`);
    }
    this.line("try {");
    this.indent += 1;
    this.lowerBody(node, "body");
    this.indent -= 1;
    this.line("} finally {");
    this.indent += 1;
    this.line(`${managerTemp}.__exit__(undefined, undefined, undefined);`);
    this.indent -= 1;
    this.line("}");
  }

  private lowerClassDef(node: AstNode): void {
    const name = String(scalar(node, "name") ?? "");
    const bases = kids(node, "bases");
    const keywords = kids(node, "keywords");
    const decorators = kids(node, "decorator_list");
    const span = pySpan(node);
    if (bases.length > 1 || keywords.length > 0 || decorators.length > 0) {
      this.unsupportedStmt(
        node,
        "py.ClassDef",
        "multiple inheritance, class keywords and class decorators are outside the M4 subset",
      );
      return;
    }
    const base =
      bases[0] !== undefined && bases[0].kind === "Name"
        ? String(scalar(bases[0], "id") ?? "")
        : null;
    if (base === "type") {
      // `class Meta(type)` declares a metaclass (V1 non-support,
      // docs/language-support.md §4). Emitting `class Meta extends type` would
      // reference an undefined identifier and crash at module load (audit finding).
      this.unsupportedStmt(
        node,
        "py.ClassDef(metaclass-base)",
        "metaclass declarations are outside the M4 subset",
      );
      return;
    }
    // Local classes are known constructor callees: uses emit natively.
    this.scopes.declare(name, {
      type: { kind: "class", name },
      origin: "inferred",
      confidence: "exact",
      span: node.span ?? null,
    });
    if (base !== null && KNOWN_EXCEPTIONS.has(base)) {
      // Built-in exception hierarchy classes live in the generated runtime module.
      this.ctx.useHelper("exceptions");
      this.ctx.useException(jsExceptionName(base));
    }
    this.ctx.record({
      span,
      sourceKind: "py.ClassDef",
      rule: "py.class→js.class",
      decision: "semantic",
      rationale:
        "single-inheritance class correspondence; class attributes become static fields (instance access diverges - documented)",
      adaptation: base !== null ? `extends ${jsExceptionName(base)}` : "plain class",
      targetSummary: `class ${name}`,
    });
    const exported = this.exportedNames.has(name) && this.indent === 0;
    const instanceAttributes = collectInstanceAttributes(node, this.ctx.intMode);
    // Field types inherit through the (single-inheritance) base chain: subclass
    // methods keep native arithmetic and fields are declared exactly once.
    const baseFields = base !== null ? this.classFieldTypes.get(base) : undefined;
    const fieldTypes = new Map(baseFields ?? []);
    for (const attribute of instanceAttributes) {
      if (fieldTypes.has(attribute.name)) continue;
      const common = attribute.commonType ?? tsTextToCommonType(attribute.tsType);
      if (common !== null) {
        fieldTypes.set(attribute.name, {
          type: common,
          origin: "inferred",
          confidence: "approximate",
          span: null,
        });
      }
    }
    this.classFieldTypes.set(name, fieldTypes);
    const outerFieldTypes = this.selfFieldTypes;
    this.selfFieldTypes = fieldTypes;
    this.line(
      `${exported ? "export " : ""}class ${name}${base !== null ? ` extends ${jsExceptionName(base)}` : ""} {`,
    );
    this.indent += 1;
    for (const attribute of instanceAttributes) {
      if (baseFields?.has(attribute.name)) continue; // inherited: base declares it
      this.ctx.record({
        span: null,
        sourceKind: "py.ClassDef(self-attr)",
        rule: "py.self-attr→js.field",
        decision: "semantic",
        rationale:
          "Python instance attributes are assigned dynamically; TS fields must be declared. Types come from the first assignment's annotation or conservative inference (else unknown). Fields assigned outside the constructor carry a definite-assignment assertion.",
        adaptation: "declared field (typed from first assignment, else unknown)",
        targetSummary: `field ${attribute.name}`,
      });
      // D-006 bigint mode: int-typed fields declare bigint (the CommonType carries
      // the int kind; the tsType text alone would say number).
      const declaredType =
        this.ctx.intMode === "bigint" &&
        attribute.commonType?.kind === "number" &&
        attribute.commonType.numberKind === "int"
          ? "bigint"
          : (attribute.tsType ?? "unknown");
      const typeSuffix = this.ctx.target === "typescript" ? `: ${declaredType}` : "";
      const definite =
        this.ctx.target === "typescript" && !attribute.initializedInConstructor ? "!" : "";
      this.line(`${attribute.name}${definite}${typeSuffix};`);
    }
    this.declaredPerScope.push(new Set());
    this.scopes.push();
    // ClassDef.body is the statement ARRAY (bridge envelope: list fields are arrays).
    for (const statement of kids(node, "body")) {
      if (statement.kind === "FunctionDef" || statement.kind === "AsyncFunctionDef") {
        this.lowerMethodDef(statement);
        continue;
      }
      if (statement.kind === "Assign") {
        // CPython Assign.targets is a LIST; class attributes take the first target.
        const targetNode = kids(statement, "targets")[0] ?? kid(statement, "target");
        const valueNode = kid(statement, "value");
        if (targetNode !== null && targetNode.kind === "Name" && valueNode !== null) {
          const attrName = String(scalar(targetNode, "id") ?? "");
          this.ctx.record({
            span: pySpan(statement),
            sourceKind: "py.ClassDef(attr)",
            rule: "py.class-attr→js.static",
            decision: "semantic",
            rationale:
              "Python class attributes are reachable from instances; JS static fields are not (documented divergence)",
            adaptation: "static field",
            warnings: [CTW_CLASS_ATTR_STATIC],
            targetSummary: `static ${attrName}`,
          });
          this.line(`static ${attrName} = ${this.lowerExpr(valueNode)};`);
          continue;
        }
      }
      if (statement.kind === "Expr" && kid(statement, "value")?.kind === "Constant") {
        this.emitDocstring(String(kid(statement, "value")!.fields["value"] ?? ""));
        continue;
      }
      if (statement.kind === "Pass") {
        this.ctx.record({
          span: pySpan(statement),
          sourceKind: "py.ClassDef(pass)",
          rule: "py.pass→omitted",
          decision: "deterministic",
          rationale: "pass is a syntactic placeholder with no behavior",
          targetSummary: "omitted",
        });
        this.line("// pass");
        continue;
      }
      this.unsupportedStmt(
        statement,
        "py.ClassDef(member)",
        "class member is outside the M4 subset",
      );
    }
    this.selfFieldTypes = outerFieldTypes;
    this.scopes.pop();
    this.declaredPerScope.pop();
    this.indent -= 1;
    this.line("}");
  }

  private lowerMethodDef(node: AstNode): void {
    const name = String(scalar(node, "name") ?? "");
    const isAsync = node.kind === "AsyncFunctionDef";
    const args = kid(node, "args")!;
    const span = pySpan(node);
    if (kids(node, "decorator_list").length > 0) {
      this.unsupportedStmt(
        node,
        "py.MethodDef(decorator)",
        "method decorators are outside the M4 subset",
      );
      return;
    }
    const positional = [...kids(args, "posonlyargs"), ...kids(args, "args")];
    // Method defaults also live in arguments.defaults (tail-aligned), never on the arg.
    const methodDefaults = kids(args, "defaults");
    const firstMethodDefault = positional.length - methodDefaults.length;
    const methodDefaultFor = (index: number): AstNode | null =>
      methodDefaults[index - firstMethodDefault] ?? null;
    const isConstructor = name === "__init__";
    const isDunder = name.startsWith("__") && name.endsWith("__") && !isConstructor;
    if (isDunder) {
      this.ctx.record({
        span,
        sourceKind: "py.MethodDef(dunder)",
        rule: "py.dunder-method→unsupported",
        decision: "unsupported",
        rationale: "dunder protocol methods beyond __init__ require protocol helpers (M5+)",
        targetSummary: null,
      });
      this.line(`/* ctrans: unsupported dunder method ${name} */`);
      return;
    }
    let selfName: string | null = null;
    const methodParams: string[] = [];
    if (positional.length > 0) {
      selfName = String(scalar(positional[0]!, "arg") ?? "self");
      for (const [index, arg] of positional.slice(1).entries()) {
        const argName = String(scalar(arg, "arg") ?? "");
        const defaultNode = methodDefaultFor(index + 1);
        // Same policy as free functions (declaredParamText): scope-declared types
        // drive native-vs-helper decisions, and unannotated parameters are
        // `unknown`, never implicit any.
        methodParams.push(this.declaredParamText(argName, arg, defaultNode));
      }
    }
    const returnsNode = kid(node, "returns");
    const returnType =
      isConstructor || this.ctx.target !== "typescript" || returnsNode === null
        ? null
        : tsTypeFromAnnotation(returnsNode, this.ctx.intMode);
    const typeSuffix = returnType === null ? "" : `: ${returnType}`;
    const targetName = isConstructor ? "constructor" : name;
    this.ctx.record({
      span,
      sourceKind: `py.${node.kind}(method)`,
      rule: isConstructor ? "py.__init__→js.constructor" : "py.method→js.method",
      decision: "deterministic",
      rationale: isConstructor
        ? "constructor correspondence (self dropped)"
        : "method correspondence (self dropped; self references become this)",
      targetSummary: `${targetName}(...)`,
    });
    if (selfName !== null) this.selfNames.push(selfName);
    this.line(`${isAsync ? "async " : ""}${targetName}(${methodParams.join(", ")})${typeSuffix} {`);
    this.indent += 1;
    const bodyInsertIndex = this.lines.length;
    this.declaredPerScope.push(new Set());
    this.scopes.push();
    const methodAssigned = new Set<string>();
    this.collectAssignedNames(kids(node, "body"), methodAssigned);
    this.scopeAssignedNames.push(methodAssigned);
    this.hoistedLines.push([]);
    this.scopeBaseIndent.push(this.indent);
    // Method bodies are statement ARRAYS (bridge envelope).
    for (const statement of kids(node, "body")) this.lowerStmt(statement);
    this.indent -= 1;
    this.flushHoists(bodyInsertIndex);
    this.scopes.pop();
    this.declaredPerScope.pop();
    this.line("}");
    if (selfName !== null) this.selfNames.pop();
  }
}

// A yield anywhere in the body (iterative walk — hostile inputs must not recurse).
function containsYield(functionNode: AstNode): boolean {
  const stack: unknown[] = [...kids(functionNode, "body")];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current !== "object" || current === null) continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    const candidate = current as { kind?: string; fields?: Record<string, unknown> };
    if (candidate.kind === "Yield" || candidate.kind === "YieldFrom") return true;
    // Nested function/class bodies have their own yield semantics — do not descend.
    if (
      candidate.kind === "FunctionDef" ||
      candidate.kind === "AsyncFunctionDef" ||
      candidate.kind === "Lambda" ||
      candidate.kind === "ClassDef"
    ) {
      continue;
    }
    for (const value of Object.values(candidate.fields ?? {})) stack.push(value);
  }
  return false;
}

// Runtime helpers whose results are statically numbers (operand-kind propagation).
// Numeric helpers whose result type widens to `number | bigint` in the D-006
// bigint mode (their results are treated as dynamic there — never native ops).
const HELPER_WIDENED_RETURNS = new Set([
  "sub",
  "floorDiv",
  "mod",
  "pow",
  "sum",
  "neg",
  "pos",
  "bitAnd",
  "bitOr",
  "bitXor",
  "lShift",
  "rShift",
]);

const HELPER_NUMBER_RETURNS = new Set([
  "sub",
  "div",
  "floorDiv",
  "mod",
  "pow",
  "len",
  "sum",
  "toInt",
  "toFloat",
  "neg",
  "pos",
  "bitAnd",
  "bitOr",
  "bitXor",
  "lShift",
  "rShift",
]);

// `super(...)` call node detection (zero-argument super form).
function isSuperCall(node: AstNode): boolean {
  const func = kid(node, "func");
  return func !== null && func.kind === "Name" && String(scalar(func, "id") ?? "") === "super";
}

const BUILTIN_TYPE_NAMES = new Set([
  "int",
  "float",
  "str",
  "bool",
  "bytes",
  "list",
  "dict",
  "set",
  "tuple",
]);

const KNOWN_EXCEPTIONS = new Set([
  "Exception",
  "ValueError",
  "TypeError",
  "KeyError",
  "IndexError",
  "AttributeError",
  "ZeroDivisionError",
  "RuntimeError",
]);

// Python exception name → runtime class name (the generated hierarchy's base is
// PythonException so it never collides with the JS DOM lib's Error family).
function jsExceptionName(pyName: string): string {
  return pyName === "Exception" ? "PythonException" : pyName;
}

// Python annotation -> TypeScript type text; null when outside the mappable subset
// (callers then emit no annotation rather than inventing one).
export function tsTypeFromAnnotation(
  node: AstNode,
  intMode: "number" | "bigint" = "number",
): string | null {
  switch (node.kind) {
    case "Name": {
      const name = String(scalar(node, "id") ?? "");
      const mapping: Record<string, string> = {
        int: intMode === "bigint" ? "bigint" : "number",
        float: "number",
        str: "string",
        bool: "boolean",
        object: "object",
        list: "Array<unknown>",
        set: "Set<unknown>",
        dict: "Record<string, unknown>",
        tuple: "unknown[]",
      };
      if (name in mapping) return mapping[name]!;
      if (name === "None" || name === "NoneType") return "undefined";
      return /^[A-Z]/.test(name) ? name : null;
    }
    case "BinOp": {
      const left = tsTypeFromAnnotation(kid(node, "left")!, intMode);
      const right = tsTypeFromAnnotation(kid(node, "right")!, intMode);
      if (left === null || right === null) return null;
      return `${left} | ${right}`;
    }
    case "Subscript": {
      const base = kid(node, "value");
      const baseName =
        base !== null && base.kind === "Name" ? String(scalar(base, "id") ?? "") : null;
      const slice = kid(node, "slice");
      // `list[int]` slices to a single type node; `dict[K, V]` slices to a Tuple.
      const args =
        slice === null ? [] : kids(slice, "elts").length > 0 ? kids(slice, "elts") : [slice];
      const argType = (index: number): string | null =>
        args[index] === undefined ? null : tsTypeFromAnnotation(args[index]!, intMode);
      if (baseName === "list") {
        const element = argType(0);
        return element === null ? null : `Array<${element}>`;
      }
      if (baseName === "set") {
        const element = argType(0);
        return element === null ? null : `Set<${element}>`;
      }
      if (baseName === "dict") {
        const key = argType(0);
        const value = argType(1);
        return key === null || value === null ? null : `Record<${key}, ${value}>`;
      }
      if (baseName === "Optional") {
        const inner = argType(0);
        return inner === null ? null : `${inner} | undefined`;
      }
      if (baseName === "tuple") {
        const elements = args.map((arg) => tsTypeFromAnnotation(arg, intMode));
        if (elements.length > 0 && elements.every((entry) => entry !== null)) {
          return `[${elements.join(", ")}]`;
        }
        return null;
      }
      return null;
    }
    case "Constant":
      return node.fields["value"] === null ? "undefined" : null;
    default:
      return null;
  }
}

interface InstanceAttribute {
  readonly name: string;
  readonly tsType: string | null;
  // The CommonType WITH numberKind (the tsType text round-trip loses int/float —
  // operand-kind inference and f-string float detection need it).
  readonly commonType: AnnotatedType["type"] | null;
  // Strict TS requires definite assignment; fields assigned outside the constructor
  // get a `!` assertion (recorded in the ledger rationale).
  readonly initializedInConstructor: boolean;
}

// Python annotation -> CommonType for scope declarations (operand-kind inference);
// null when the annotation carries no statically usable type information. Uppercase
// names map to the project's own class instance types.
export function commonTypeFromAnnotation(node: AstNode): CommonType | null {
  switch (node.kind) {
    case "Name": {
      const name = String(scalar(node, "id") ?? "");
      if (name === "int" || name === "float") {
        return { kind: "number", numberKind: name === "int" ? "int" : "float" };
      }
      if (name === "str") return { kind: "string" };
      if (name === "bool") return { kind: "boolean" };
      if (name === "object") return { kind: "object" };
      if (name === "list") return { kind: "array", elementType: UNKNOWN };
      if (name === "dict") return { kind: "map", keyType: UNKNOWN, valueType: UNKNOWN };
      if (name === "set") return { kind: "set", elementType: UNKNOWN };
      if (name === "None" || name === "NoneType") return { kind: "null" };
      if (/^[A-Z]/.test(name)) return { kind: "instance", className: name };
      return null;
    }
    case "Subscript": {
      const base = kid(node, "value");
      const baseName =
        base !== null && base.kind === "Name" ? String(scalar(base, "id") ?? "") : null;
      const slice = kid(node, "slice");
      const args =
        slice === null ? [] : kids(slice, "elts").length > 0 ? kids(slice, "elts") : [slice];
      const argType = (index: number): CommonType | null =>
        args[index] === undefined ? null : commonTypeFromAnnotation(args[index]!);
      if (baseName === "list") {
        const element = argType(0) ?? UNKNOWN;
        return { kind: "array", elementType: element };
      }
      if (baseName === "set") {
        const element = argType(0) ?? UNKNOWN;
        return { kind: "set", elementType: element };
      }
      if (baseName === "dict") {
        const key = argType(0) ?? UNKNOWN;
        const value = argType(1) ?? UNKNOWN;
        return { kind: "map", keyType: key, valueType: value };
      }
      return null;
    }
    default:
      return null;
  }
}

// Pre-scan class methods for `self.X = ...` assignments (M4 subset: direct attribute
// writes in method bodies). Types come from AnnAssign annotations or conservative
// value inference; anything dynamic becomes `unknown` (never any).
function collectInstanceAttributes(
  classNode: AstNode,
  intMode: "number" | "bigint",
): InstanceAttribute[] {
  const attributes = new Map<string, string | null>();
  const annotationCommons = new Map<string, AnnotatedType["type"]>();
  const constructorAssigned = new Set<string>();
  for (const statement of kids(classNode, "body")) {
    if (statement.kind !== "FunctionDef" && statement.kind !== "AsyncFunctionDef") continue;
    const inConstructor = String(scalar(statement, "name") ?? "") === "__init__";
    const bodyStack = kids(statement, "body");
    const stack: unknown[] = [...bodyStack];
    while (stack.length > 0) {
      const current = stack.pop();
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        if (Array.isArray(current)) stack.push(...current);
        continue;
      }
      const record = current as Record<string, unknown>;
      if (record["kind"] === "Assign" || record["kind"] === "AnnAssign") {
        const fields = record["fields"] as Record<string, unknown> | undefined;
        const targets =
          record["kind"] === "Assign"
            ? [fields?.["targets"] ?? record["targets"]].flat()
            : [fields?.["target"] ?? record["target"]].flat();
        for (const target of targets) {
          if (typeof target !== "object" || target === null) continue;
          const targetRecord = target as Record<string, unknown>;
          if (targetRecord["kind"] !== "Attribute") continue;
          const value = targetRecord["fields"] as Record<string, unknown> | undefined;
          const objectNode = value?.["value"] as Record<string, unknown> | undefined;
          const objectFields = objectNode?.["fields"] as Record<string, unknown> | undefined;
          if (objectNode?.["kind"] !== "Name" || objectFields?.["id"] !== "self") continue;
          const attrName = String(value?.["attr"] ?? "");
          if (attrName === "") continue;
          if (inConstructor) constructorAssigned.add(attrName);
          if (attributes.has(attrName)) continue;
          const annotation =
            record["kind"] === "AnnAssign"
              ? (fields?.["annotation"] as AstNode | undefined)
              : undefined;
          attributes.set(
            attrName,
            annotation === undefined ? null : tsTypeFromAnnotation(annotation, intMode),
          );
          if (annotation !== undefined) {
            const common = commonTypeFromAnnotation(annotation);
            if (common !== null) annotationCommons.set(attrName, common);
          }
        }
      }
      for (const entry of Object.values(record["fields"] ?? record)) {
        if (Array.isArray(entry)) stack.push(...entry);
        else if (typeof entry === "object" && entry !== null) stack.push(entry);
      }
    }
  }
  return [...attributes.entries()]
    .map(([name, tsType]) => {
      const resolved = tsType ?? inferAttributeType(classNode, name);
      // CommonType WITH numberKind: from the annotation when mappable, else the
      // initializer constant's int/float kind (the text round-trip loses it, and
      // operand-kind inference + f-string float detection need it).
      let commonType: AnnotatedType["type"] | null = annotationCommons.get(name) ?? null;
      if (commonType === null && resolved !== null) {
        const back = tsTextToCommonType(resolved);
        if (back !== null && back.kind === "number") {
          const kind = initializerNumberKind(classNode, name);
          commonType = { kind: "number", ...(kind !== undefined ? { numberKind: kind } : {}) };
        } else {
          commonType = back;
        }
      }
      return {
        name,
        tsType: resolved,
        commonType,
        initializedInConstructor: constructorAssigned.has(name),
      };
    })
    .sort((left, right) => (left.name < right.name ? -1 : 1));
}

// The initializer's int/float kind for an un-annotated self.<name> (undefined =
// unknown or non-numeric initializer).
function initializerNumberKind(
  classNode: AstNode,
  attributeName: string,
): "int" | "float" | undefined {
  for (const statement of kids(classNode, "body")) {
    if (statement.kind !== "FunctionDef" && statement.kind !== "AsyncFunctionDef") continue;
    const stack: unknown[] = [...kids(statement, "body")];
    while (stack.length > 0) {
      const current = stack.pop();
      if (Array.isArray(current)) {
        stack.push(...current);
        continue;
      }
      if (typeof current !== "object" || current === null) continue;
      const record = current as { kind?: string; fields?: Record<string, unknown> };
      if (record.kind === undefined || record.fields === undefined) continue;
      if (record.kind === "Assign" || record.kind === "AnnAssign") {
        const targets =
          record.kind === "Assign"
            ? ((record.fields["targets"] as readonly AstNode[] | undefined) ?? [])
            : (record.fields["target"] as AstNode | undefined) !== undefined
              ? [record.fields["target"] as AstNode]
              : [];
        for (const target of targets) {
          if (target.kind !== "Attribute") continue;
          const receiver = kid(target, "value");
          if (receiver === null || String(scalar(receiver, "id") ?? "") !== "self") continue;
          if (String(scalar(target, "attr") ?? "") !== attributeName) continue;
          // The assigned VALUE lives on the STATEMENT (Assign.value / AnnAssign.value),
          // never on the target node. record IS the statement node here.
          const assigned =
            record.kind === "Assign"
              ? kid(record as unknown as AstNode, "value")
              : ((record.fields["value"] as AstNode | undefined) ?? null);
          if (assigned === null || assigned.kind !== "Constant") continue;
          const literal = assigned.fields["value"];
          if (typeof literal === "number") {
            return Number.isInteger(literal) ? "int" : "float";
          }
        }
      }
      for (const entry of Object.values(record.fields)) {
        if (Array.isArray(entry)) stack.push(...entry);
        else if (typeof entry === "object" && entry !== null) stack.push(entry);
      }
    }
  }
  return undefined;
}

// Conservative value inference for un-annotated attribute assignments.
function inferAttributeType(classNode: AstNode, attributeName: string): string | null {
  for (const statement of kids(classNode, "body")) {
    if (statement.kind !== "FunctionDef" && statement.kind !== "AsyncFunctionDef") continue;
    const bodyStack = kids(statement, "body");
    const stack: unknown[] = [...bodyStack];
    while (stack.length > 0) {
      const current = stack.pop();
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        if (Array.isArray(current)) stack.push(...current);
        continue;
      }
      const record = current as Record<string, unknown>;
      if (record["kind"] === "Assign") {
        const fields = record["fields"] as Record<string, unknown> | undefined;
        const targets = (fields?.["targets"] ?? []) as Array<Record<string, unknown>>;
        for (const target of targets) {
          const value = target["fields"] as Record<string, unknown> | undefined;
          const objectNode = value?.["value"] as Record<string, unknown> | undefined;
          const objectFields = objectNode?.["fields"] as Record<string, unknown> | undefined;
          if (objectFields?.["id"] !== "self" || value?.["attr"] !== attributeName) continue;
          const assigned = fields?.["value"] as Record<string, unknown> | undefined;
          if (assigned === undefined) continue;
          if (assigned["kind"] === "Constant") {
            // The literal lives in the Constant node's fields record.
            const literal = (assigned["fields"] as Record<string, unknown> | undefined)?.["value"];
            if (typeof literal === "number") return "number";
            if (typeof literal === "string") return "string";
            if (typeof literal === "boolean") return "boolean";
            if (literal === null) return "unknown";
          }
          if (assigned["kind"] === "List") return "Array<unknown>";
          if (assigned["kind"] === "Dict") return "Record<string, unknown>";
          if (assigned["kind"] === "Call") {
            const func = assigned["func"] as Record<string, unknown> | undefined;
            if (func?.["kind"] === "Name" && func["id"] === "int") return "number";
            if (func?.["kind"] === "Name" && func["id"] === "float") return "number";
            if (func?.["kind"] === "Name" && func["id"] === "str") return "string";
          }
          // Parameter passthrough: `self.x = param` inherits the param annotation.
          if (assigned["kind"] === "Name") {
            const nameFields = assigned["fields"] as Record<string, unknown> | undefined;
            const paramName = nameFields?.["id"];
            const methodArgs = kid(statement, "args");
            if (typeof paramName === "string" && methodArgs !== null) {
              for (const arg of [...kids(methodArgs, "posonlyargs"), ...kids(methodArgs, "args")]) {
                if (scalar(arg, "arg") !== paramName) continue;
                const annotation = kid(arg, "annotation");
                if (annotation !== null) return tsTypeFromAnnotation(annotation) ?? "unknown";
              }
            }
          }
          return "unknown";
        }
      }
      for (const entry of Object.values(record["fields"] ?? record)) {
        if (Array.isArray(entry)) stack.push(...entry);
        else if (typeof entry === "object" && entry !== null) stack.push(entry);
      }
    }
  }
  return "unknown";
}

// Reverse of tsTypeFromAnnotation for the small set of field type texts — powers
// typed self.<field> arithmetic.
function tsTextToCommonType(text: string | null): CommonType | null {
  if (text === null) return null;
  const mapping: Record<string, CommonType> = {
    number: { kind: "number" },
    string: { kind: "string" },
    boolean: { kind: "boolean" },
    object: { kind: "object" },
    unknown: { kind: "unknown" },
  };
  const hit = mapping[text];
  if (hit !== undefined) return hit;
  if (text.startsWith("Array<") || text.startsWith("Set<")) {
    return { kind: "array", elementType: UNKNOWN };
  }
  if (text.startsWith("Record<")) {
    return { kind: "map", keyType: UNKNOWN, valueType: UNKNOWN };
  }
  if (/^[A-Z]/.test(text)) return { kind: "instance", className: text };
  return null;
}

function annotateUnknown(): AnnotatedType {
  return { type: UNKNOWN, origin: "inferred", confidence: "unknown", span: null };
}

// TS primitive text for a literal dict VALUE element (Record value union member);
// "unknown" for anything non-literal — never invents a deeper type.
function literalTsTypeText(node: AstNode): string {
  if (node.kind === "Constant") {
    const value = node.fields["value"];
    if (typeof value === "number") return "number";
    if (typeof value === "string") return "string";
    if (typeof value === "boolean") return "boolean";
  }
  if (node.kind === "UnaryOp" && kid(node, "op")?.kind === "USub") {
    const operand = kid(node, "operand");
    if (
      operand !== null &&
      operand.kind === "Constant" &&
      typeof operand.fields["value"] === "number"
    ) {
      return "number";
    }
  }
  return "unknown";
}

// CommonType for a literal initializer (let bindings keep arithmetic idiomatic);
// null for anything dynamic.
function constantAnnotatedType(node: AstNode): AnnotatedType | null {
  if (node.kind === "Constant") {
    const value = node.fields["value"];
    if (typeof value === "number") {
      return {
        type: { kind: "number", numberKind: Number.isInteger(value) ? "int" : "float" },
        origin: "inferred",
        confidence: "approximate",
        span: node.span ?? null,
      };
    }
    if (typeof value === "string") {
      return {
        type: { kind: "string" },
        origin: "inferred",
        confidence: "exact",
        span: node.span ?? null,
      };
    }
    if (typeof value === "boolean") {
      return {
        type: { kind: "boolean" },
        origin: "inferred",
        confidence: "exact",
        span: node.span ?? null,
      };
    }
  }
  if (node.kind === "UnaryOp" && kid(node, "op")?.kind === "USub") {
    const operand = constantAnnotatedType(kid(node, "operand") ?? node);
    return operand;
  }
  if (node.kind === "List") {
    return {
      type: { kind: "array", elementType: UNKNOWN },
      origin: "inferred",
      confidence: "approximate",
      span: node.span ?? null,
    };
  }
  if (node.kind === "Dict") {
    return {
      type: { kind: "map", keyType: UNKNOWN, valueType: UNKNOWN },
      origin: "inferred",
      confidence: "approximate",
      span: node.span ?? null,
    };
  }
  if (node.kind === "Set") {
    return {
      type: { kind: "set", elementType: UNKNOWN },
      origin: "inferred",
      confidence: "approximate",
      span: node.span ?? null,
    };
  }
  return null;
}
