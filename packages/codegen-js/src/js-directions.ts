// Shared JS/TS statement/expression printer for the reverse directions (M7 WS C/D):
// TS→JS erases type-only syntax (deterministic — the erasure is what Node's strip
// mode does, attributed per construct); JS→TS prints the same runtime code with
// honest type annotations (unknown where inference has no evidence; runtime-neutral
// `as` assertions where strict TS rejects operators on unknowns — assertions are
// erased at runtime, so behavior is provably preserved).
//
// The input is the normalized ESTree envelope from @ctrans/parser-js (generic
// kinds/fields). Unsupported RUNTIME constructs (enums, namespaces, decorators,
// parameter properties, legacy decorators) are never dropped: marker + ledger
// `unsupported`, matching the M4/M6 convention.
import {
  CTransError,
  NO_REGISTRY,
  type AnalyzedUnit,
  type LedgerEscalation,
  type EmittedFile,
  type LedgerEntry,
  type ModuleGraphModel,
  type RegistryLookup,
  type UnitEmission,
  type UnitTranslationContext,
  type UnitTranslator,
} from "@ctrans/core";
import { format } from "prettier";

import { relativeImportSpecifier } from "./translator.js";

type TypeText = "number" | "string" | "boolean" | "unknown";

// Ambient globals with known TS shapes — the honest-type rules never cast or
// assert on them (the oracle resolves their members).
const KNOWN_GLOBALS = new Set([
  "String",
  "Math",
  "Promise",
  "RegExp",
  "Object",
  "JSON",
  "Array",
  "Number",
  "Boolean",
  "Date",
  "Error",
  "console",
  "parseInt",
  "parseFloat",
  "isNaN",
  "Symbol",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "BigInt",
  "globalThis",
]);

abstract class JsPrinterBase {
  protected readonly lines: string[] = [];
  protected indent = 0;
  readonly ledger: LedgerEntry[] = [];
  protected ordinal = 0;
  // Per-scope inferred binding types (JS→TS annotation evidence; TS→JS ignores it).
  protected readonly scopes: Map<string, TypeText>[] = [new Map()];
  // Which unit-local names are classes (JS→TS: `new X()` fields, instanceof…).
  protected readonly classNames = new Set<string>();

  // Explicit fields (not parameter properties): the unbuilt CLI runs sources
  // through Node strip-only mode, which rejects transform-only syntax.
  protected readonly unit: AnalyzedUnit;
  protected readonly graph: ModuleGraphModel;
  protected readonly registry: RegistryLookup;

  constructor(unit: AnalyzedUnit, graph: ModuleGraphModel, registry: RegistryLookup) {
    this.unit = unit;
    this.graph = graph;
    this.registry = registry;
  }

