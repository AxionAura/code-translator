// Python semantic analyzer: builds the language-neutral SemanticModel from the CPython
// bridge's ParseResult. The bridge's symtable scope tree is authoritative for symbol
// SETS and flags (local/free/global/parameter/imported); the AST walk supplies
// declarations, references, spans, and conservative type inference. Python semantics
// are preserved explicitly: class-body scopes are not visible to methods, free
// variables resolve to the enclosing function's binding (closures), `global` writes
// resolve to module bindings, and comprehension scopes are usually inlined (PEP 709).
import type { AnnotatedType, CommonType } from "./common-type.js";
import { UNKNOWN, annotate, unknownType } from "./common-type.js";
import type { AstNode, AstValue } from "./ast-node.js";
import type { ParseResult, SourceLanguage } from "./parse-result.js";
import type { ScopeInfo } from "./scope.js";
import type {
  ReferenceContext,
  SymbolReference,
  ScopeKind,
  ScopeNode,
  SemanticDiagnostic,
  SemanticModel,
  SymbolEntry,
  SymbolKind,
} from "./semantic.js";
import type { SourceSpan } from "./source-span.js";

const CLASS_SCOPE_NOTE = "python: class-body scope is not visible to methods";
const ANNOTATION_SCOPE_NOTE = "python: PEP 749 deferred-annotation scope (synthetic)";

interface PyScopeRecord {
  readonly id: string;
  readonly info: ScopeInfo;
  readonly parent: string | null;
  readonly children: string[];
}

interface PendingReference {
  readonly name: string;
  readonly span: SourceSpan;
  readonly context: ReferenceContext;
  readonly scopeId: string;
}

interface DeclarationDraft {
  name: string;
  kind: SymbolKind;
  span: SourceSpan | null;
  type: AnnotatedType | null;
  imported: boolean;
  importSpecifier: string | null;
  importedName: string | null;
}

// Envelope accessors for the CPython AST shape (see parser-py README).
export function pyKid(node: AstNode, name: string): AstNode | null {
  const value = node.fields[name];
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("kind" in value)) {
    return null;
  }
  return value as AstNode;
}

export function pyKids(node: AstNode, name: string): AstNode[] {
  const value = node.fields[name];
  return Array.isArray(value) ? (value as AstNode[]) : [];
}

