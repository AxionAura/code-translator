// Parser-level module information extracted from the NORMALIZED JS/TS AST. Walking our
// own AstNode envelope (rather than consuming oxc's module map directly) keeps oxc and
// Babel on one code path and keeps oxc-specific structures out of the contract; the
// oxc module map is cross-checked in tests. Dynamic imports are recorded when the
// specifier is a static string literal.
import type {
  AstNode,
  AstValue,
  ModuleExport,
  ModuleImport,
  ModuleInfo,
  SourceSpan,
} from "@ctrans/core";

function childrenAt(node: AstNode, name: string): AstNode[] {
  const value = node.fields[name];
  return Array.isArray(value) ? (value as AstNode[]) : [];
}

function childAt(node: AstNode, name: string): AstNode | null {
  const value = node.fields[name];
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("kind" in value)) {
    return null;
  }
  return value as AstNode;
}

function scalarAt(node: AstNode, name: string): string | null {
  const value = node.fields[name];
  return typeof value === "string" ? value : null;
}

function identifierName(node: AstNode | null): string | null {
  if (node === null) return null;
  if (node.kind === "Identifier") return scalarAt(node, "name");
  if (node.kind === "Literal") return scalarAt(node, "value");
  return null;
}

// Names declared by an export declaration's inner statement (export const x, export
// function f, ...). Complex binding patterns yield null and are still recorded.
function declaredNames(declaration: AstNode | null): Array<string | null> {
  if (declaration === null) return [null];
  switch (declaration.kind) {
    case "VariableDeclaration": {
      const declarators = childrenAt(declaration, "declarations");
      return declarators.map((declarator) => identifierName(childAt(declarator, "id")));
    }
    case "FunctionDeclaration":
    case "ClassDeclaration":
    case "TSInterfaceDeclaration":
    case "TSTypeAliasDeclaration":
    case "TSEnumDeclaration":
    case "TSModuleDeclaration":
      return [identifierName(childAt(declaration, "id"))];
    default:
      return [null];
  }
}

export function extractModuleInfo(root: AstNode): ModuleInfo {
  const imports: ModuleImport[] = [];
  const exports: ModuleExport[] = [];
  const dynamicImports: SourceSpan[] = [];

  const stack: AstNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    switch (node.kind) {
      case "ImportDeclaration": {
        const moduleSpecifier = scalarAt(childAt(node, "source") ?? node, "value") ?? "";
        const specifiers = childrenAt(node, "specifiers");
        if (specifiers.length === 0) {
          imports.push({
            kind: "side-effect",
            moduleSpecifier,
            importedName: null,
            localName: null,
            span: node.span,
          });
        } else {
          for (const specifier of specifiers) {
            imports.push(importFromSpecifier(moduleSpecifier, specifier));
          }
        }
        break;
      }
      case "ExportNamedDeclaration": {
        const source = childAt(node, "source");
        const moduleSpecifier = source === null ? null : scalarAt(source, "value");
        const specifiers = childrenAt(node, "specifiers");
        if (specifiers.length > 0) {
          for (const specifier of specifiers) {
            const exported = childAt(specifier, "exported");
            // oxc parses `export * as ns from "..."` as ExportAllDeclaration with an
            // exported name; Babel shapes it as ExportNamedDeclaration with an
            // ExportNamespaceSpecifier. Both mean the same thing.
            const kind = specifier.kind === "ExportNamespaceSpecifier" ? "star-as" : "named";
            exports.push({
              kind,
              exportedName: identifierName(exported),
              localName: kind === "named" ? identifierName(childAt(specifier, "local")) : null,
              moduleSpecifier,
              // star-as re-exports use the full declaration span on both parsers
              // (oxc's ExportAllDeclaration and Babel's wrapping declaration agree).
              span: kind === "star-as" ? node.span : (specifier.span ?? node.span),
            });
          }
        } else {
          const declaration = childAt(node, "declaration");
          for (const localName of declaredNames(declaration)) {
            exports.push({
              kind: "named",
              exportedName: localName,
              localName,
              moduleSpecifier: null,
              span: node.span,
            });
          }
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        const declaration = childAt(node, "declaration");
        const localName = declaration === null ? null : (identifierName(declaration) ?? null);
        exports.push({
          kind: "default",
          exportedName: "default",
          localName,
          moduleSpecifier: null,
          span: node.span,
        });
        break;
      }
      case "ExportAllDeclaration": {
        const exported = childAt(node, "exported");
        const source = childAt(node, "source");
        exports.push({
          kind: exported === null ? "star" : "star-as",
          exportedName: identifierName(exported),
          localName: null,
          moduleSpecifier: source === null ? null : scalarAt(source, "value"),
          span: node.span,
        });
        break;
      }
      case "ImportExpression": {
        const source = childAt(node, "source");
        const specifier = source === null ? null : scalarAt(source, "value");
        if (specifier !== null && node.span !== null) {
          dynamicImports.push(node.span);
        }
        break;
      }
      case "CallExpression": {
        // Babel shapes dynamic imports as CallExpression with an Import callee.
        const callee = childAt(node, "callee");
        if (callee !== null && callee.kind === "Import") {
          const args = childrenAt(node, "arguments");
          const specifier = args[0] === undefined ? null : scalarAt(args[0], "value");
          if (specifier !== null && node.span !== null) {
            dynamicImports.push(node.span);
          }
        }
        break;
      }
      default:
        break;
    }
    // Push children reversed so the LIFO stack visits statements in source order.
    for (const child of allChildren(node).reverse()) stack.push(child);
  }

  return {
    hasModuleSyntax: imports.length > 0 || exports.length > 0,
    imports,
    exports,
    dynamicImports,
  };
}

function importFromSpecifier(moduleSpecifier: string, specifier: AstNode): ModuleImport {
  switch (specifier.kind) {
    case "ImportSpecifier": {
      const imported = childAt(specifier, "imported");
      return {
        kind: "named",
        moduleSpecifier,
        importedName: importedImportedName(imported),
        localName: identifierName(childAt(specifier, "local")),
        span: specifier.span,
      };
    }
    case "ImportDefaultSpecifier":
      return {
        kind: "default",
        moduleSpecifier,
        importedName: null,
        localName: identifierName(childAt(specifier, "local")),
        span: specifier.span,
      };
    case "ImportNamespaceSpecifier":
      return {
        kind: "namespace",
        moduleSpecifier,
        importedName: null,
        localName: identifierName(childAt(specifier, "local")),
        span: specifier.span,
      };
    default:
      // Unknown specifier shapes stay visible with null names rather than vanishing.
      return {
        kind: "named",
        moduleSpecifier,
        importedName: null,
        localName: null,
        span: specifier.span,
      };
  }
}

// `import { "str" as y }`: the imported name can be a string literal.
function importedImportedName(imported: AstNode | null): string | null {
  if (imported === null) return null;
  return scalarAt(imported, "name") ?? scalarAt(imported, "value");
}

function allChildren(node: AstNode): AstNode[] {
  const result: AstNode[] = [];
  for (const value of Object.values(node.fields) as AstValue[]) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item === "object" && item !== null && "kind" in item) {
        result.push(item as AstNode);
      }
    }
  }
  return result;
}