  protected record(entry: {
    span: AnalyzedUnit["parseResult"]["ast"]["span"];
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
        span === null || span === undefined
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

  protected unsupported(node: JsNode, what: string, reason: string): string {
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
    return `/* ctrans: unsupported ${what}: ${reason} */`;
  }

  protected deterministic(
    node: JsNode,
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

  // Base hook: whether this expression's static type is unknown (drives
  // runtime-neutral assertion insertion in the JS→TS printer only).
  protected isUntypedValue(_node: JsNode): boolean {
    return false;
  }

  protected erase(node: JsNode, what: string): void {
    this.record({
      span: node.span,
      sourceKind: `js.${node.kind}`,
      rule: `js.${node.kind}→erased`,
      decision: "deterministic",
      rationale: `type-only ${what} is erased (no runtime effect)`,
      adaptation: "erased",
      targetSummary: null,
    });
  }

  // ---- scope helpers -------------------------------------------------------------
  protected pushScope(): void {
    this.scopes.push(new Map());
  }

  protected popScope(): void {
    this.scopes.pop();
  }

  protected declareType(name: string, type: TypeText): void {
    if (name !== "") this.scopes[this.scopes.length - 1]!.set(name, type);
  }

  protected lookupType(name: string): TypeText {
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      const hit = this.scopes[i]!.get(name);
      if (hit !== undefined) return hit;
    }
    return "unknown";
  }

  // ---- program -------------------------------------------------------------------
  printProgram(program: JsNode): string {
    for (const statement of kids(program, "body")) this.printStatement(statement);
    return this.lines.join("\n");
  }

  // ---- statements ----------------------------------------------------------------
  protected printStatement(node: JsNode): void {
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
        this.printVariableDeclaration(node, true);
        return;
      case "FunctionDeclaration":
        this.printFunction(node, "function");
        return;
      case "ClassDeclaration":
        this.printClass(node, true);
        return;
      case "ExpressionStatement":
        this.line(`${this.printExpression(kid(node, "expression")!)};`);
        return;
      case "BlockStatement":
        this.printBlock(node);
        return;
      case "IfStatement":
        this.printIf(node);
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
      case "WhileStatement":
        this.printWhile(node);
        return;
      case "DoWhileStatement":
        this.printDoWhile(node);
        return;
      case "SwitchStatement":
        this.printSwitch(node);
        return;
      case "ReturnStatement": {
        const argument = kid(node, "argument");
        this.line(argument === null ? "return;" : `return ${this.printExpression(argument)};`);
        return;
      }
      case "BreakStatement":
      case "ContinueStatement": {
        const label = kid(node, "label");
        const keyword = node.kind === "BreakStatement" ? "break" : "continue";
        this.line(label === null ? `${keyword};` : `${keyword} ${this.printExpression(label)};`);
        return;
      }
      case "LabeledStatement":
        this.printLabeled(node);
        return;
      case "ThrowStatement":
        this.line(`throw ${this.printExpression(kid(node, "argument")!)};`);
        return;
      case "TryStatement":
        this.printTry(node);
        return;
      case "EmptyStatement":
        this.line(";");
        return;
      case "TSExportAssignment":
      case "TSImportEqualsDeclaration":
        this.unsupported(node, node.kind, "TypeScript module-system construct with no JS erasure");
        return;
      case "TSTypeAliasDeclaration":
        this.erase(node, "type alias");
        return;
      case "TSInterfaceDeclaration":
        this.erase(node, "interface declaration");
        return;
      case "TSEnumDeclaration":
        this.line(
          this.unsupported(
            node,
            "enum",
            "enums are runtime constructs; stripping would change behavior",
          ),
        );
        return;
      case "TSModuleDeclaration":
        // `declare module "x" {}` / ambient namespaces erase; value-bearing
        // namespaces are runtime constructs.
        if (node.fields["declare"] === true) {
          this.erase(node, "ambient module declaration");
        } else {
          this.line(
            this.unsupported(
              node,
              "namespace",
              "namespaces are runtime constructs (IIFE emission is outside the M7 subset)",
            ),
          );
        }
        return;
      case "TSDeclareFunction":
        this.erase(node, "ambient function declaration");
        return;
      default:
        this.line(
          this.unsupported(node, node.kind, "statement form outside the M7 reverse subset"),
        );
    }
  }

  protected printImport(node: JsNode): void {
    if (node.fields["importKind"] === "type") {
      this.erase(node, "type-only import");
      return;
    }
    const moduleSource = String(scalar(kid(node, "source"), "value") ?? "");
    const specifiers: string[] = [];
    const defaults: string[] = [];
    let namespace: string | null = null;
    for (const specifier of kids(node, "specifiers")) {
      if (specifier.kind === "ImportSpecifier") {
        if (specifier.fields["importKind"] === "type") continue; // erased
        const imported = this.importedBindingName(kid(specifier, "imported"));
        const local = String(scalar(kid(specifier, "local"), "name") ?? "");
        specifiers.push(imported === local ? local : `${imported} as ${local}`);
      } else if (specifier.kind === "ImportDefaultSpecifier") {
        defaults.push(String(scalar(kid(specifier, "local"), "name") ?? ""));
      } else if (specifier.kind === "ImportNamespaceSpecifier") {
        namespace = String(scalar(kid(specifier, "local"), "name") ?? "");
      } else {
        this.unsupported(specifier, specifier.kind, "import form outside the M7 reverse subset");
      }
    }
    const parts: string[] = [];
    if (defaults.length > 0) parts.push(defaults.join(", "));
    if (namespace !== null) parts.push(`* as ${namespace}`);
    if (specifiers.length > 0) parts.push(`{ ${specifiers.sort().join(", ")} }`);
    const resolved = this.importSpecifierFor(moduleSource);
    this.line(
      parts.length > 0 ? `import ${parts.join(", ")} from "${resolved}";` : `import "${resolved}";`,
    );
    this.record({
      span: node.span,
      sourceKind: "js.ImportDeclaration",
      rule: "js.import→js.import",
      decision: "deterministic",
      rationale: "import statement correspondence with module-path rewriting from the ModuleGraph",
      targetSummary: `import from "${resolved}"`,
    });
  }

  private importedBindingName(node: JsNode | null): string {
    if (node === null) return "";
    if (node.kind === "Identifier") return String(scalar(node, "name") ?? "");
    if (node.kind === "Literal") return String(scalar(node, "value") ?? "");
    return "";
  }

  // Module specifier rewriting: the graph resolved the import; the emitted
  // specifier points at the TARGET module path (helper.ts → helper.js).
  protected importSpecifierFor(moduleSource: string): string {
    const node = this.graph.modules[this.unit.filename];
    const imports = node?.imports ?? [];
    const hit = imports.find((candidate) => candidate.specifier === moduleSource);
    if (hit !== undefined && hit.status === "resolved" && hit.resolvedModuleId !== null) {
      const targetPath = targetPathFor(hit.resolvedModuleId, this.targetExtension());
      const myDir = dirname(this.unit.filename.replace(/\.(ts|js|tsx|jsx)$/, ""));
      return relativeImportSpecifier(myDir, targetPath);
    }
    return moduleSource;
  }

  protected abstract targetExtension(): ".js" | ".ts";

  protected printExportNamed(node: JsNode): void {
    if (node.fields["exportKind"] === "type") {
      this.erase(node, "type-only export");
      return;
    }
    const declaration = kid(node, "declaration");
    const before = this.lines.length;
    if (declaration !== null) {
      this.printStatement(declaration);
      const exported = this.lines.slice(before);
      this.lines.length = before;
      if (exported.length > 0) {
        const isCommentOnly = exported.every((line) => line.trimStart().startsWith("/*"));
        if (isCommentOnly) {
          for (const line of exported) this.lines.push(line);
        } else {
          this.lines.push(exportLine(exported[0]!, declaration));
          for (const line of exported.slice(1)) this.lines.push(line);
        }
      }
      this.record({
        span: node.span,
        sourceKind: "js.ExportNamedDeclaration",
        rule: "js.export→js.export",
        decision: "deterministic",
        rationale: "export keyword preserved on the declaration",
        targetSummary: "export declaration",
      });
      return;
    }
    const specifiers: string[] = [];
    for (const specifier of kids(node, "specifiers")) {
      if (specifier.fields["exportKind"] === "type") continue;
      const local = this.importedBindingName(kid(specifier, "local"));
      const exported = this.importedBindingName(kid(specifier, "exported"));
      specifiers.push(local === exported ? local : `${local} as ${exported}`);
    }
    const sourceNode = kid(node, "source");
    if (sourceNode !== null) {
      const resolved = this.importSpecifierFor(String(scalar(sourceNode, "value") ?? ""));
      this.line(`export { ${specifiers.join(", ")} } from "${resolved}";`);
    } else {
      this.line(`export { ${specifiers.join(", ")} };`);
    }
    this.record({
      span: node.span,
      sourceKind: "js.ExportNamedDeclaration",
      rule: "js.export→js.export",
      decision: "deterministic",
      rationale: "export specifier list correspondence",
      targetSummary: `export { ${specifiers.join(", ")} }`,
    });
  }

  protected printExportDefault(node: JsNode): void {
    const declaration = kid(node, "declaration");
    const before = this.lines.length;
    if (declaration !== null) this.printStatement(declaration);
    const exported = this.lines.slice(before);
    this.lines.length = before;
    if (
      exported.length > 0 &&
      exported[0]!.startsWith("function ") &&
      declaration!.kind === "FunctionDeclaration"
    ) {
      // `export default function f() {}` → the declaration stays named.
      for (const line of exported) this.lines.push(line);
      this.line(`export default ${String(scalar(kid(declaration!, "id"), "name") ?? "")};`);
    } else if (exported.length > 0 && exported[0]!.startsWith("class ")) {
      for (const line of exported) this.lines.push(line);
      this.line(`export default ${String(scalar(kid(declaration!, "id"), "name") ?? "")};`);
    } else {
      for (const line of exported) this.lines.push(line);
      this.lines[this.lines.length - 1] =
        `export default ${stripSemicolon(this.lines[this.lines.length - 1]!)};`;
    }
    this.record({
      span: node.span,
      sourceKind: "js.ExportDefaultDeclaration",
      rule: "js.export-default→js.export-default",
      decision: "deterministic",
      rationale: "default export correspondence",
      targetSummary: "export default",
    });
  }

  protected printExportAll(node: JsNode): void {
    const resolved = this.importSpecifierFor(String(scalar(kid(node, "source"), "value") ?? ""));
    this.line(`export * from "${resolved}";`);
    this.record({
      span: node.span,
      sourceKind: "js.ExportAllDeclaration",
      rule: "js.export-star→js.export-star",
      decision: "deterministic",
      rationale: "star re-export correspondence",
      targetSummary: `export * from "${resolved}"`,
    });
  }

  protected printVariableDeclaration(node: JsNode, topLevelStatement: boolean): void {
    const keyword = String(node.fields["kind"] ?? "let");
    const parts: string[] = [];
    for (const declarator of kids(node, "declarations")) {
      parts.push(this.printDeclarator(declarator, keyword));
    }
    const text = `${keyword} ${parts.join(", ")}`;
    if (topLevelStatement) this.line(`${text};`);
    else this.emitRaw(text);
  }

  protected printDeclarator(node: JsNode, keyword: string): string {
    const id = kid(node, "id")!;
    const init = kid(node, "init");
    const pattern = this.printBindingPattern(id, keyword, init);
    const annotation = this.declaratorAnnotation(id, init, keyword);
    if (init === null) return `${pattern}${annotation}`;
    return `${pattern}${annotation} = ${this.printExpression(init)}`;
  }

  protected printBindingPattern(node: JsNode, keyword: string, _init: JsNode | null): string {
    void keyword;
    switch (node.kind) {
      case "Identifier": {
        const annotation = kid(node, "typeAnnotation");
        if (annotation !== null) this.erase(annotation, "type annotation");
        return String(scalar(node, "name") ?? "");
      }
      case "ArrayPattern": {
        const elements = kids(node, "elements").map((element) =>
          element === null
            ? ""
            : element.kind === "RestElement"
              ? `...${this.printBindingPattern(kid(element, "argument")!, "let", null)}`
              : this.printBindingPattern(element, "let", null),
        );
        return `[${elements.join(", ")}]`;
      }
      case "ObjectPattern": {
        const properties = kids(node, "properties").map((property) => {
          if (property.kind === "RestElement") {
            return `...${this.printBindingPattern(kid(property, "argument")!, "let", null)}`;
          }
          const key = this.propertyKey(kid(property, "key")!, property.fields["computed"] === true);
          const value = kid(property, "value")!;
          const shorthand =
            property.fields["shorthand"] === true &&
            value.kind === "Identifier" &&
            key === String(scalar(value, "name") ?? "");
          return shorthand ? key : `${key}: ${this.printBindingPattern(value, "let", null)}`;
        });
        return `{ ${properties.join(", ")} }`;
      }
      case "AssignmentPattern":
        return `${this.printBindingPattern(kid(node, "left")!, "let", null)} = ${this.printExpression(kid(node, "right")!)}`;
      default:
        return this.unsupported(node, node.kind, "binding pattern outside the M7 reverse subset");
    }
  }

  // JS→TS hook: type annotation text for a declarator ("" for none).
  protected declaratorAnnotation(_id: JsNode, _init: JsNode | null, _keyword: string): string {
    return "";
  }

  protected printFunction(node: JsNode, keyword: "function" | ""): void {
    const nameNode = kid(node, "id");
    const name = nameNode === null ? "" : String(scalar(nameNode, "name") ?? "");
    const isAsync = node.fields["async"] === true;
    const isGenerator = node.fields["generator"] === true;
    if (node.fields["declare"] === true) {
      this.erase(node, "ambient function");
      return;
    }
    const params = this.printFunctionParams(node, name);
    const returnType = this.functionReturnType(node, name);
    const header = `${isAsync ? "async " : ""}${keyword}${keyword === "" ? "" : " "}${isGenerator ? "*" : ""}${name}(${params})${returnType} {`;
    this.line(header);
    this.pushScope();
    this.declareParams(node, name);
    this.indent += 1;
    this.printBodyStatements(kid(node, "body")!);
    this.indent -= 1;
    this.popScope();
    this.line("}");
    this.record({
      span: node.span,
      sourceKind: "js.FunctionDeclaration",
      rule: "js.function→js.function",
      decision: "deterministic",
      rationale: "function declaration correspondence",
      targetSummary: `function ${name}(${params})`,
    });
  }

  protected printFunctionParams(node: JsNode, _functionName: string): string {
    const parts: string[] = [];
    for (const param of kids(node, "params")) {
      if (param.kind === "TSParameterProperty") {
        this.unsupported(
          param,
          "parameter property",
          "parameter properties assign fields (runtime-relevant); outside the M7 subset",
        );
        parts.push("/* ctrans: unsupported parameter property */ _ctrans_param");
        continue;
      }
      parts.push(this.printParam(param));
    }
    return parts.join(", ");
  }

  protected printParam(node: JsNode): string {
    if (node.kind === "AssignmentPattern") {
      // TS infers the parameter type from the default value — no annotation.
      return `${this.printBindingPattern(kid(node, "left")!, "let", null)}${this.paramAnnotation(node, false)} = ${this.printExpression(kid(node, "right")!)}`;
    }
    if (node.kind === "RestElement") {
      return `...${this.printBindingPattern(kid(node, "argument")!, "let", null)}${this.paramAnnotation(node, true)}`;
    }
    return `${this.printBindingPattern(node, "let", null)}${this.paramAnnotation(node, false)}`;
  }

  // JS→TS hook: honest annotation text for a parameter ("" = let TS infer).
  protected paramAnnotation(_node: JsNode, _isRest: boolean): string {
    return "";
  }

  protected declareParams(node: JsNode, _functionName: string): void {
    for (const param of kids(node, "params")) {
      const target =
        param.kind === "AssignmentPattern"
          ? kid(param, "left")
          : param.kind === "RestElement"
            ? kid(param, "argument")
            : param;
      if (target !== null && target.kind === "Identifier") {
        this.declareType(String(scalar(target, "name") ?? ""), "unknown");
      }
    }
  }

  protected functionReturnType(_node: JsNode, _functionName: string): string {
    return "";
  }

  protected printBodyStatements(body: JsNode): void {
    for (const statement of kids(body, "body")) this.printStatement(statement);
  }

  protected printBlock(node: JsNode): void {
    this.line("{");
    this.pushScope();
    this.indent += 1;
    for (const statement of kids(node, "body")) this.printStatement(statement);
    this.indent -= 1;
    this.popScope();
    this.line("}");
  }

  protected printIf(node: JsNode): void {
    const test = this.printExpression(kid(node, "test")!);
    const consequent = kid(node, "consequent")!;
    const alternate = kid(node, "alternate");
    this.line(`if (${test}) {`);
    this.pushScope();
    this.indent += 1;
    if (consequent.kind === "BlockStatement") {
      for (const statement of kids(consequent, "body")) this.printStatement(statement);
    } else {
      this.printStatement(consequent);
    }
    this.indent -= 1;
    this.popScope();
    if (alternate === null) {
      this.line("}");
    } else if (alternate.kind === "IfStatement") {
      // `} else` + the nested if-chain (which carries its own closing brace).
      this.line("} else");
      this.printStatement(alternate);
    } else {
      this.line("} else {");
      this.pushScope();
      this.indent += 1;
      if (alternate.kind === "BlockStatement") {
        for (const statement of kids(alternate, "body")) this.printStatement(statement);
      } else {
        this.printStatement(alternate);
      }
      this.indent -= 1;
      this.popScope();
      this.line("}");
    }
    this.record({
      span: node.span,
      sourceKind: "js.IfStatement",
      rule: "js.if→js.if",
      decision: "deterministic",
      rationale: "if/else correspondence",
      targetSummary: `if (${test})`,
    });
  }

  // for-in/for-of headers cannot carry type annotations in TS — print the bare
  // binding pattern (the key/value type is declared in the body if needed).
  protected printLoopBinding(declaration: JsNode): string {
    const parts: string[] = [];
    for (const declarator of kids(declaration, "declarations")) {
      parts.push(this.printBindingPattern(kid(declarator, "id")!, "let", null));
    }
    return `const ${parts.join(", ")}`;
  }

  protected printFor(node: JsNode): void {
    const init = kid(node, "init");
    const test = kid(node, "test");
    const update = kid(node, "update");
    const initText =
      init === null
        ? ""
        : init.kind === "VariableDeclaration"
          ? stripSemicolon(this.captureVariableDeclaration(init))
          : this.printExpression(init);
    const testText = test === null ? "" : this.printExpression(test);
    const updateText = update === null ? "" : this.printExpression(update);
    this.line(`for (${initText}; ${testText}; ${updateText}) {`);
    this.pushScope();
    if (init !== null && init.kind === "VariableDeclaration") this.declareForInit(init);
    this.indent += 1;
    for (const statement of kids(kid(node, "body")!, "body")) this.printStatement(statement);
    this.indent -= 1;
    this.popScope();
    this.line("}");
    this.record({
      span: node.span,
      sourceKind: "js.ForStatement",
      rule: "js.for→js.for",
      decision: "deterministic",
      rationale: "C-style for correspondence",
      targetSummary: `for (${initText}; ${testText}; ${updateText})`,
    });
  }

  private captureVariableDeclaration(node: JsNode): string {
    const before = this.lines.length;
    this.printVariableDeclaration(node, false);
    const captured = this.lines.slice(before).join(" ");
    this.lines.length = before;
    return captured;
  }

  protected declareForInit(node: JsNode): void {
    for (const declarator of kids(node, "declarations")) {
      const id = kid(declarator, "id");
      if (id !== null && id.kind === "Identifier") {
        const init = kid(declarator, "init");
        this.declareType(
          String(scalar(id, "name") ?? ""),
          init !== null ? inferTypeFromExpression(init, this) : "unknown",
        );
      }
    }
  }

  protected printForOf(node: JsNode): void {
    const left = kid(node, "left")!;
    const leftText =
      left.kind === "VariableDeclaration"
        ? this.printLoopBinding(left)
        : this.printExpression(left);
    const right = this.printExpression(kid(node, "right")!);
    const awaitPrefix = node.fields["await"] === true ? "await " : "";
    this.line(`for ${awaitPrefix}(${leftText} of ${right}) {`);
    this.pushScope();
    if (left.kind === "VariableDeclaration") {
      for (const declarator of kids(left, "declarations")) {
        const id = kid(declarator, "id");
        if (id !== null && id.kind === "Identifier") {
          this.declareType(String(scalar(id, "name") ?? ""), "unknown");
        }
      }
    }
    this.indent += 1;
    for (const statement of kids(kid(node, "body")!, "body")) this.printStatement(statement);
    this.indent -= 1;
    this.popScope();
    this.line("}");
    this.record({
      span: node.span,
      sourceKind: "js.ForOfStatement",
      rule: "js.for-of→js.for-of",
      decision: "deterministic",
      rationale: "for-of iteration correspondence",
      targetSummary: `for (${leftText} of ${right})`,
    });
  }

  protected printForIn(node: JsNode): void {
    const left = kid(node, "left")!;
    const leftText =
      left.kind === "VariableDeclaration"
        ? this.printLoopBinding(left)
        : this.printExpression(left);
    const right = this.printExpression(kid(node, "right")!);
    this.line(`for (${leftText} in ${right}) {`);
    this.pushScope();
    if (left.kind === "VariableDeclaration") {
      for (const declarator of kids(left, "declarations")) {
        const id = kid(declarator, "id");
        if (id !== null && id.kind === "Identifier") {
          this.declareType(String(scalar(id, "name") ?? ""), "string");
        }
      }
    }
    this.indent += 1;
    for (const statement of kids(kid(node, "body")!, "body")) this.printStatement(statement);
    this.indent -= 1;
    this.popScope();
    this.line("}");
    this.record({
      span: node.span,
      sourceKind: "js.ForInStatement",
      rule: "js.for-in→js.for-in",
      decision: "deterministic",
      rationale: "for-in key iteration correspondence",
      targetSummary: `for (${leftText} in ${right})`,
    });
  }

  protected printWhile(node: JsNode): void {
    this.line(`while (${this.printExpression(kid(node, "test")!)}) {`);
    this.indent += 1;
    for (const statement of kids(kid(node, "body")!, "body")) this.printStatement(statement);
    this.indent -= 1;
    this.line("}");
    this.record({
      span: node.span,
      sourceKind: "js.WhileStatement",
      rule: "js.while→js.while",
      decision: "deterministic",
      rationale: "while correspondence",
      targetSummary: "while",
    });
  }

  protected printDoWhile(node: JsNode): void {
    this.line("do {");
    this.indent += 1;
    for (const statement of kids(kid(node, "body")!, "body")) this.printStatement(statement);
    this.indent -= 1;
    this.line(`} while (${this.printExpression(kid(node, "test")!)});`);
    this.record({
      span: node.span,
      sourceKind: "js.DoWhileStatement",
      rule: "js.do-while→js.do-while",
      decision: "deterministic",
      rationale: "do-while correspondence",
      targetSummary: "do/while",
    });
  }

  protected printSwitch(node: JsNode): void {
    this.line(`switch (${this.printExpression(kid(node, "discriminant")!)}) {`);
    this.indent += 1;
    for (const caseNode of kids(node, "cases")) {
      const test = kid(caseNode, "test");
      const body = kids(caseNode, "consequent");
      if (test === null) {
        this.line("default:");
      } else {
        this.line(`case ${this.printExpression(test)}:`);
      }
      this.indent += 1;
      for (const statement of body) this.printStatement(statement);
      this.indent -= 1;
    }
    this.indent -= 1;
    this.line("}");
    this.record({
      span: node.span,
      sourceKind: "js.SwitchStatement",
      rule: "js.switch→js.switch",
      decision: "deterministic",
      rationale: "switch correspondence (fallthrough semantics preserved verbatim)",
      targetSummary: "switch",
    });
  }

  protected printLabeled(node: JsNode): void {
    const label = String(scalar(kid(node, "label"), "name") ?? "");
    const body = kid(node, "body")!;
    if (
      body.kind === "ForStatement" ||
      body.kind === "WhileStatement" ||
      body.kind === "ForOfStatement" ||
      body.kind === "ForInStatement" ||
      body.kind === "DoWhileStatement"
    ) {
      // Loop labels: re-print with the label prefix by emitting the loop into a
      // buffer and prefixing its first line.
      const before = this.lines.length;
      this.printStatement(body);
      const first = this.lines[before]!;
      this.lines[before] = `${label}: ${first}`;
      this.record({
        span: node.span,
        sourceKind: "js.LabeledStatement",
        rule: "js.label→js.label",
        decision: "deterministic",
        rationale: "labeled loop correspondence",
        targetSummary: `${label}:`,
      });
      return;
    }
    this.line(`${label}: {`);
    this.indent += 1;
    if (body.kind === "BlockStatement") {
      for (const statement of kids(body, "body")) this.printStatement(statement);
    } else {
      this.printStatement(body);
    }
    this.indent -= 1;
    this.line("}");
  }

  protected printTry(node: JsNode): void {
    this.line("try {");
    this.indent += 1;
    for (const statement of kids(kid(node, "block")!, "body")) this.printStatement(statement);
    this.indent -= 1;
    // The clause lines (`} catch {` / `} finally {`) carry the closing brace;
    // a bare `}` is only needed when neither clause follows.
    const handler = kid(node, "handler");
    const finalizer = kid(node, "finalizer");
    if (handler !== null) {
      const param = kid(handler, "param");
      const paramText = param === null ? "" : ` (${this.printBindingPattern(param, "let", null)})`;
      this.line(this.catchClause(paramText));
      this.pushScope();
      if (param !== null && param.kind === "Identifier") {
        this.declareType(String(scalar(param, "name") ?? ""), "unknown");
      }
      this.indent += 1;
      for (const statement of kids(kid(handler, "body")!, "body")) this.printStatement(statement);
      this.indent -= 1;
      this.popScope();
      if (finalizer === null) this.line("}");
    } else if (finalizer === null) {
      this.line("}");
    }
    if (finalizer !== null) {
      this.line("} finally {");
      this.indent += 1;
      for (const statement of kids(finalizer, "body")) this.printStatement(statement);
      this.indent -= 1;
      this.line("}");
    }
    this.record({
      span: node.span,
      sourceKind: "js.TryStatement",
      rule: "js.try→js.try",
      decision: "deterministic",
      rationale: "try/catch/finally correspondence",
      targetSummary: "try/catch",
    });
  }

  protected catchParamAnnotation(_param: JsNode | null): string {
    return "";
  }

  // The full catch-clause header (param + annotation placement differs per target).
  protected catchClause(paramText: string): string {
    return `} catch${paramText} {`;
  }

  // ---- classes -------------------------------------------------------------------
  protected printClass(node: JsNode, topLevelStatement: boolean): void {
    const name = String(scalar(kid(node, "id"), "name") ?? "");
    this.classNames.add(name);
    const classDecorators = kids(node, "decorators");
    if (classDecorators.length > 0) {
      this.line(
        this.unsupported(
          node,
          "class decorator",
          "TC39 decorator semantics differ from the legacy patterns; outside the M7 subset",
        ),
      );
      return;
    }
    if (node.fields["declare"] === true) {
      this.erase(node, "ambient class");
      return;
    }
    if (node.fields["abstract"] === true) {
      this.line(
        this.unsupported(
          node,
          "abstract class",
          "abstract classes are type-system constructs with runtime bodies; outside the M7 subset",
        ),
      );
      return;
    }
    const superNode = kid(node, "superClass");
    const superText = superNode === null ? "" : ` extends ${this.printExpression(superNode)}`;
    const header = `class ${name}${superText} {`;
    if (topLevelStatement) this.line(header);
    else this.emitRaw(header);
    this.pushScope();
    this.indent += 1;
    for (const member of kids(kid(node, "body")!, "body")) {
      this.printClassMember(member, name);
    }
    this.indent -= 1;
    this.popScope();
    if (topLevelStatement) this.line("}");
    else this.emitRaw("}");
    this.record({
      span: node.span,
      sourceKind: "js.ClassDeclaration",
      rule: "js.class→js.class",
      decision: "deterministic",
      rationale: "class correspondence (single inheritance; prototype model maps to class model)",
      targetSummary: `class ${name}`,
    });
  }

  protected printClassMember(node: JsNode, className: string): void {
    if (node.kind === "MethodDefinition") {
      this.printMethodDefinition(node, className);
      return;
    }
    if (node.kind === "PropertyDefinition") {
      this.printPropertyDefinition(node);
      return;
    }
    if (node.kind === "StaticBlock") {
      this.line("static {");
      this.indent += 1;
      for (const statement of kids(node, "body")) this.printStatement(statement);
      this.indent -= 1;
      this.line("}");
      return;
    }
    if (
      node.kind === "TSAbstractMethodDefinition" ||
      node.kind === "TSAbstractPropertyDefinition"
    ) {
      this.unsupported(
        node,
        "abstract member",
        "abstract members are type-system constructs; outside the M7 subset",
      );
      return;
    }
    this.line(this.unsupported(node, node.kind, "class member form outside the M7 reverse subset"));
  }

  protected printMethodDefinition(node: JsNode, _className: string): void {
    const isStatic = node.fields["static"] === true;
    const kind = String(node.fields["kind"] ?? "method");
    const key = this.propertyKey(kid(node, "key")!, node.fields["computed"] === true);
    const value = kid(node, "value")!;
    const isAsync = value.fields["async"] === true;
    const isGenerator = value.fields["generator"] === true;
    const prefix = `${isStatic ? "static " : ""}${isAsync ? "async " : ""}${isGenerator ? "*" : ""}`;
    const head =
      kind === "constructor"
        ? `${prefix}constructor`
        : kind === "get"
          ? `${prefix}get ${key}`
          : kind === "set"
            ? `${prefix}set ${key}`
            : `${prefix}${key}`;
    const params = this.printFunctionParams(value, key);
    // Constructors and set accessors cannot carry return annotations in TS.
    const returnType =
      kind === "constructor" || kind === "set" ? "" : this.functionReturnType(value, key);
    this.line(`${head}(${params})${returnType} {`);
    this.pushScope();
    if (kind !== "constructor") {
      this.declareType("this", "unknown");
    }
    this.declareParams(value, key);
    this.indent += 1;
    this.printBodyStatements(kid(value, "body")!);
    this.indent -= 1;
    this.popScope();
    this.line("}");
    this.record({
      span: node.span,
      sourceKind: "js.MethodDefinition",
      rule: "js.method→js.method",
      decision: "deterministic",
      rationale: "method correspondence (prototype method → class method)",
      targetSummary: `${head}(${params})`,
    });
  }

  protected printPropertyDefinition(node: JsNode): void {
    const isStatic = node.fields["static"] === true;
    const key = this.propertyKey(kid(node, "key")!, node.fields["computed"] === true);
    const value = kid(node, "value");
    const annotation = this.fieldAnnotation(key, value);
    if (value !== null) {
      this.line(
        `${isStatic ? "static " : ""}${key}${annotation} = ${this.printExpression(value)};`,
      );
    } else {
      this.line(`${isStatic ? "static " : ""}${key}${annotation};`);
    }
    this.record({
      span: node.span,
      sourceKind: "js.PropertyDefinition",
      rule: "js.field→js.field",
      decision: "deterministic",
      rationale: "class field correspondence",
      targetSummary: `${key}${annotation}`,
    });
  }

  protected fieldAnnotation(_key: string, _value: JsNode | null): string {
    return "";
  }

  protected propertyKey(node: JsNode, computed: boolean): string {
    if (computed) return `[${this.printExpression(node)}]`;
    if (node.kind === "Identifier") return String(scalar(node, "name") ?? "");
    if (node.kind === "PrivateIdentifier") return `#${String(scalar(node, "name") ?? "")}`;
    return this.printExpression(node);
  }

  // ---- expressions ---------------------------------------------------------------
  protected printExpression(node: JsNode): string {
    switch (node.kind) {
      case "Identifier": {
        const name = String(scalar(node, "name") ?? "");
        return this.identifierExpression(name, node);
      }
      case "ThisExpression":
        return "this";
      case "Super":
        return "super";
      case "Literal": {
        const raw = scalar(node, "raw");
        if (typeof raw === "string") return raw;
        const value = node.fields["value"];
        if (value === null) return "null";
        if (typeof value === "string") return JSON.stringify(value);
        if (typeof value === "number") return String(value);
        return String(value);
      }
      case "TemplateLiteral": {
        return this.printTemplateLiteral(node);
      }
      case "TaggedTemplateExpression": {
        // Plain JS construct — print tag + quasi (TS adds no runtime semantics).
        const tag = this.printExpression(kid(node, "tag")!);
        const quasi = kid(node, "quasi")!;
        this.deterministic(
          node,
          "js.TaggedTemplateExpression",
          "js.tagged-template→js.tagged-template",
          "tagged template correspondence (plain JS construct)",
          `${tag}…`,
        );
        return `${tag}${this.printTemplateLiteral(quasi)}`;
      }
      case "ArrayExpression": {
        const elements = kids(node, "elements").map((element) => {
          if (element === null) return "";
          if (element.kind === "SpreadElement") {
            const argument = kid(element, "argument")!;
            const text = this.printExpression(argument);
            if (!this.isUntypedValue(argument)) return `...${text}`;
            this.record({
              span: element.span,
              sourceKind: "js.SpreadElement",
              rule: "js.spread→ts.assert-array",
              decision: "deterministic",
              rationale:
                "runtime-neutral type assertion: strict TS requires an iterable; the assertion is erased at runtime",
              adaptation: "as unknown[]",
              targetSummary: `${text} as unknown[]`,
            });
            return `...(${text} as unknown[])`;
          }
          return this.printExpression(element);
        });
        return `[${elements.join(", ")}]`;
      }
      case "ObjectExpression": {
        const properties = kids(node, "properties").map((property) => {
          if (property.kind === "SpreadElement") {
            return `...${this.printExpression(kid(property, "argument")!)}`;
          }
          if (property.kind === "ObjectMethod" || property.kind === "ObjectAccessor") {
            this.unsupported(
              property,
              property.kind,
              "object methods outside the M7 reverse subset",
            );
            return "";
          }
          const computed = property.fields["computed"] === true;
          const key = this.propertyKey(kid(property, "key")!, computed);
          const value = this.printExpression(kid(property, "value")!);
          if (property.fields["shorthand"] === true) return key;
          return `${key}: ${value}`;
        });
        return `{ ${properties.filter((text) => text !== "").join(", ")} }`;
      }
      case "FunctionExpression": {
        const nameNode = kid(node, "id");
        const name = nameNode === null ? "" : String(scalar(nameNode, "name") ?? "");
        const params = this.printFunctionParams(node, name);
        const returnType = this.functionReturnType(node, name);
        const body = kid(node, "body")!;
        const isAsync = node.fields["async"] === true;
        const isGenerator = node.fields["generator"] === true;
        const inner = this.captureBlock(() => {
          this.line(
            `${isAsync ? "async " : ""}function${isGenerator ? "*" : ""}${name === "" ? "" : ` ${name}`}(${params})${returnType} {`,
          );
          this.pushScope();
          this.declareParams(node, name);
          this.indent += 1;
          this.printBodyStatements(body);
          this.indent -= 1;
          this.popScope();
          this.line("}");
        });
        return `(${trimTrailingSemicolon(inner)})`;
      }
      case "ArrowFunctionExpression": {
        const params = this.printFunctionParams(node, "");
        const returnType = this.functionReturnType(node, "");
        const body = kid(node, "body")!;
        const prefix = node.fields["async"] === true ? "async " : "";
        if (body.kind === "BlockStatement") {
          // Prettier normalizes layout, so the captured block's indentation is
          // irrelevant — only the token stream matters.
          const inner = this.captureBlock(() => {
            this.line(`${prefix}(${params})${returnType} => {`);
            this.pushScope();
            this.declareParams(node, "");
            this.indent += 1;
            this.printBodyStatements(body);
            this.indent -= 1;
            this.popScope();
            this.line("}");
          });
          return inner;
        }
        return `${prefix}(${params})${returnType} => ${this.printExpression(body)}`;
      }
      case "UnaryExpression": {
        const operator = String(node.fields["operator"] ?? "");
        const argumentText = this.operandExpression(
          kid(node, "argument")!,
          operator === "typeof" ? null : operator,
        );
        const space = operator.length > 1 ? " " : "";
        const prefix = node.fields["prefix"] === true;
        return prefix ? `${operator}${space}${argumentText}` : `${argumentText}${operator}`;
      }
      case "UpdateExpression": {
        const operator = String(node.fields["operator"] ?? "");
        const argumentText = this.operandExpression(kid(node, "argument")!, "+");
        return node.fields["prefix"] === true
          ? `${operator}${argumentText}`
          : `${argumentText}${operator}`;
      }
      case "BinaryExpression": {
        const operator = String(node.fields["operator"] ?? "");
        const leftNode = kid(node, "left")!;
        const rightNode = kid(node, "right")!;
        const left = this.operandExpression(leftNode, operator, {
          siblingIsString: operator === "+" && this.isStringLike(rightNode),
        });
        const right = this.operandExpression(rightNode, operator, {
          siblingIsString: operator === "+" && this.isStringLike(leftNode),
        });
        return `${left} ${operator} ${right}`;
      }
      case "LogicalExpression": {
        const operator = String(node.fields["operator"] ?? "");
        const leftNode = kid(node, "left")!;
        const rightNode = kid(node, "right")!;
        const left = this.operandExpression(leftNode, operator);
        const right = this.operandExpression(rightNode, operator);
        // Prettier/JS require explicit parens when ?? mixes with && / || —
        // parenthesize a child logical expression of a different kind.
        const needsParens = (child: import("@ctrans/core").AstNode): boolean => {
          if (child.kind !== "LogicalExpression") return false;
          return String(child.fields["operator"] ?? "") !== operator;
        };
        const leftText = needsParens(leftNode) ? `(${left})` : left;
        const rightText = needsParens(rightNode) ? `(${right})` : right;
        return `${leftText} ${operator} ${rightText}`;
      }
      case "AssignmentExpression": {
        const operator = String(node.fields["operator"] ?? "=");
        const left = this.assignmentTarget(kid(node, "left")!);
        const right = this.printExpression(kid(node, "right")!);
        return `${left} ${operator} ${right}`;
      }
      case "ConditionalExpression":
        return `${this.printExpression(kid(node, "test")!)} ? ${this.printExpression(kid(node, "consequent")!)} : ${this.printExpression(kid(node, "alternate")!)}`;
      case "CallExpression":
      case "NewExpression": {
        const keyword = node.kind === "NewExpression" ? "new " : "";
        const calleeNode0 = kid(node, "callee")!;
        // Optional-call (`a?.b()`) wraps the callee in ChainExpression — unwrap so
        // the member keeps its call-target context.
        const calleeNode =
          calleeNode0.kind === "ChainExpression" ? kid(calleeNode0, "expression")! : calleeNode0;
        const callee = this.calleeExpression(calleeNode);
        const args = kids(node, "arguments").map((argument) => {
          if (argument.kind !== "SpreadElement") return this.printExpression(argument);
          const argumentNode = kid(argument, "argument")!;
          const text = this.printExpression(argumentNode);
          if (!this.isUntypedValue(argumentNode)) return `...${text}`;
          this.record({
            span: argument.span,
            sourceKind: "js.SpreadElement",
            rule: "js.spread→ts.assert-array",
            decision: "deterministic",
            rationale:
              "runtime-neutral type assertion: strict TS requires an iterable; the assertion is erased at runtime",
            adaptation: "as unknown[]",
            targetSummary: `${text} as unknown[]`,
          });
          return `...(${text} as unknown[])`;
        });
        const typeArgs = this.typeArgumentsText(node);
        // Optional call (`f?.(...)`): a RUNTIME semantics marker — preserve it.
        const open = node.fields["optional"] === true ? "?.(" : "(";
        return `${keyword}${callee}${typeArgs}${open}${args.join(", ")})`;
      }
      case "MemberExpression": {
        const objectText = this.memberObjectExpression(kid(node, "object")!);
        const property = kid(node, "property")!;
        // Optional chaining (`a?.b`) is a RUNTIME semantics marker — dropping it
        // would change nullish handling. Preserve it exactly.
        const accessor = node.fields["optional"] === true ? "?." : ".";
        if (node.fields["computed"] === true) {
          return `${objectText}${node.fields["optional"] === true ? "?." : ""}[${this.printExpression(property)}]`;
        }
        const name = String(scalar(property, "name") ?? "");
        return `${objectText}${accessor}${name}`;
      }
      case "ChainExpression":
        return this.printExpression(kid(node, "expression")!);
      case "ParenthesizedExpression":
        // Pure grouping — print the inner expression (prettier re-groups).
        return `(${this.printExpression(kid(node, "expression")!)})`;
      case "SequenceExpression":
        return kids(node, "expressions")
          .map((expression) => this.printExpression(expression))
          .join(", ");
      case "AwaitExpression":
        return `await ${this.printExpression(kid(node, "argument")!)}`;
      case "YieldExpression": {
        const delegate = node.fields["delegate"] === true ? "*" : "";
        const argument = kid(node, "argument");
        return `yield${delegate}${argument === null ? "" : ` ${this.printExpression(argument)}`}`;
      }
      case "SpreadElement":
        return `...${this.printExpression(kid(node, "argument")!)}`;
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSTypeAssertion": {
        // Type assertions have no runtime effect — print the inner expression.
        const inner = kid(node, "expression") ?? kid(node, "operand");
        this.erase(
          node,
          node.kind === "TSTypeAssertion"
            ? "type assertion"
            : node.kind === "TSAsExpression"
              ? "as-assertion"
              : "satisfies assertion",
        );
        return inner === null ? "" : this.printExpression(inner);
      }
      case "TSNonNullExpression": {
        this.erase(node, "non-null assertion");
        return this.printExpression(kid(node, "expression")!);
      }
      case "ImportExpression":
        return `import(${this.printExpression(kid(node, "source")!)})`;
      default:
        return this.unsupported(node, node.kind, "expression form outside the M7 reverse subset");
    }
  }