export function pyScalar(node: AstNode, name: string): string | number | boolean | null {
  const value = node.fields[name];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

function isAstValue(value: AstValue): value is AstNode {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "kind" in value;
}

function childScopesByName(scopes: Map<string, PyScopeRecord>, id: string): Map<string, string[]> {
  const record = scopes.get(id);
  const byName = new Map<string, string[]>();
  if (record === undefined) return byName;
  for (const childId of record.children) {
    const child = scopes.get(childId);
    if (child === undefined) continue;
    const existing = byName.get(child.info.name) ?? [];
    existing.push(childId);
    byName.set(child.info.name, existing);
  }
  return byName;
}

export function analyzePythonModule(parseResult: ParseResult): SemanticModel {
  const diagnostics: SemanticDiagnostic[] = [];
  const scopes = new Map<string, ScopeNode>();
  const symbols = new Map<string, SymbolEntry>();
  const references: PendingReference[] = [];

  // Mirror the bridge's symtable tree with deterministic ids ("s", "s.0", "s.0.1"...).
  const symScopes = new Map<string, PyScopeRecord>();
  const rootInfo = parseResult.scopes;
  if (rootInfo !== null) {
    const assignIds = (info: ScopeInfo, parent: string | null, id: string): void => {
      symScopes.set(id, { id, info, parent, children: [] });
      info.children.forEach((child, index) => {
        const childId = `${id}.${String(index)}`;
        symScopes.get(id)?.children.push(childId);
        assignIds(child, id, childId);
      });
    };
    assignIds(rootInfo, null, "s");
  }

  const rootSymId = "s";

  // symtable flags per (scope, name) — needed during the walk (declaration
  // eligibility for global/nonlocal targets), so built up front.
  const flagsByScopeName = new Map<string, Record<string, boolean>>();
  for (const [symId, record] of symScopes) {
    for (const symbol of record.info.symbols) {
      flagsByScopeName.set(`${symId}\u0000${symbol.name}`, symbol.flags);
    }
  }
  const moduleScopeId = "scope:module";
  scopes.set(moduleScopeId, {
    id: moduleScopeId,
    kind: "module",
    name: "<module>",
    language: "python",
    span: null,
    parent: null,
    children: [],
    symbolIds: [],
    notes: [],
  });

  const declarations = new Map<string, DeclarationDraft>(); // key: `${symScopeId}\u0000${name}`

  function declare(symScopeId: string, draft: DeclarationDraft): void {
    const key = `${symScopeId}\u0000${draft.name}`;
    const existing = declarations.get(key);
    if (existing === undefined) {
      declarations.set(key, draft);
      return;
    }
    // Python allows rebinding (def f; def f). First declaration wins for span/kind;
    // an explicit type annotation beats an inferred type regardless of order.
    if (existing.type === null && draft.type !== null) {
      declarations.set(key, { ...existing, type: draft.type });
    }
  }

  // ---- type inference ---------------------------------------------------------------

  function inferExpression(node: AstNode | null): AnnotatedType | null {
    if (node === null) return null;
    switch (node.kind) {
      case "Constant": {
        const value = node.fields["value"];
        if (value === null) return annotate({ kind: "null" }, "inferred", "exact", node.span);
        if (typeof value === "boolean")
          return annotate({ kind: "literal", value }, "inferred", "exact", node.span);
        if (typeof value === "number") {
          const numberKind = Number.isInteger(value) ? ("int" as const) : ("float" as const);
          return annotate({ kind: "number", numberKind }, "inferred", "exact", node.span);
        }
        if (typeof value === "string")
          return annotate({ kind: "literal", value }, "inferred", "exact", node.span);
        if (typeof value === "object" && "tag" in value) {
          const tagged = value as { tag: string; decimal?: string };
          if (tagged.tag === "int" && typeof tagged.decimal === "string") {
            return annotate(
              { kind: "literal", value: tagged.decimal, literalKind: "bigint" },
              "inferred",
              "exact",
              node.span,
            );
          }
          if (tagged.tag === "bytes")
            return annotate({ kind: "bytes" }, "inferred", "exact", node.span);
          if (tagged.tag === "complex") return unknownType(node.span);
          if (tagged.tag === "ellipsis") return unknownType(node.span);
        }
        return unknownType(node.span);
      }
      case "List": {
        const elements = pyKids(node, "elts");
        return annotate(
          { kind: "array", elementType: inferredElementType(elements) },
          "inferred",
          elements.every((e) => e.kind === "Constant") ? "exact" : "approximate",
          node.span,
        );
      }
      case "Tuple": {
        const elements = pyKids(node, "elts").map(
          (element) => inferExpression(element)?.type ?? UNKNOWN,
        );
        return annotate({ kind: "tuple", elements }, "inferred", "approximate", node.span);
      }
      case "Set": {
        const elements = pyKids(node, "elts");
        return annotate(
          { kind: "set", elementType: inferredElementType(elements) },
          "inferred",
          "approximate",
          node.span,
        );
      }
      case "Dict": {
        const keys = pyKids(node, "keys");
        const values = pyKids(node, "values");
        const allStringKeys = keys.every(
          (key) =>
            key !== null && key.kind === "Constant" && typeof key.fields["value"] === "string",
        );
        const valueTypes = values.map((value) => inferExpression(value)?.type ?? UNKNOWN);
        const mergedValue = valueTypes.length === 0 ? UNKNOWN : valueTypes[0]!;
        return annotate(
          {
            kind: "map",
            keyType: allStringKeys ? { kind: "string" } : UNKNOWN,
            valueType: valueTypes.every((v) => JSON.stringify(v) === JSON.stringify(mergedValue))
              ? mergedValue
              : UNKNOWN,
          },
          "inferred",
          "approximate",
          node.span,
        );
      }
      case "JoinedStr":
        return annotate({ kind: "string" }, "inferred", "exact", node.span);
      case "BinOp": {
        const left = inferExpression(pyKid(node, "left"));
        const right = inferExpression(pyKid(node, "right"));
        const operator = pyKid(node, "op");
        if (
          left?.type.kind === "number" &&
          right?.type.kind === "number" &&
          left.type.numberKind === "int" &&
          right.type.numberKind === "int" &&
          operator?.kind !== "Div"
        ) {
          return annotate(
            { kind: "number", numberKind: "int" },
            "inferred",
            "approximate",
            node.span,
          );
        }
        if (left?.type.kind === "number" && right?.type.kind === "number") {
          return annotate(
            { kind: "number", numberKind: "float" },
            "inferred",
            "approximate",
            node.span,
          );
        }
        if (
          left?.type.kind === "string" &&
          right?.type.kind === "string" &&
          operator?.kind === "Add"
        ) {
          return annotate({ kind: "string" }, "inferred", "approximate", node.span);
        }
        return unknownType(node.span);
      }
      case "BoolOp":
      case "Compare":
      case "UnaryOp": {
        const operator = pyKid(node, "op");
        if (node.kind === "UnaryOp" && operator?.kind !== "Not") return unknownType(node.span);
        return annotate({ kind: "boolean" }, "inferred", "approximate", node.span);
      }
      default:
        // Analyzed-but-dynamic: calls, names, attribute chains, comprehensions...
        return unknownType(node.span);
    }
  }

  function inferredElementType(elements: AstNode[]): CommonType {
    const inferred = elements.map((element) => inferExpression(element)?.type);
    const first = inferred[0];
    if (first !== undefined && inferred.every((t) => JSON.stringify(t) === JSON.stringify(first))) {
      return first ?? UNKNOWN;
    }
    return UNKNOWN;
  }

  // Python annotations map for the shared subset; anything else stays an explicit
  // unknown (never an invented concrete type).
  function annotationToType(node: AstNode | null): AnnotatedType | null {
    if (node === null) return null;
    const exact = (type: CommonType): AnnotatedType =>
      annotate(type, "explicit", "exact", node.span);
    const approximate = (type: CommonType): AnnotatedType =>
      annotate(type, "explicit", "approximate", node.span);
    switch (node.kind) {
      case "Name": {
        const name = pyScalar(node, "id");
        if (name === "int") return exact({ kind: "number", numberKind: "int" });
        if (name === "float") return exact({ kind: "number", numberKind: "float" });
        if (name === "str") return exact({ kind: "string" });
        if (name === "bool") return exact({ kind: "boolean" });
        if (name === "bytes") return exact({ kind: "bytes" });
        if (name === "object") return exact({ kind: "object" });
        if (name === "None" || name === "NoneType") return exact({ kind: "null" });
        if (typeof name === "string") return approximate({ kind: "instance", className: name });
        return unknownType(node.span);
      }
      case "BinOp": {
        // PEP 604 unions: `X | Y`, `X | None`.
        const left = annotationToType(pyKid(node, "left"));
        const right = annotationToType(pyKid(node, "right"));
        if (left !== null && right !== null) {
          const members: CommonType[] = [];
          for (const annotatedType of [left.type, right.type]) {
            if (annotatedType.kind === "union") members.push(...annotatedType.members);
            else members.push(annotatedType);
          }
          return annotate({ kind: "union", members }, "explicit", "exact", node.span);
        }
        return unknownType(node.span);
      }
      case "Subscript": {
        const base = pyKid(node, "value");
        const slice = pyKid(node, "slice");
        const baseName = base?.kind === "Name" ? pyScalar(base, "id") : null;
        const T = (): CommonType => {
          const inner = slice === null ? null : annotationToType(slice);
          if (slice !== null && inner === null) {
            const tupleElements = pyKids(slice, "elts");
            if (tupleElements.length > 0) {
              return {
                kind: "tuple",
                elements: tupleElements.map((e) => annotationToType(e)?.type ?? UNKNOWN),
              };
            }
          }
          return inner?.type ?? UNKNOWN;
        };
        if (baseName === "list") return approximate({ kind: "array", elementType: T() });
        if (baseName === "set") return approximate({ kind: "set", elementType: T() });
        if (baseName === "frozenset") return approximate({ kind: "set", elementType: T() });
        if (baseName === "tuple") {
          const elements = slice === null ? [] : pyKids(slice, "elts");
          if (elements.length > 0) {
            return approximate({
              kind: "tuple",
              elements: elements.map((e) => annotationToType(e)?.type ?? UNKNOWN),
            });
          }
          return approximate({ kind: "array", elementType: UNKNOWN });
        }
        if (baseName === "dict") {
          const args = slice === null ? [] : pyKids(slice, "elts");
          return approximate({
            kind: "map",
            keyType: args[0] !== undefined ? (annotationToType(args[0])?.type ?? UNKNOWN) : UNKNOWN,
            valueType:
              args[1] !== undefined ? (annotationToType(args[1])?.type ?? UNKNOWN) : UNKNOWN,
          });
        }
        if (baseName === "Optional") {
          const inner = annotationToType(slice);
          if (inner !== null)
            return approximate({ kind: "union", members: [inner.type, { kind: "null" }] });
          return unknownType(node.span);
        }
        return unknownType(node.span);
      }
      case "Constant": {
        // `None` in annotation position is the Constant singleton; string annotations
        // (forward references) stay unknown - they are not evaluated here.
        if (node.fields["value"] === null) return exact({ kind: "null" });
        return unknownType(node.span);
      }
      default:
        return unknownType(node.span);
    }
  }

  // ---- AST walk ---------------------------------------------------------------------

  function declareTargetIfLocal(name: string, scopeId: string): boolean {
    // `global x` / `nonlocal x` assignments write a binding owned by another scope;
    // the symtable flags are the authority (module-scope names are isLocal there too).
    const flags = flagsByScopeName.get(`${scopeId}\u0000${name}`);
    if (flags === undefined) return true; // defensive: symtable knows every assignment
    return flags["isLocal"] === true || flags["isParameter"] === true;
  }

  function bindTargets(
    target: AstNode,
    kind: SymbolKind,
    type: AnnotatedType | null,
    scopeId: string,
  ): void {
    switch (target.kind) {
      case "Name": {
        const name = String(pyScalar(target, "id") ?? "");
        if (name === "") break;
        references.push({ name, span: target.span!, context: "write", scopeId });
        if (declareTargetIfLocal(name, scopeId)) {
          declare(scopeId, {
            name,
            kind,
            span: target.span,
            type,
            imported: false,
            importSpecifier: null,
            importedName: null,
          });
        }
        break;
      }
      case "Tuple":
      case "List":
        for (const element of pyKids(target, "elts")) bindTargets(element, kind, null, scopeId);
        break;
      case "Starred":
        bindTargets(pyKid(target, "value") ?? target, kind, null, scopeId);
        break;
      case "Attribute":
      case "Subscript":
        break; // attribute/subscript assignments are not name bindings
      default:
        break;
    }
  }

  function nameOf(node: AstNode): string {
    return String(pyScalar(node, "id") ?? "");
  }

  function bindParameters(args: AstNode, scopeId: string): void {
    const groups: AstNode[][] = [
      pyKids(args, "posonlyargs"),
      pyKids(args, "args"),
      pyKids(args, "kwonlyargs"),
    ];
    for (const group of groups) {
      for (const arg of group) {
        const annotation = annotationToType(pyKid(arg, "annotation"));
        declare(scopeId, {
          name: String(pyScalar(arg, "arg") ?? ""),
          kind: "parameter",
          span: arg.span,
          type: annotation,
          imported: false,
          importSpecifier: null,
          importedName: null,
        });
      }
    }
    for (const key of ["vararg", "kwarg"] as const) {
      const arg = pyKid(args, key);
      if (arg !== null) {
        declare(scopeId, {
          name: String(pyScalar(arg, "arg") ?? ""),
          kind: "parameter",
          span: arg.span,
          type: annotationToType(pyKid(arg, "annotation")),
          imported: false,
          importSpecifier: null,
          importedName: null,
        });
      }
    }
  }

  function findChildSymScope(
    scopeId: string,
    name: string,
    fallbackLine: number | null,
  ): string | null {
    const byName = childScopesByName(symScopes, scopeId).get(name);
    if (byName === undefined) return null;
    if (byName.length === 1) return byName[0]!;
    // Multiple same-name scopes: pick the first whose header line is at/after the
    // definition, else the first unmatched — deterministic either way.
    for (const candidate of byName) {
      const info = symScopes.get(candidate)?.info;
      if (
        info !== undefined &&
        fallbackLine !== null &&
        info.line !== null &&
        info.line >= fallbackLine
      ) {
        return candidate;
      }
    }
    return byName[0] ?? null;
  }

  function walk(node: AstNode, symScopeId: string): void {
    switch (node.kind) {
      case "FunctionDef":
      case "AsyncFunctionDef": {
        const name = String(pyScalar(node, "name") ?? "");
        const returnType = annotationToType(pyKid(node, "returns"));
        declare(symScopeId, {
          name,
          kind: "function",
          span: node.span,
          type: returnType,
          imported: false,
          importSpecifier: null,
          importedName: null,
        });
        const fnScopeId = findChildSymScope(symScopeId, name, node.span?.start.line ?? null);
        if (fnScopeId !== null) {
          const args = pyKid(node, "args");
          if (args !== null) bindParameters(args, fnScopeId);
          // CPython bodies are statement LISTS (a pyKid here would silently drop them).
          for (const statement of pyKids(node, "body")) walk(statement, fnScopeId);
          for (const decorator of pyKids(node, "decorator_list")) walk(decorator, symScopeId);
        }
        return;
      }
      case "ClassDef": {
        const name = String(pyScalar(node, "name") ?? "");
        declare(symScopeId, {
          name,
          kind: "class",
          span: node.span,
          type: annotate({ kind: "class", name }, "inferred", "approximate", node.span),
          imported: false,
          importSpecifier: null,
          importedName: null,
        });
        for (const base of pyKids(node, "bases")) walk(base, symScopeId);
        for (const keyword of pyKids(node, "keywords")) walk(keyword, symScopeId);
        for (const decorator of pyKids(node, "decorator_list")) walk(decorator, symScopeId);
        const classScopeId = findChildSymScope(symScopeId, name, node.span?.start.line ?? null);
        if (classScopeId !== null) {
          for (const statement of pyKids(node, "body")) walk(statement, classScopeId);
        }
        return;
      }
      case "Assign": {
        const valueType = inferExpression(pyKid(node, "value"));
        for (const target of pyKids(node, "targets"))
          bindTargets(target, "variable", valueType, symScopeId);
        const value = pyKid(node, "value");
        if (value !== null) walk(value, symScopeId);
        return;
      }
      case "AnnAssign": {
        const annotation = annotationToType(pyKid(node, "annotation"));
        const target = pyKid(node, "target");
        if (target !== null) bindTargets(target, "variable", annotation, symScopeId);
        const value = pyKid(node, "value");
        if (value !== null) walk(value, symScopeId);
        return;
      }
      case "AugAssign": {
        const target = pyKid(node, "target");
        if (target !== null && target.kind === "Name") {
          references.push({
            name: nameOf(target),
            span: target.span!,
            context: "write",
            scopeId: symScopeId,
          });
          references.push({
            name: nameOf(target),
            span: target.span!,
            context: "read",
            scopeId: symScopeId,
          });
        }
        const value = pyKid(node, "value");
        if (value !== null) walk(value, symScopeId);
        return;
      }
      case "For":
      case "AsyncFor": {
        const target = pyKid(node, "target");
        if (target !== null) bindTargets(target, "variable", null, symScopeId);
        for (const key of ["iter", "target", "body", "orelse"] as const) {
          const child = pyKid(node, key);
          if (child !== null) walk(child, symScopeId);
        }
        return;
      }
      case "With":
      case "AsyncWith": {
        for (const item of pyKids(node, "items")) {
          const context = pyKid(item, "context_expr");
          if (context !== null) walk(context, symScopeId);
          const optionalVars = pyKid(item, "optional_vars");
          if (optionalVars !== null) bindTargets(optionalVars, "variable", null, symScopeId);
        }
        const body = pyKid(node, "body");
        if (body !== null) walk(body, symScopeId);
        return;
      }
      case "Try":
      case "TryStar": {
        for (const key of ["body", "handlers", "orelse", "finalbody"] as const) {
          for (const child of pyKids(node, key)) walk(child, symScopeId);
        }
        return;
      }
      case "ExceptHandler": {
        const nameNode = pyKid(node, "name");
        if (nameNode !== null && nameNode.kind === "Name") {
          declare(symScopeId, {
            name: nameOf(nameNode),
            kind: "variable",
            span: nameNode.span,
            type: null,
            imported: false,
            importSpecifier: null,
            importedName: null,
          });
        }
        const body = pyKid(node, "body");
        if (body !== null) walk(body, symScopeId);
        return;
      }
      case "Import":
      case "ImportFrom": {
        const isFrom = node.kind === "ImportFrom";
        const moduleSpecifier = isFrom
          ? `${".".repeat(Number(pyScalar(node, "level") ?? 0))}${String(pyScalar(node, "module") ?? "")}`
          : "";
        for (const alias of pyKids(node, "names")) {
          const aliasName = String(pyScalar(alias, "name") ?? "");
          const asname = pyScalar(alias, "asname");
          if (isFrom) {
            declare(symScopeId, {
              name: typeof asname === "string" ? asname : aliasName,
              kind: "import",
              span: alias.span,
              type: null,
              imported: true,
              importSpecifier: moduleSpecifier,
              importedName: aliasName === "*" ? "*" : aliasName,
            });
          } else {
            const root = aliasName.split(".")[0] ?? aliasName;
            declare(symScopeId, {
              name: typeof asname === "string" ? asname : root,
              kind: "import",
              span: alias.span,
              type: null,
              imported: true,
              importSpecifier: aliasName,
              importedName: null,
            });
          }
        }
        return;
      }
      case "Name": {
        const context = pyKid(node, "ctx");
        const contextKind: ReferenceContext =
          context?.kind === "Store" ? "write" : context?.kind === "Del" ? "delete" : "read";
        references.push({
          name: nameOf(node),
          span: node.span!,
          context: contextKind,
          scopeId: symScopeId,
        });
        return;
      }
      case "comprehension": {
        // PEP 709 (3.12+): comprehension scopes are usually inlined into the
        // enclosing scope, so comprehension targets are ordinary locals here.
        const target = pyKid(node, "target");
        if (target !== null) bindTargets(target, "variable", null, symScopeId);
        const iterator = pyKid(node, "iter");
        if (iterator !== null) walk(iterator, symScopeId);
        for (const condition of pyKids(node, "ifs")) walk(condition, symScopeId);
        return;
      }
      case "Lambda": {
        const lambdaScopeId = findChildSymScope(
          symScopeId,
          "lambda",
          node.span?.start.line ?? null,
        );
        if (lambdaScopeId !== null) {
          const args = pyKid(node, "args");
          if (args !== null) bindParameters(args, lambdaScopeId);
          const body = pyKid(node, "body");
          if (body !== null) walk(body, lambdaScopeId);
        }
        return;
      }
      default: {
        for (const value of Object.values(node.fields) as AstValue[]) {
          const values = Array.isArray(value) ? value : [value];
          for (const item of values) {
            if (isAstValue(item)) walk(item, symScopeId);
          }
        }
      }
    }
  }

  const moduleAst = parseResult.ast;
  for (const statement of pyKids(moduleAst, "body")) walk(statement, rootSymId);

  // ---- materialize scopes + symbols --------------------------------------------------

  const scopeIdFor = (symId: string): string =>
    symId === rootSymId ? moduleScopeId : `scope:${symId}`;
  for (const [symId, record] of symScopes) {
    const id = scopeIdFor(symId);
    if (id === moduleScopeId) continue;
    const kind: ScopeKind =
      record.info.kind === "class"
        ? "class"
        : record.info.kind === "function"
          ? "function"
          : record.info.kind === "annotation"
            ? "type"
            : "block";
    scopes.set(id, {
      id,
      kind,
      name: record.info.name,
      language: "python",
      span: null,
      parent: record.parent === null ? null : scopeIdFor(record.parent),
      children: record.children.map((child) => scopeIdFor(child)),
      symbolIds: [],
      notes: kind === "class" ? [CLASS_SCOPE_NOTE] : kind === "type" ? [ANNOTATION_SCOPE_NOTE] : [],
    });
  }
  // Link child ids on the module scope.
  const moduleChildren = symScopes.get(rootSymId)?.children.map((child) => scopeIdFor(child)) ?? [];
  scopes.set(moduleScopeId, { ...scopes.get(moduleScopeId)!, children: moduleChildren });

  // Symbol materialization from declarations.
  const symbolIdFor = (symScopeId: string, name: string): string =>
    `${scopeIdFor(symScopeId)}#${name}`;
  for (const [key, draft] of declarations) {
    const [symScopeId, name] = key.split("\u0000");
    const id = symbolIdFor(symScopeId!, name!);
    const scopeId = scopeIdFor(symScopeId!);
    const flags = flagsByScopeName.get(key) ?? {};
    symbols.set(id, {
      id,
      name: name!,
      kind: draft.kind,
      scopeId,
      declarationSpan: draft.span,
      references: [],
      type: draft.type,
      mutability: draft.kind === "constant" ? "readonly" : "mutable",
      exported: false,
      imported: draft.imported,
      importSpecifier: draft.importSpecifier,
      importedName: draft.importedName,
      namespace: "value",
      languageFlags: {
        isFree: flags["isFree"] ?? false,
        isGlobal: flags["isGlobal"] ?? false,
        isNonlocal: flags["isNonlocal"] ?? false,
        isDeclaredGlobal: flags["isDeclaredGlobal"] ?? false,
      },
    });
  }

  function lookupDeclaration(symScopeId: string, name: string): string | null {
    const id = symbolIdFor(symScopeId, name);
    return symbols.has(id) ? id : null;
  }

  function resolveReference(pending: PendingReference): string | null {
    const flags = flagsByScopeName.get(`${pending.scopeId}\u0000${pending.name}`);
    if (flags === undefined) return null; // builtin or dynamic — honestly unresolved here
    const isDeclaredHere = lookupDeclaration(pending.scopeId, pending.name);
    if (
      flags["isLocal"] === true ||
      flags["isParameter"] === true ||
      flags["isImported"] === true
    ) {
      return isDeclaredHere;
    }
    if (flags["isFree"] === true) {
      // Closure capture: nearest enclosing scope that declares the binding locally.
      let parent = symScopes.get(pending.scopeId)?.parent ?? null;
      while (parent !== null) {
        const parentDeclaration = lookupDeclaration(parent, pending.name);
        if (parentDeclaration !== null) return parentDeclaration;
        const parentFlags = flagsByScopeName.get(`${parent}\u0000${pending.name}`);
        if (parentFlags !== undefined && (parentFlags["isLocal"] || parentFlags["isParameter"])) {
          return parentDeclaration;
        }
        parent = symScopes.get(parent)?.parent ?? null;
      }
      return null;
    }
    if (flags["isGlobal"] === true) {
      const moduleDeclaration = lookupDeclaration(rootSymId, pending.name);
      if (moduleDeclaration !== null) return moduleDeclaration;
      // A WRITE through `global x` creates the module binding; a read of a name that
      // is assigned nowhere is a runtime NameError and stays honestly unresolved.
      if (pending.context !== "write") return null;
      const synthesizedId = symbolIdFor(rootSymId, pending.name);
      if (!symbols.has(synthesizedId)) {
        symbols.set(synthesizedId, {
          id: synthesizedId,
          name: pending.name,
          kind: "variable",
          scopeId: moduleScopeId,
          declarationSpan: pending.span,
          references: [],
          type: null,
          mutability: "mutable",
          exported: false,
          imported: false,
          importSpecifier: null,
          importedName: null,
          namespace: "value",
          languageFlags: { synthesizedFromGlobalWrite: true },
        });
      }
      return synthesizedId;
    }
    return null;
  }

  const unresolvedReferences: Array<{
    name: string;
    reference: { span: SourceSpan; context: ReferenceContext; scopeId: string };
  }> = [];
  for (const pending of references) {
    const symbolId = resolveReference(pending);
    if (symbolId !== null) {
      (symbols.get(symbolId)?.references as SymbolReference[]).push({
        span: pending.span,
        context: pending.context,
        scopeId: pending.scopeId,
      });
    } else {
      unresolvedReferences.push({
        name: pending.name,
        reference: { span: pending.span, context: pending.context, scopeId: pending.scopeId },
      });
    }
  }

  // Attach symbol ids to their scopes (drafts are still mutable here).
  for (const symbol of symbols.values()) {
    const scope = scopes.get(symbol.scopeId);
    if (scope !== undefined) {
      (scope.symbolIds as string[]).push(symbol.id);
    }
  }

  return {
    language: "python" satisfies SourceLanguage,
    filename: parseResult.filename,
    scopes: Object.fromEntries(scopes),
    symbols: Object.fromEntries(symbols),
    rootScopeId: moduleScopeId,
    diagnostics,
    unresolvedReferences,
  };
}
