// JavaScript/TypeScript semantic analyzer: builds the SemanticModel from the oxc/Babel
// ParseResult (M3 owns this — M2 intentionally left JS scopes null). JS scoping rules
// are modeled explicitly: `var` hoists to the nearest function/module scope, let/const
// bind to the current block, function bodies are transparent (their top-level block
// shares the function scope), catch clauses get their own scope, and class bodies form
// class scopes. TypeScript declarations occupy the type namespace (`DeclarationNamespace`)
// so value/type distinctions survive. The walk is iterative (explicit stack) because
// normalized JS trees may be deep. Type inference is conservative: literals, template
// strings, array/object shapes, and explicit TS annotations; everything dynamic stays
// unknown. Type-nodes (TS*) are not walked for value references — their identifiers are
// type references, recorded nowhere in v1 (documented limitation).
import type { AnnotatedType, CommonType } from "./common-type.js";
import { UNKNOWN, annotate, unknownType } from "./common-type.js";
import type { AstNode, AstValue } from "./ast-node.js";
import type { ParseResult } from "./parse-result.js";
import type {
  DeclarationNamespace,
  SymbolReference,
  ReferenceContext,
  ScopeKind,
  SemanticDiagnostic,
  SemanticModel,
  SymbolEntry,
  SymbolKind,
} from "./semantic.js";

interface PendingReference {
  readonly name: string;
  readonly span: NonNullable<AstNode["span"]>;
  readonly context: ReferenceContext;
  readonly scopeId: string;
}

interface DeclarationDraft {
  name: string;
  kind: SymbolKind;
  span: AstNode["span"];
  type: AnnotatedType | null;
  mutability: "mutable" | "readonly" | "unknown";
  namespace: DeclarationNamespace;
  imported: boolean;
  importSpecifier: string | null;
  importedName: string | null;
  flags: Record<string, boolean>;
}

interface JsScopeRecord {
  readonly id: string;
  readonly kind: ScopeKind;
  readonly name: string | null;
  readonly span: AstNode["span"];
  readonly parent: string | null;
  readonly children: string[];
  readonly symbolIds: string[];
}

function isRecord(value: AstValue | undefined): value is AstNode {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "kind" in value;
}

function jsKid(node: AstNode, name: string): AstNode | null {
  const value = node.fields[name];
  return isRecord(value) ? value : null;
}

function jsKids(node: AstNode, name: string): AstNode[] {
  const value = node.fields[name];
  return Array.isArray(value) ? (value as AstNode[]) : [];
}