  protected erasedTypeAnnotation(node: JsNode | null): string {
    if (node === null) return "";
    this.erase(node, "type annotation");
    return "";
  }

  protected identifierExpression(name: string, node: JsNode): string {
    void node;
    return name;
  }

  // JS→TS hook: runtime-neutral assertion wrapper for operands strict TS rejects
  // on unknowns. TS→JS prints operands verbatim. The hint carries sibling
  // string-ness for `+` (TS types string + T).
  protected operandExpression(
    node: JsNode,
    _operator: string | null,
    _hint?: { readonly siblingIsString: boolean },
  ): string {
    return this.printExpression(node);
  }

  // Base hook: whether this expression is statically string-like.
  protected isStringLike(_node: JsNode): boolean {
    return false;
  }

  protected memberObjectExpression(node: JsNode): string {
    return this.printExpression(node);
  }

  protected calleeExpression(node: JsNode): string {
    return this.printExpression(node);
  }

  protected assignmentTarget(node: JsNode): string {
    return this.printExpression(node);
  }

  protected typeArgumentsText(_node: JsNode): string {
    return "";
  }

  protected printTemplateLiteral(node: JsNode): string {
    const quasis = kids(node, "quasis");
    const expressions = kids(node, "expressions");
    let text = "`";
    for (let index = 0; index < quasis.length; index += 1) {
      // TemplateElement.value is a plain object — the normalizer expands it into
      // dotted sibling fields ("value.raw" / "value.cooked").
      text += String(quasis[index]!.fields["value.raw"] ?? "")
        .replaceAll("\\", "\\\\")
        .replaceAll("`", "\\`")
        .replaceAll("${", "\\${");
      if (index < expressions.length) {
        text += `\${${this.printExpression(expressions[index]!)}}`;
      }
    }
    return `${text}\``;
  }