function jsScalar(node: AstNode, name: string): string | number | boolean | null {
  const value = node.fields[name];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

export function analyzeJavaScriptModule(parseResult: ParseResult): SemanticModel {
  const diagnostics: SemanticDiagnostic[] = [];
  const scopes = new Map<string, JsScopeRecord>();
  const declarations = new Map<string, DeclarationDraft>(); // key: scopeId\0name (first wins)
  const references: PendingReference[] = [];
  let scopeCounter = 0;

  function newScope(
    kind: ScopeKind,
    name: string | null,
    span: AstNode["span"],
    parent: string | null,
  ): string {
    scopeCounter += 1;
    const id = `js${String(scopeCounter)}`;
    scopes.set(id, { id, kind, name, span, parent, children: [], symbolIds: [] });
    if (parent !== null) scopes.get(parent)?.children.push(id);
    return id;
  }

  function declare(scopeId: string, draft: DeclarationDraft): void {
    const key = `${scopeId}\u0000${draft.name}`;
    const existing = declarations.get(key);
    if (existing === undefined) {
      declarations.set(key, draft);
      return;
    }
    if (existing.type === null && draft.type !== null) {
      declarations.set(key, { ...existing, type: draft.type });
    }
  }

  // ---- types -------------------------------------------------------------------------

  function inferExpression(node: AstNode | null): AnnotatedType | null {
    if (node === null) return null;
    switch (node.kind) {
      case "Literal": {
        const value = node.fields["value"];
        if (typeof node.fields["bigint"] === "string") {
          return annotate(
            { kind: "literal", value: String(node.fields["bigint"]), literalKind: "bigint" },
            "inferred",
            "exact",
            node.span,
          );
        }
        if (typeof value === "number")
          return annotate(
            { kind: "number", numberKind: Number.isInteger(value) ? "int" : "float" },
            "inferred",
            "exact",
            node.span,
          );
        if (typeof value === "string")
          return annotate({ kind: "literal", value }, "inferred", "exact", node.span);
        if (typeof value === "boolean")
          return annotate({ kind: "literal", value }, "inferred", "exact", node.span);
        if (value === null) {
          const regex = node.fields["regex"];
          return regex === undefined
            ? annotate({ kind: "null" }, "inferred", "exact", node.span)
            : unknownType(node.span);
        }
        return unknownType(node.span);
      }
      case "TemplateLiteral":
        return annotate({ kind: "string" }, "inferred", "exact", node.span);
      case "ArrayExpression": {
        const elements = jsKids(node, "elements").map((element) => inferExpression(element)?.type);
        const first = elements[0];
        const uniform =
          first !== undefined && elements.every((t) => JSON.stringify(t) === JSON.stringify(first));
        return annotate(
          {
            kind: "array",
            elementType: uniform && first !== undefined ? (first ?? UNKNOWN) : UNKNOWN,
          },
          "inferred",
          "approximate",
          node.span,
        );
      }
      case "ObjectExpression":
        return annotate({ kind: "object" }, "inferred", "approximate", node.span);
      case "BinaryExpression": {
        const left = inferExpression(jsKid(node, "left"));
        const right = inferExpression(jsKid(node, "right"));
        if (String(jsScalar(node, "operator")) === "+" && left?.type.kind === "string") {
          return annotate({ kind: "string" }, "inferred", "approximate", node.span);
        }
        if (left?.type.kind === "number" && right?.type.kind === "number") {
          return annotate({ kind: "number" }, "inferred", "approximate", node.span);
        }
        return unknownType(node.span);
      }
      case "LogicalExpression":
      case "ConditionalExpression":
        return inferExpression(jsKid(node, "left") ?? jsKid(node, "consequent"));
      case "AwaitExpression": {
        const inner = inferExpression(jsKid(node, "argument"));
        if (inner?.type.kind === "promise") {
          return annotate(inner.type.valueType, "inferred", "approximate", node.span);
        }
        return unknownType(node.span);
      }
      default:
        return unknownType(node.span);
    }
  }

  // TS type-annotation nodes → CommonType for the shared subset.
  function mapTsType(node: AstNode | null): AnnotatedType | null {
    if (node === null) return null;
    return annotate(mapTsTypeInner(node), "explicit", "exact", node.span);
  }

  function mapTsTypeInner(node: AstNode): CommonType {
    if (node.kind === "TSTypeAnnotation") {
      return mapTsTypeInner(jsKid(node, "typeAnnotation") ?? node);
    }
    switch (node.kind) {
      case "TSStringKeyword":
        return { kind: "string" };
      case "TSNumberKeyword":
        return { kind: "number" };
      case "TSBooleanKeyword":
        return { kind: "boolean" };
      case "TSBigIntKeyword":
        return { kind: "bigint" };
      case "TSSymbolKeyword":
        return { kind: "symbol" };
      case "TSObjectKeyword":
        return { kind: "object" };
      case "TSNullKeyword":
        return { kind: "null" };
      case "TSUndefinedKeyword":
        return { kind: "undefined" };
      case "TSVoidKeyword":
        return { kind: "void" };
      case "TSNeverKeyword":
        return { kind: "never" };
      case "TSAnyKeyword":
        return { kind: "any" };
      case "TSUnknownKeyword":
        return { kind: "unknown" };
      case "TSLiteralType": {
        const literal = jsKid(node, "literal");
        if (literal === null) return UNKNOWN;
        const value = literal.fields["value"];
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          return { kind: "literal", value };
        }
        return UNKNOWN;
      }
      case "TSTypeLiteral":
        return { kind: "object" };
      case "TSArrayType": {
        const elementType = mapTsType(jsKid(node, "elementType"));
        return { kind: "array", elementType: elementType?.type ?? UNKNOWN };
      }
      case "TSTupleType":
        return {
          kind: "tuple",
          elements: jsKids(node, "elementTypes").map((t) => mapTsType(t)?.type ?? UNKNOWN),
        };
      case "TSUnionType":
      case "TSIntersectionType": {
        const members = jsKids(node, "types").map((t) => mapTsType(t)?.type ?? UNKNOWN);
        return node.kind === "TSUnionType"
          ? { kind: "union", members }
          : { kind: "intersection", members };
      }
      case "TSOptionalType": {
        const inner = mapTsType(jsKid(node, "typeAnnotation"));
        return { kind: "optional", innerType: inner?.type ?? UNKNOWN };
      }
      case "TSTypeReference": {
        const typeName = typeReferenceName(jsKid(node, "typeName"));
        const args = jsKids(node, "typeArguments");
        if (typeName === "Array" && args.length > 0) {
          return {
            kind: "array",
            elementType: mapTsType(jsKid(args[0]!, "typeArg"))?.type ?? UNKNOWN,
          };
        }
        if (typeName === "Promise" && args.length > 0) {
          return {
            kind: "promise",
            valueType: mapTsType(jsKid(args[0]!, "typeArg"))?.type ?? UNKNOWN,
          };
        }
        if (typeName !== null) return { kind: "instance", className: typeName };
        return UNKNOWN;
      }
      default:
        return UNKNOWN;
    }
  }

  function typeReferenceName(node: AstNode | null): string | null {
    if (node === null) return null;
    if (node.kind === "Identifier") return String(jsScalar(node, "name") ?? "");
    if (node.kind === "TSQualifiedName") {
      const left = typeReferenceName(jsKid(node, "left"));
      const right = typeReferenceName(jsKid(node, "right"));
      return left !== null && right !== null ? `${left}.${right}` : null;
    }
    return null;
  }

  // ---- walk --------------------------------------------------------------------------

  const rootScopeId = newScope("module", "<module>", null, null);

  function identifierName(node: AstNode | null): string | null {
    return node !== null && node.kind === "Identifier"
      ? String(jsScalar(node, "name") ?? "")
      : null;
  }

  function bindPattern(
    pattern: AstNode,
    scopeId: string,
    kind: SymbolKind,
    mutability: DeclarationDraft["mutability"],
    type: AnnotatedType | null,
    flags: Record<string, boolean>,
  ): void {
    switch (pattern.kind) {
      case "Identifier":
        declare(scopeId, {
          name: String(jsScalar(pattern, "name") ?? ""),
          kind,
          span: pattern.span,
          type,
          mutability,
          namespace: "value",
          imported: false,
          importSpecifier: null,
          importedName: null,
          flags,
        });
        break;
      case "ObjectPattern":
      case "ArrayPattern":
        for (const element of jsKids(pattern, "properties").concat(jsKids(pattern, "elements"))) {
          if (element === null) continue;
          const inner =
            element.kind === "RestElement"
              ? (jsKid(element, "argument") ?? element)
              : element.kind === "Property"
                ? (jsKid(element, "value") ?? element)
                : element;
          if (inner === null) continue;
          bindPattern(inner, scopeId, kind, mutability, null, flags);
        }
        break;
      case "AssignmentPattern":
        bindPattern(jsKid(pattern, "left") ?? pattern, scopeId, kind, mutability, null, flags);
        break;
      case "RestElement":
        bindPattern(jsKid(pattern, "argument") ?? pattern, scopeId, kind, mutability, null, flags);
        break;
      default:
        break;
    }
  }

  function nearestFunctionScope(scopeId: string): string {
    let current: string | null = scopeId;
    while (current !== null) {
      const scope = scopes.get(current);
      if (scope === undefined) break;
      if (scope.kind === "function" || scope.kind === "module") return current;
      current = scope.parent;
    }
    return rootScopeId;
  }

  function isFunctionBodyTransparent(
    parentKind: "statement" | "function-body" | "expression",
  ): boolean {
    return parentKind === "function-body";
  }

  function walkFunction(node: AstNode, scopeId: string): void {
    const fnScopeId = newScope("function", identifierName(jsKid(node, "id")), node.span, scopeId);
    const typeParams = jsKid(node, "typeParameters");
    if (typeParams !== null) {
      for (const param of jsKids(typeParams, "params")) {
        const name = identifierName(jsKid(param, "name"));
        if (name !== null) {
          declare(fnScopeId, {
            name,
            kind: "typeParameter",
            span: param.span,
            type: null,
            mutability: "readonly",
            namespace: "type",
            imported: false,
            importSpecifier: null,
            importedName: null,
            flags: {},
          });
        }
      }
    }
    const params = jsKids(node, "params");
    for (const param of params) {
      const annotation = mapTsType(jsKid(param, "typeAnnotation"));
      const pattern =
        param.kind === "TSParameterProperty" ? (jsKid(param, "parameter") ?? param) : param;
      if (
        pattern.kind === "Identifier" ||
        pattern.kind === "ObjectPattern" ||
        pattern.kind === "ArrayPattern" ||
        pattern.kind === "AssignmentPattern" ||
        pattern.kind === "RestElement"
      ) {
        bindPattern(pattern, fnScopeId, "parameter", "mutable", annotation, {});
      }
    }
    const body = jsKid(node, "body");
    if (body !== null) {
      if (body.kind === "BlockStatement") {
        // Transparent: the function body's top-level block shares the function scope.
        walkNode(body, fnScopeId, "function-body");
      } else {
        walkNode(body, fnScopeId, "statement");
      }
    }
  }

  function walkClass(node: AstNode, scopeId: string): void {
    const superClass = jsKid(node, "superClass");
    if (superClass !== null) walkNode(superClass, scopeId, "statement");
    const classScopeId = newScope("class", identifierName(jsKid(node, "id")), node.span, scopeId);
    for (const member of jsKids(jsKid(node, "body") ?? node, "body")) {
      if (member.kind === "MethodDefinition" || member.kind === "PropertyDefinition") {
        const key = jsKid(member, "key");
        const computed = member.fields["computed"] === true;
        const name = identifierName(key);
        if (name !== null) {
          declare(classScopeId, {
            name,
            kind: member.kind === "MethodDefinition" ? "method" : "property",
            span: member.span,
            type:
              member.kind === "PropertyDefinition"
                ? mapTsType(jsKid(member, "typeAnnotation"))
                : null,
            mutability:
              member.kind === "PropertyDefinition" && member.fields["readonly"] === true
                ? "readonly"
                : "mutable",
            namespace: "value",
            imported: false,
            importSpecifier: null,
            importedName: null,
            flags: {
              isStatic: member.fields["static"] === true,
              accessibility: member.fields["accessibility"] === true,
            },
          });
        }
        if (member.kind === "MethodDefinition") {
          const fnScopeId = newScope("function", name, member.span, classScopeId);
          const value = jsKid(member, "value");
          if (value !== null) {
            const params = jsKids(value, "params");
            for (const param of params) {
              const annotation = mapTsType(jsKid(param, "typeAnnotation"));
              if (param.kind === "Identifier") {
                bindPattern(param, fnScopeId, "parameter", "mutable", annotation, {});
              }
            }
            const fnBody = jsKid(value, "body");
            if (fnBody !== null) walkNode(fnBody, fnScopeId, "function-body");
          }
        } else if (computed && key !== null) {
          walkNode(key, classScopeId, "statement");
        }
        continue;
      }
      walkNode(member, classScopeId, "statement");
    }
  }

  function walkNode(
    node: AstNode,
    scopeId: string,
    context: "statement" | "function-body" | "expression",
  ): void {
    switch (node.kind) {
      case "Program": {
        for (const statement of jsKids(node, "body")) walkNode(statement, scopeId, "statement");
        return;
      }
      case "FunctionDeclaration": {
        const name = identifierName(jsKid(node, "id"));
        if (name !== null) {
          declare(scopeId, {
            name,
            kind: "function",
            span: node.span,
            type: null,
            mutability: "mutable",
            namespace: "value",
            imported: false,
            importSpecifier: null,
            importedName: null,
            flags: {
              async: node.fields["async"] === true,
              generator: node.fields["generator"] === true,
            },
          });
        }
        walkFunction(node, scopeId);
        return;
      }
      case "ClassDeclaration":
      case "ClassExpression": {
        const name = identifierName(jsKid(node, "id"));
        if (name !== null && node.kind === "ClassDeclaration") {
          declare(scopeId, {
            name,
            kind: "class",
            span: node.span,
            type: annotate({ kind: "class", name }, "inferred", "approximate", node.span),
            mutability: "mutable",
            namespace: "value",
            imported: false,
            importSpecifier: null,
            importedName: null,
            flags: {},
          });
        }
        walkClass(node, scopeId);
        return;
      }
      case "VariableDeclaration": {
        const declarationKind = String(jsScalar(node, "kind") ?? "let");
        const isVar = declarationKind === "var";
        const targetScopeId = isVar ? nearestFunctionScope(scopeId) : scopeId;
        const symbolKind: SymbolKind = declarationKind === "const" ? "constant" : "variable";
        const mutability = declarationKind === "const" ? "readonly" : "mutable";
        for (const declarator of jsKids(node, "declarations")) {
          const init = jsKid(declarator, "init");
          // An explicit annotation outranks inference; inference covers unannotated JS.
          let type = mapTsType(tsAnnotationOf(declarator));
          if (type === null) type = inferExpression(init);
          bindPattern(
            jsKid(declarator, "id") ?? declarator,
            targetScopeId,
            symbolKind,
            mutability,
            type,
            { isVar },
          );
          if (init !== null) {
            walkNode(init, targetScopeId, "expression");
          }
        }
        return;
      }
      case "ImportDeclaration": {
        const source = jsKid(node, "source");
        const specifier = source === null ? null : String(jsScalar(source, "value") ?? "");
        for (const importNode of jsKids(node, "specifiers")) {
          const local = jsKid(importNode, "local");
          const name = identifierName(local);
          if (name === null) continue;
          let importedName: string | null = null;
          if (importNode.kind === "ImportSpecifier") {
            const imported = jsKid(importNode, "imported");
            importedName =
              identifierName(imported) ??
              (imported === null ? null : String(jsScalar(imported, "value") ?? ""));
          }
          declare(rootScopeId, {
            name,
            kind: "import",
            span: importNode.span,
            type: null,
            mutability: "readonly",
            namespace: "value",
            imported: true,
            importSpecifier: specifier,
            importedName,
            flags: {},
          });
        }
        return;
      }
      case "ExportNamedDeclaration": {
        const declaration = jsKid(node, "declaration");
        if (declaration !== null) {
          walkNode(declaration, scopeId, "statement");
        }
        return;
      }
      case "ExportDefaultDeclaration": {
        const declaration = jsKid(node, "declaration");
        if (declaration !== null) walkNode(declaration, scopeId, "statement");
        return;
      }
      case "BlockStatement": {
        if (isFunctionBodyTransparent(context)) {
          // Transparency applies to the immediate body block only; nested blocks are
          // ordinary block scopes ("statement" context).
          for (const statement of jsKids(node, "body")) walkNode(statement, scopeId, "statement");
          return;
        }
        const blockScopeId = newScope("block", null, node.span, scopeId);
        for (const statement of jsKids(node, "body"))
          walkNode(statement, blockScopeId, "statement");
        return;
      }
      case "ForStatement":
      case "ForOfStatement":
      case "ForInStatement": {
        // ESTree spells for-of/for-in heads `left`; plain `for` uses `init`.
        const left = jsKid(node, "left") ?? jsKid(node, "init");
        const needsBlock =
          left !== null &&
          left.kind === "VariableDeclaration" &&
          String(jsScalar(left, "kind")) !== "var";
        const loopScopeId = needsBlock ? newScope("block", null, node.span, scopeId) : scopeId;
        if (left !== null) walkNode(left, loopScopeId, "statement");
        const right = jsKid(node, "right");
        if (right !== null) walkNode(right, loopScopeId, "expression");
        const body = jsKid(node, "body");
        if (body !== null) walkNode(body, loopScopeId, "statement");
        return;
      }
      case "TryStatement": {
        const block = jsKid(node, "block");
        if (block !== null) walkNode(block, scopeId, "statement");
        const handler = jsKid(node, "handler");
        if (handler !== null) {
          const catchScopeId = newScope("catch", null, handler.span, scopeId);
          const param = jsKid(handler, "param");
          if (param !== null) bindPattern(param, catchScopeId, "parameter", "mutable", null, {});
          const handlerBody = jsKid(handler, "body");
          if (handlerBody !== null) walkNode(handlerBody, catchScopeId, "function-body");
        }
        const finalizer = jsKid(node, "finalizer");
        if (finalizer !== null) walkNode(finalizer, scopeId, "statement");
        return;
      }
      case "Identifier": {
        if (context !== "expression") {
          // Statement-position identifiers here are binding leftovers already handled
          // (e.g. for-of targets walked via bindPattern); ignore double counting.
        }
        references.push({
          name: String(jsScalar(node, "name") ?? ""),
          span: node.span!,
          context: "read",
          scopeId,
        });
        return;
      }
      case "AssignmentExpression": {
        const left = jsKid(node, "left");
        if (left !== null) {
          if (left.kind === "Identifier") {
            references.push({
              name: String(jsScalar(left, "name") ?? ""),
              span: left.span!,
              context: "write",
              scopeId,
            });
          } else {
            walkNode(left, scopeId, "expression");
          }
        }
        const right = jsKid(node, "right");
        if (right !== null) walkNode(right, scopeId, "expression");
        return;
      }
      case "UpdateExpression": {
        const argument = jsKid(node, "argument");
        if (argument !== null && argument.kind === "Identifier") {
          references.push({
            name: String(jsScalar(argument, "name") ?? ""),
            span: argument.span!,
            context: "write",
            scopeId,
          });
        } else if (argument !== null) {
          walkNode(argument, scopeId, "expression");
        }
        return;
      }
      case "MemberExpression": {
        const objectNode = jsKid(node, "object");
        if (objectNode !== null) walkNode(objectNode, scopeId, "expression");
        const property = jsKid(node, "property");
        const computed = node.fields["computed"] === true;
        if (property !== null && computed) walkNode(property, scopeId, "expression");
        return;
      }
      case "Property": {
        const key = jsKid(node, "key");
        const shorthand = node.fields["shorthand"] === true;
        const computed = node.fields["computed"] === true;
        if (key !== null && (computed || shorthand)) walkNode(key, scopeId, "expression");
        const value = jsKid(node, "value");
        if (value !== null && !shorthand) walkNode(value, scopeId, "expression");
        return;
      }
      case "LabeledStatement":
      case "BreakStatement":
      case "ContinueStatement": {
        const label = jsKid(node, "label");
        if (label !== null && node.kind === "LabeledStatement") {
          const body = jsKid(node, "body");
          if (body !== null) walkNode(body, scopeId, "statement");
        }
        return;
      }
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        walkFunction(node, scopeId);
        return;
      }
      case "TSInterfaceDeclaration": {
        const name = identifierName(jsKid(node, "id"));
        if (name !== null) {
          declare(scopeId, {
            name,
            kind: "type",
            span: node.span,
            type: null,
            mutability: "readonly",
            namespace: "type",
            imported: false,
            importSpecifier: null,
            importedName: null,
            flags: {},
          });
        }
        return;
      }
      case "TSTypeAliasDeclaration": {
        const name = identifierName(jsKid(node, "id"));
        if (name !== null) {
          declare(scopeId, {
            name,
            kind: "type",
            span: node.span,
            type: mapTsType(jsKid(node, "typeAnnotation")),
            mutability: "readonly",
            namespace: "type",
            imported: false,
            importSpecifier: null,
            importedName: null,
            flags: {},
          });
        }
        return;
      }
      case "TSEnumDeclaration": {
        const name = identifierName(jsKid(node, "id"));
        if (name !== null) {
          declare(scopeId, {
            name,
            kind: "enum",
            span: node.span,
            type: null,
            mutability: "readonly",
            namespace: "both",
            imported: false,
            importSpecifier: null,
            importedName: null,
            flags: { isConst: node.fields["const"] === true },
          });
        }
        return;
      }
      case "TSModuleDeclaration": {
        const name =
          identifierName(jsKid(node, "id")) ??
          (jsScalar(jsKid(node, "id") ?? node, "value") as string | null);
        if (name !== null) {
          declare(scopeId, {
            name,
            kind: "namespace",
            span: node.span,
            type: null,
            mutability: "readonly",
            namespace: "both",
            imported: false,
            importSpecifier: null,
            importedName: null,
            flags: {},
          });
        }
        return;
      }
      default: {
        for (const value of Object.values(node.fields) as AstValue[]) {
          const values = Array.isArray(value) ? value : [value];
          for (const item of values) {
            if (isRecord(item)) walkNode(item, scopeId, "expression");
          }
        }
      }
    }
  }

  function tsAnnotationOf(declarator: AstNode): AstNode | null {
    const id = jsKid(declarator, "id");
    return id === null ? null : jsKid(id, "typeAnnotation");
  }

  walkNode(parseResult.ast, rootScopeId, "statement");

  // ---- materialize -------------------------------------------------------------------

  const symbols = new Map<string, SymbolEntry>();
  const symbolsByScopeName = new Map<string, string>();
  for (const [key, draft] of declarations) {
    const [scopeId, name] = key.split("\u0000");
    const id = `${scopeId}#${name}`;
    symbols.set(id, {
      id,
      name: name!,
      kind: draft.kind,
      scopeId: scopeId!,
      declarationSpan: draft.span,
      references: [],
      type: draft.type,
      mutability: draft.mutability,
      exported: false,
      imported: draft.imported,
      importSpecifier: draft.importSpecifier,
      importedName: draft.importedName,
      namespace: draft.namespace,
      languageFlags: draft.flags,
    });
    symbolsByScopeName.set(key, id);
  }

  function resolveJsReference(pending: PendingReference): string | null {
    let current: string | null = pending.scopeId;
    while (current !== null) {
      const hit = symbolsByScopeName.get(`${current}\u0000${pending.name}`);
      if (hit !== undefined) return hit;
      current = scopes.get(current)?.parent ?? null;
    }
    return null;
  }

  const unresolvedReferences: Array<{
    name: string;
    reference: { span: NonNullable<AstNode["span"]>; context: ReferenceContext; scopeId: string };
  }> = [];
  for (const pending of references) {
    const symbolId = resolveJsReference(pending);
    if (symbolId !== null) {
      (symbols.get(symbolId)?.references as SymbolReference[]).push({
        span: pending.span,
        context: pending.context,
        scopeId: pending.scopeId,
      });
    } else {
      unresolvedReferences.push({ name: pending.name, reference: pending });
    }
  }

  for (const symbol of symbols.values()) {
    (scopes.get(symbol.scopeId)?.symbolIds as string[]).push(symbol.id);
  }

  // Export marking from the parser's module map.
  const moduleInfo = parseResult.module;
  if (moduleInfo !== null) {
    for (const entry of moduleInfo.exports) {
      if (entry.localName === null) continue;
      const id = symbolsByScopeName.get(`${rootScopeId}\u0000${entry.localName}`);
      if (id !== undefined) {
        const symbol = symbols.get(id)!;
        symbols.set(id, { ...symbol, exported: true });
      }
    }
  }

  const scopeNodes: Record<string, import("./semantic.js").ScopeNode> = {};
  for (const scope of scopes.values()) {
    scopeNodes[scope.id] = {
      id: scope.id,
      kind: scope.kind,
      name: scope.name,
      language: "javascript",
      span: scope.span,
      parent: scope.parent,
      children: scope.children,
      symbolIds: scope.symbolIds,
      notes: [],
    };
  }
  // TypeScript sources keep the JS model; language recorded from the parse result.
  if (parseResult.language === "typescript") {
    for (const scope of Object.values(scopeNodes)) {
      scopeNodes[scope.id] = { ...scope, language: "typescript" };
    }
  }

  return {
    language: parseResult.language,
    filename: parseResult.filename,
    scopes: scopeNodes,
    symbols: Object.fromEntries(symbols),
    rootScopeId,
    diagnostics,
    unresolvedReferences,
  };
}