  // ---- plumbing ------------------------------------------------------------------
  protected line(text: string): void {
    this.lines.push(`${"  ".repeat(this.indent)}${text}`);
  }

  protected emitRaw(text: string): void {
    this.lines.push(`${"  ".repeat(this.indent)}${text}`);
  }

  protected captureBlock(emit: () => void): string {
    const before = this.lines.length;
    emit();
    const captured = this.lines.slice(before);
    this.lines.length = before;
    return captured.join("\n");
  }
}

// ---- helpers ---------------------------------------------------------------------
export type JsNode = AnalyzedUnit["parseResult"]["ast"] & {
  kind: string;
  fields: Record<string, unknown>;
};

function kids(node: JsNode, name: string): readonly JsNode[] {
  const value = node.fields[name];
  return Array.isArray(value) ? (value as readonly JsNode[]) : [];
}

function kid(node: JsNode, name: string): JsNode | null {
  const value = node.fields[name];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsNode)
    : null;
}

function scalar(node: JsNode | null, name: string): string | number | boolean | null {
  if (node === null) return null;
  const value = node.fields[name];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

// Prefix only the declaration's FIRST line with `export` (multi-line declarations
// keep their bodies unprefixed). Non-exportable declaration forms pass through.
function exportLine(line: string, declaration: JsNode): string {
  if (
    declaration.kind === "FunctionDeclaration" ||
    declaration.kind === "ClassDeclaration" ||
    declaration.kind === "VariableDeclaration"
  ) {
    return `export ${line}`;
  }
  return line;
}

function stripSemicolon(text: string): string {
  return text.endsWith(";") ? text.slice(0, -1) : text;
}

function trimTrailingSemicolon(text: string): string {
  return stripSemicolon(text.trimEnd());
}

function inferTypeFromExpression(node: JsNode, printer: JsPrinterBase): TypeText {
  switch (node.kind) {
    case "Literal": {
      const value = node.fields["value"];
      if (typeof value === "number") return "number";
      if (typeof value === "string") return "string";
      if (typeof value === "boolean") return "boolean";
      return "unknown";
    }
    case "TemplateLiteral":
      return "string";
    case "ArrayExpression":
      return "unknown";
    default:
      void printer;
      return "unknown";
  }
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function targetPathFor(sourceModuleId: string, extension: ".js" | ".ts"): string {
  const withoutExt = sourceModuleId.replace(/\.(ts|tsx|js|jsx)$/, "");
  return `${withoutExt}${extension}`;
}

// ---- TS→JS (WS D) ------------------------------------------------------------------
export class TsToJsTranslator implements UnitTranslator {
  readonly target = "javascript" as const;
  private readonly pending: {
    targetPath: string;
    sourcePath: string;
    content: string;
    ledger: LedgerEntry[];
  }[] = [];

  private readonly registry: RegistryLookup;

  constructor(registry: RegistryLookup = NO_REGISTRY) {
    this.registry = registry;
  }

  async translateUnit(
    unit: AnalyzedUnit,
    graph: ModuleGraphModel,
    _context?: UnitTranslationContext,
  ): Promise<UnitEmission> {
    if (unit.parseResult.language !== "typescript" && unit.parseResult.language !== "javascript") {
      throw new CTransError(
        "CG-DIRECTION-MISMATCH",
        `ts-to-js translator received a ${unit.parseResult.language} input (${unit.filename})`,
      );
    }
    const printer = new TsToJsPrinter(unit, graph, this.registry);
    const raw = printer.printProgram(unit.parseResult.ast);
    const targetPath = targetPathFor(unit.filename, ".js");
    this.pending.push({
      targetPath,
      sourcePath: unit.filename,
      content: raw,
      ledger: printer.ledger,
    });
    return {
      targetExtension: ".js",
      pathFor: (sourceModuleId: string) => targetPathFor(sourceModuleId, ".js"),
      files: [],
      ledger: printer.ledger,
    };
  }

  async finalizeUnits(): Promise<UnitEmission> {
    const files: EmittedFile[] = [];
    const ledger: LedgerEntry[] = [];
    for (const module of this.pending) {
      files.push({
        targetPath: module.targetPath,
        sourcePath: module.sourcePath,
        content: await this.format(module.content, module.targetPath),
      });
      ledger.push(...module.ledger);
    }
    this.pending.length = 0;
    return { targetExtension: ".js", pathFor: (id) => targetPathFor(id, ".js"), files, ledger };
  }

  private async format(code: string, targetPath: string): Promise<string> {
    try {
      return await format(code, { parser: "babel", semi: true });
    } catch (error) {
      throw new CTransError(
        "CG-FORMAT-FAILED",
        `prettier could not format generated JS for ${targetPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }
}

class TsToJsPrinter extends JsPrinterBase {
  protected targetExtension(): ".js" | ".ts" {
    return ".js";
  }
}

// ---- JS→TS (WS C) ------------------------------------------------------------------
export class JsToTsTranslator implements UnitTranslator {
  readonly target = "typescript" as const;
  private readonly pending: {
    targetPath: string;
    sourcePath: string;
    content: string;
    ledger: LedgerEntry[];
  }[] = [];

  private readonly registry: RegistryLookup;

  constructor(registry: RegistryLookup = NO_REGISTRY) {
    this.registry = registry;
  }

  async translateUnit(
    unit: AnalyzedUnit,
    graph: ModuleGraphModel,
    _context?: UnitTranslationContext,
  ): Promise<UnitEmission> {
    if (unit.parseResult.language !== "javascript" && unit.parseResult.language !== "typescript") {
      throw new CTransError(
        "CG-DIRECTION-MISMATCH",
        `js-to-ts translator received a ${unit.parseResult.language} input (${unit.filename})`,
      );
    }
    const printer = new JsToTsPrinter(unit, graph, this.registry);
    const raw = printer.printProgram(unit.parseResult.ast);
    const targetPath = targetPathFor(unit.filename, ".ts");
    this.pending.push({
      targetPath,
      sourcePath: unit.filename,
      content: raw,
      ledger: printer.ledger,
    });
    return {
      targetExtension: ".ts",
      pathFor: (sourceModuleId: string) => targetPathFor(sourceModuleId, ".ts"),
      files: [],
      ledger: printer.ledger,
    };
  }

  async finalizeUnits(): Promise<UnitEmission> {
    const files: EmittedFile[] = [];
    const ledger: LedgerEntry[] = [];
    for (const module of this.pending) {
      files.push({
        targetPath: module.targetPath,
        sourcePath: module.sourcePath,
        content: await this.format(module.content, module.targetPath),
      });
      ledger.push(...module.ledger);
    }
    this.pending.length = 0;
    return { targetExtension: ".ts", pathFor: (id) => targetPathFor(id, ".ts"), files, ledger };
  }

  private async format(code: string, targetPath: string): Promise<string> {
    try {
      return await format(code, { parser: "typescript", semi: true });
    } catch (error) {
      throw new CTransError(
        "CG-FORMAT-FAILED",
        `prettier could not format generated TS for ${targetPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }
}

class JsToTsPrinter extends JsPrinterBase {
  // Inferred annotation text per binding (initializer evidence). Drives the
  // honest-type decisions: annotated bindings are never cast/asserted.
  private readonly annotations = new Map<string, string>();

  protected targetExtension(): ".js" | ".ts" {
    return ".ts";
  }

  // Honest annotations: inferred types where initializer evidence exists, `unknown`
  // otherwise (never implicit any, never blanket any).
  protected override declaratorAnnotation(
    id: JsNode,
    init: JsNode | null,
    _keyword: string,
  ): string {
    if (id.kind !== "Identifier") return "";
    const name = String(scalar(id, "name") ?? "");
    if (init === null) return ": unknown";
    const inferred = this.inferAnnotation(init);
    if (inferred !== null) {
      this.annotations.set(name, inferred);
      return `: ${inferred}`;
    }
    // Callable/value bindings with inferrable-from-use shape (arrows, function
    // expressions, call/member results): TS infers the type — register the name
    // so the cast rules treat it as typed.
    if (
      init.kind === "ArrowFunctionExpression" ||
      init.kind === "FunctionExpression" ||
      init.kind === "CallExpression" ||
      init.kind === "MemberExpression"
    ) {
      this.annotations.set(name, "(inferred)");
    }
    return "";
  }

  // Full annotation inference: the TypeText primitives plus RegExp literals,
  // array literals, and object literals (the shapes the oracle resolves).
  private inferAnnotation(init: JsNode): string | null {
    switch (init.kind) {
      case "Literal": {
        if (init.fields["regex.pattern"] !== undefined) return "RegExp";
        const value = nodeValue(init);
        if (typeof value === "number") return "number";
        if (typeof value === "string") return "string";
        if (typeof value === "boolean") return "boolean";
        if (value === null) return "null";
        return null;
      }
      case "TemplateLiteral":
        return "string";
      case "ArrayExpression":
        return "Array<unknown>";
      case "ObjectExpression":
        return "Record<string, unknown>";
      case "NewExpression": {
        const callee = kid(init, "callee")!;
        if (callee.kind === "Identifier") return String(scalar(callee, "name") ?? "");
        return null;
      }
      default:
        return null;
    }
  }

  protected override functionReturnType(node: JsNode, functionName: string): string {
    void functionName;
    // TS rejects return annotations on constructors and set accessors — the
    // caller context marks those by passing the kind via functionName.
    if (functionName === "constructor") return "";
    const declared = kid(node, "returnType");
    if (declared !== null) {
      this.erase(declared, "declared return type");
      return "";
    }
    return node.fields["async"] === true ? ": Promise<unknown>" : ": unknown";
  }

  protected override catchParamAnnotation(_param: JsNode | null): string {
    void _param;
    return "";
  }

  // The catch annotation rides INSIDE the parens: `} catch (error: unknown) {`.
  protected override catchClause(paramText: string): string {
    // paramText is " (pattern)" — inject the annotation before the closing paren.
    return `} catch${paramText.slice(0, -1)}: unknown) {`;
  }

  // Honest parameter annotations: `unknown` (never implicit any, never blanket
  // any). Rest parameters need the array type; defaulted parameters infer.
  protected override paramAnnotation(node: JsNode, isRest: boolean): string {
    void node;
    return isRest ? ": unknown[]" : ": unknown";
  }

  protected override fieldAnnotation(_key: string, value: JsNode | null): string {
    if (value !== null) {
      const inferred = inferTypeFromExpression(value, this);
      if (inferred !== "unknown") return `: ${inferred}`;
    }
    return ": unknown";
  }

  // Runtime-neutral assertions where strict TS rejects operators on unknowns. The
  // assertion is erased at runtime, so behavior is provably preserved; the ledger
  // records each site.
  protected override operandExpression(
    node: JsNode,
    operator: string | null,
    hint?: { readonly siblingIsString: boolean },
  ): string {
    const text = this.printExpression(node);
    if (operator === null || text === "this" || text === "super") return text;
    let operandKind = operandKindForOperator(operator);
    if (operandKind === null) return text;
    if (operator === "+" && hint?.siblingIsString === true) operandKind = "string";
    if (!this.isUntypedValue(node)) return text;
    this.record({
      span: node.span,
      sourceKind: "js.operand",
      rule: `js.operand→ts.assert-${operandKind}`,
      decision: "deterministic",
      rationale:
        "runtime-neutral type assertion: strict TS rejects the operator on `unknown`; the assertion is erased at runtime so behavior is provably preserved",
      adaptation: `as ${operandKind}`,
      targetSummary: `${text} as ${operandKind}`,
    });
    return `(${text} as ${operandKind})`;
  }

  // A value is UNTYPED when its static type is unknown: unannotated identifiers,
  // member/call results, and dynamic results. Literals, templates, and inferred
  // bindings are typed. The classification drives cast insertion only.
  protected override isUntypedValue(node: JsNode): boolean {
    if (node.kind === "Literal") return false;
    if (node.kind === "TemplateLiteral") return false;
    if (node.kind === "Identifier") {
      const name = String(scalar(node, "name") ?? "");
      if (KNOWN_GLOBALS.has(name) || this.classNames.has(name)) return false;
      if (this.annotations.has(name)) return false;
      return this.lookupType(name) === "unknown";
    }
    return true;
  }

  protected override isStringLike(node: JsNode): boolean {
    if (node.kind === "Literal") return typeof node.fields["value"] === "string";
    if (node.kind === "TemplateLiteral") return true;
    if (node.kind === "Identifier") {
      const name = String(scalar(node, "name") ?? "");
      if (this.annotations.get(name) === "string") return true;
      return this.lookupType(name) === "string";
    }
    return false;
  }

  protected override memberObjectExpression(node: JsNode): string {
    const text = this.printExpression(node);
    if (node.kind === "Identifier") {
      const name = String(scalar(node, "name") ?? "");
      if (KNOWN_GLOBALS.has(name) || this.classNames.has(name)) return text;
    }
    if (!this.isUntypedValue(node)) return text;
    this.record({
      span: node.span,
      sourceKind: "js.member-object",
      rule: "js.member-object→ts.assert-record",
      decision: "deterministic",
      rationale:
        "runtime-neutral type assertion for member access on an untyped value (strict TS); erased at runtime",
      adaptation: "as unknown as Record<PropertyKey, unknown>",
      targetSummary: `${text} as unknown as Record<PropertyKey, unknown>`,
    });
    return `(${text} as unknown as Record<PropertyKey, unknown>)`;
  }

  protected override calleeExpression(node: JsNode): string {
    const text = this.printExpression(node);
    if (node.kind === "Identifier") {
      const name = String(scalar(node, "name") ?? "");
      if (KNOWN_GLOBALS.has(name) || this.classNames.has(name)) return text;
      if (this.annotations.has(name)) return text;
      if (this.lookupType(name) === "unknown" && !this.isKnownCallable(name)) {
        this.record({
          span: node.span,
          sourceKind: "js.callee",
          rule: "js.callee→ts.assert-callable",
          decision: "deterministic",
          rationale:
            "runtime-neutral type assertion for calling an `unknown` value (strict TS); erased at runtime",
          adaptation: "as (...args: unknown[]) => unknown",
          targetSummary: `${text} as callable`,
        });
        return `(${text} as unknown as (...args: unknown[]) => unknown)`;
      }
      return text;
    }
    if (node.kind === "MemberExpression") {
      // Method call on a dynamic receiver: the base cast already applied; the
      // member result is unknown and must assert callable.
      this.record({
        span: node.span,
        sourceKind: "js.callee",
        rule: "js.callee→ts.assert-callable",
        decision: "deterministic",
        rationale:
          "runtime-neutral type assertion for calling a method of an untyped receiver (strict TS); erased at runtime",
        adaptation: "as (...args: unknown[]) => unknown",
        targetSummary: `${text} as callable`,
      });
      return `(${text} as unknown as (...args: unknown[]) => unknown)`;
    }
    return text;
  }

  private isKnownCallable(name: string): boolean {
    // Unit-local functions and classes are callable; imported/unknown names assert.
    const body = this.unit.parseResult.ast.fields["body"];
    if (!Array.isArray(body)) return false;
    for (const statement of body as readonly JsNode[]) {
      if (
        (statement.kind === "FunctionDeclaration" || statement.kind === "ClassDeclaration") &&
        String(scalar(kid(statement, "id"), "name") ?? "") === name
      ) {
        return true;
      }
      if (statement.kind === "VariableDeclaration") {
        for (const declarator of kids(statement, "declarations")) {
          const init = kid(declarator, "init");
          const id = kid(declarator, "id");
          if (
            id !== null &&
            String(scalar(id, "name") ?? "") === name &&
            init !== null &&
            (init.kind === "ArrowFunctionExpression" ||
              init.kind === "FunctionExpression" ||
              init.kind === "CallExpression" ||
              init.kind === "MemberExpression")
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }
}

function nodeValue(node: JsNode): unknown {
  return node.fields["value"];
}

function operandKindForOperator(operator: string): "number" | "string" | null {
  switch (operator) {
    case "+":
    case "-":
    case "*":
    case "/":
    case "%":
    case "**":
    case "<":
    case "<=":
    case ">":
    case ">=":
      return "number";
    case "&&":
    case "||":
    case "??":
    case "==":
    case "!=":
    case "===":
    case "!==":
      return null; // boolean/logical contexts accept unknown operands
    default:
      return null;
  }
}
