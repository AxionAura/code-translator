// Pytest → Vitest test translation (roadmap M6 WS B): the documented basic
// subset — test functions (test_*), plain Test classes (no __init__/inheritance),
// assert patterns, simple function-scoped factory fixtures (same module or
// conftest), and basic parametrize. Everything outside the subset is reported
// unsupported-loud (marker + ledger + warning), never silently dropped:
// monkeypatch, fixture scopes/yield/autouse, pytest.raises with match=, plugins.
//
// The mapper reuses the production lowering: expressions and statements render
// through the real Emitter (assign/let semantics, truthiness provability, helper
// routing, runtime-helper injection), so test code carries the same semantics and
// ledger provenance as translated source.
import type {
  AnalyzedUnit,
  AstNode,
  LedgerEntry,
  ModuleGraphModel,
  RegistryLookup,
  UnitTranslationContext,
} from "@ctrans/core";
import { CTransError, normalizeModuleId, targetPathForModule } from "@ctrans/core";

import { LoweringContext, ScopeStack } from "./context.js";
import { Emitter } from "./lower.js";
import { RUNTIME_EXCEPTION_CLASSES, RUNTIME_HELPERS, helperClosure } from "./helpers.js";
import { importedSymbolKindsFor } from "./translator.js";

const VITEST_IMPORTS = `import { describe, expect, it } from "vitest";`;

export interface UnsupportedTestConstruct {
  readonly kind: string;
  readonly reason: string;
  readonly line: number | null;
}

export interface TranslatedTestModule {
  // Target path: test_x.py -> test_x.test.ts (vitest's default include pattern).
  readonly targetPath: string;
  readonly content: string;
  readonly ledger: readonly LedgerEntry[];
  // Logical test names in pytest convention ("test_add", "TestCalc.test_add") —
  // the differential runner matches source and target by these.
  readonly testNames: readonly string[];
  readonly unsupported: readonly UnsupportedTestConstruct[];
  // Runtime helper names this module's lowering referenced (the shared runtime
  // file covers the union across the project).
  readonly helpers: readonly string[];
  // Runtime exception classes this module's lowering referenced (e.g. the
  // pytest.raises target) — the shared runtime emits the hierarchy when needed.
  readonly exceptions: readonly string[];
}

export interface TestMapperContext {
  readonly graph: ModuleGraphModel;
  // Fixture functions available from the nearest conftest (fixture name -> the
  // translated export name in conftest.js).
  readonly conftestFixtures: ReadonlyMap<string, string>;
  // Import specifier for the translated conftest module (default "./conftest.ts";
  // conftest.py translates to conftest.ts per the module path policy).
  readonly conftestSpecifier?: string;
  // The analyzed units of the whole project: imported names resolve to classes vs
  // functions (class construction must lower to `new` in test code too).
  readonly analyzed: ReadonlyMap<string, AnalyzedUnit>;
  readonly registry: RegistryLookup;
}

interface FixtureDef {
  readonly name: string;
  readonly functionNode: import("@ctrans/core").AstNode;
}

interface ParametrizeSpec {
  readonly names: readonly string[];
  readonly cases: readonly import("@ctrans/core").AstNode[];
}

export class PytestToVitestMapper {
  // Explicit fields (not parameter properties): the unbuilt CLI runs sources
  // through Node strip-only mode, which rejects transform-only syntax.
  private readonly unit: AnalyzedUnit;
  private readonly context: TestMapperContext;
  private readonly ctx: LoweringContext;
  private readonly emitter: Emitter;
  private readonly importLines: string[] = [];
  private readonly bodyLines: string[] = [];
  private readonly testNames: string[] = [];
  private readonly unsupported: UnsupportedTestConstruct[] = [];
  private readonly fixtures = new Map<string, FixtureDef>();
  private readonly declaredFixtures = new Set<string>();

  constructor(unit: AnalyzedUnit, context: TestMapperContext) {
    this.unit = unit;
    this.context = context;
    this.ctx = new LoweringContext("typescript", unit.filename);
    const analyzed: UnitTranslationContext["analyzed"] = context.analyzed;
    this.emitter = new Emitter(
      this.ctx,
      new ScopeStack(),
      new Set(pythonExportedNames(unit)),
      importedSymbolKindsFor(unit, context.graph, { analyzed }),
      new Set(),
      new Set(),
      context.registry,
    );
  }

  async translateModule(): Promise<TranslatedTestModule> {
    const body = moduleBody(this.unit.parseResult.ast);
    // Pass 1: collect fixtures (this module) and detect unsupported module-level
    // constructs (imports of pytest plugins etc.).
    const moduleLevelTestClasses: import("@ctrans/core").AstNode[] = [];
    for (const statement of body) {
      if (statement.kind === "FunctionDef" && isFixtureDef(statement)) {
        const name = String(scalar(statement, "name") ?? "");
        this.fixtures.set(name, { name, functionNode: statement });
        continue;
      }
      if (statement.kind === "ClassDef") {
        const className = String(scalar(statement, "name") ?? "");
        if (className.startsWith("Test")) {
          moduleLevelTestClasses.push(statement);
          continue;
        }
      }
      if (statement.kind === "Import" || statement.kind === "ImportFrom") {
        // Import statements are rendered by emittedImports(); the bound names
        // still need their scope kinds (imported classes must lower to `new`).
        this.emitter.noteImportBindings(statement);
      }
    }
    this.emittedImports();

    // Pass 2: fixtures first (emitted as fixture_<name> functions), then tests in
    // source order.
    for (const [name, fixture] of this.fixtures) {
      this.emitFixture(name, fixture, false);
    }
    for (const statement of body) {
      if (statement.kind === "FunctionDef") {
        const name = String(scalar(statement, "name") ?? "");
        if (this.fixtures.has(name)) continue;
        if (name.startsWith("test_")) {
          this.emitTestFunction(statement);
          continue;
        }
        // Plain helper functions are emitted so tests can call them.
        this.emitPlainFunction(statement);
        continue;
      }
      if (statement.kind === "ClassDef") {
        if (moduleLevelTestClasses.includes(statement)) {
          this.emitTestClass(statement);
          continue;
        }
      }
    }
    if (this.testNames.length === 0 && this.unsupported.length === 0) {
      this.unsupported.push({
        kind: "module",
        reason: "no pytest test functions or Test classes found in this module",
        line: null,
      });
    }
    const runtimeImport = this.runtimeImport();
    const raw = [VITEST_IMPORTS, ...this.importLines, runtimeImport, ...this.bodyLines]
      .filter(Boolean)
      .join("\n");
    return {
      targetPath: this.unit.filename.replace(/\.py$/, ".test.ts"),
      content: await this.format(raw),
      ledger: this.ctx.ledger,
      testNames: [...this.testNames],
      unsupported: [...this.unsupported],
      helpers: [...this.ctx.helpers],
      exceptions: [...this.ctx.exceptionClasses],
    };
  }

  // D-012: formatting is mechanical — the mapper's output passes through prettier
  // exactly like the source translator's (surfaced, never swallowed).
  private async format(code: string): Promise<string> {
    const { format } = await import("prettier");
    try {
      return await format(code, { parser: "typescript", semi: true });
    } catch (error) {
      throw new CTransError(
        "CG-FORMAT-FAILED",
        `prettier could not format generated test module: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  // ---- imports ------------------------------------------------------------------

  private emittedImportsDone = false;
  private emittedImports(): void {
    if (this.emittedImportsDone) return;
    this.emittedImportsDone = true;
    const node = this.context.graph.modules[this.unit.filename];
    const imports = node?.imports.filter((entry) => entry.importKind === "static") ?? [];
    const sourceImports = this.unit.parseResult.module?.imports ?? [];
    imports.forEach((graphImport, index) => {
      const sourceImport = sourceImports[index];
      if (sourceImport === undefined) return;
      // `from __future__ import ...` is a compile-time directive (no runtime effect).
      if (graphImport.specifier === "__future__") {
        this.importLines.push(`// ctrans: __future__ directive has no target emission`);
        return;
      }
      if (graphImport.status === "unresolved") {
        this.importLines.push(`// ctrans: unresolved import "${graphImport.specifier}"`);
        return;
      }
      const myDir = dirname(this.unit.filename);
      const importedName = sourceImport.importedName;
      const localName = sourceImport.localName;
      const targetId = graphImport.resolvedModuleId;
      if (graphImport.status === "resolved" && targetId !== null) {
        const specifier = relativeImportSpecifier(myDir, targetPathForModule(targetId, ".ts"));
        const localName = sourceImport.localName;
        const importedName = sourceImport.importedName;
        if (sourceImport.kind === "namespace" || importedName === null) {
          this.importLines.push(`import * as ${localName ?? "module"} from "${specifier}";`);
          return;
        }
        if (localName !== null && localName !== importedName) {
          this.importLines.push(`import { ${importedName} as ${localName} } from "${specifier}";`);
        } else {
          this.importLines.push(`import { ${importedName} } from "${specifier}";`);
        }
        return;
      }
      // External: pytest itself is special-cased in the lowering. A test module's
      // own directory is on pytest's import path, so an unresolved absolute
      // import to a SIBLING module is test-local, not external. Everything else
      // is an honest unmapped comment (S3 reports it).
      if (graphImport.specifier !== "pytest") {
        // pytest puts the test module's own directory on the import path: an
        // unresolved absolute import to a SIBLING module (named by the MODULE
        // specifier, not the imported symbol) is test-local.
        if (myDir !== "") {
          const siblingId = normalizeModuleId(`${myDir}/${graphImport.specifier}.py`);
          if (this.context.graph.modules[siblingId] !== undefined) {
            const spec = relativeImportSpecifier(myDir, targetPathForModule(siblingId, ".ts"));
            this.importLines.push(
              importedName === localName || localName === null || importedName === null
                ? `import { ${localName ?? importedName} } from "${spec}";`
                : `import { ${importedName} as ${localName} } from "${spec}";`,
            );
            return;
          }
        }
        this.importLines.push(`// ctrans: external import "${graphImport.specifier}" (unmapped)`);
      }
    });
    // Conftest fixtures: import the fixture functions from the translated conftest.
    for (const [name, target] of this.context.conftestFixtures) {
      this.importLines.push(
        `import { ${target} } from "${this.context.conftestSpecifier ?? "./conftest.ts"}"; // fixture ${name}`,
      );
    }
    // Merge repeated imports of the same module (pytest test modules commonly
    // import several names from one sibling): one statement per specifier.
    const merged = new Map<string, string[]>();
    const standalone: string[] = [];
    for (const line of this.importLines) {
      const match = /^import \{ (.+?) \} from "(.+?)";$/.exec(line);
      if (match === null) {
        standalone.push(line);
        continue;
      }
      const names = (merged.get(match[2]!) ?? []).concat(
        match[1]!.split(", ").map((n) => n.trim()),
      );
      merged.set(match[2]!, names);
    }
    this.importLines.length = 0;
    for (const [specifier, names] of [...merged].sort(([a], [b]) => (a < b ? -1 : 1))) {
      this.importLines.push(
        `import { ${[...new Set(names)].sort().join(", ")} } from "${specifier}";`,
      );
    }
    this.importLines.push(...standalone);
  }

  private runtimeImport(): string {
    // Mirrors PyToJsTranslator.finalizeUnits: the shared runtime covers the project
    // union; internal helpers (used inside the runtime itself) are never imported,
    // and only the generated exception hierarchy's classes are imported by name.
    const closure = helperClosure([...this.ctx.helpers]);
    const helperNames = closure.helpers
      .filter((name) => RUNTIME_HELPERS[name]?.internal !== true)
      .map((name) => `__ctrans_${name}`);
    const exceptionNames = [...this.ctx.exceptionClasses].filter((name) =>
      RUNTIME_EXCEPTION_CLASSES.includes(name),
    );
    const all = [...helperNames, ...exceptionNames].sort();
    if (all.length === 0) return "";
    // The runtime lives at the project root; the specifier is relative to THIS
    // test file's target directory (tests/test_x.py imports ../__ctrans_runtime.ts).
    const targetPath = this.unit.filename.replace(/\.py$/, ".test.ts");
    const specifier = relativeImportSpecifier(dirname(targetPath), "__ctrans_runtime.ts");
    return `import { ${all.join(", ")} } from "${specifier}";`;
  }

  // ---- fixtures -----------------------------------------------------------------

  private isConftestFixture(name: string): boolean {
    return this.context.conftestFixtures.has(name) && !this.fixtures.has(name);
  }

  private fixtureCallName(name: string): string {
    if (this.fixtures.has(name)) return `fixture_${name}`;
    if (this.isConftestFixture(name)) {
      return this.context.conftestFixtures.get(name) ?? `fixture_${name}`;
    }
    return null as unknown as string;
  }

  private emitFixture(name: string, fixture: FixtureDef, fromConftest: boolean): void {
    void fromConftest;
    const decorators = kids(fixture.functionNode, "decorator_list");
    // The basic subset: a plain @pytest.fixture (no arguments) factory.
    const fixtureDecorator = decorators.find((decorator) => decoratorIs(decorator, ["fixture"]));
    const plainFixture =
      decorators.length === 1 &&
      fixtureDecorator !== undefined &&
      !decoratorCarriesArguments(fixtureDecorator);
    if (!plainFixture) {
      this.unsupported.push({
        kind: "fixture",
        reason: decoratorArgumentReason(decorators),
        line: lineOf(fixture.functionNode),
      });
      this.ctx.record({
        span: pySpan(fixture.functionNode),
        sourceKind: "pytest.fixture",
        rule: "pytest.fixture→unsupported",
        decision: "unsupported",
        rationale: decoratorArgumentReason(decorators),
        warnings: ["CTW-UNSUPPORTED-FIXTURE"],
        targetSummary: null,
      });
      return;
    }
    const args = kid(fixture.functionNode, "args")!;
    const positional = [...kids(args, "posonlyargs"), ...kids(args, "args")];
    if (positional.length > 0) {
      // Fixture-of-fixture parameters are outside the M6 subset.
      this.unsupported.push({
        kind: "fixture",
        reason: "fixture has parameters (fixture chains are outside the basic subset)",
        line: lineOf(fixture.functionNode),
      });
      return;
    }
    if (this.declaredFixtures.has(name)) return;
    this.declaredFixtures.add(name);
    const bodyNode = fixture.functionNode;
    this.bodyLines.push(
      this.renderFunction(
        `fixture_${name}`,
        bodyNode,
        positional.map((arg) => String(scalar(arg, "arg") ?? "")),
      ),
    );
  }

  // ---- tests --------------------------------------------------------------------

  private emitTestFunction(node: import("@ctrans/core").AstNode): void {
    const name = String(scalar(node, "name") ?? "");
    const decorators = kids(node, "decorator_list");
    const parametrize = decorators
      .map((decorator) => this.parseParametrize(decorator))
      .find((entry) => entry !== null);
    const otherDecorators = decorators.filter(
      (decorator) => this.parseParametrize(decorator) === null,
    );
    if (otherDecorators.length > 0) {
      this.unsupported.push({
        kind: "decorator",
        reason: `test decorator ${describeDecorator(otherDecorators[0]!)} is outside the basic subset`,
        line: lineOf(node),
      });
      this.ctx.record({
        span: pySpan(node),
        sourceKind: "pytest.decorator",
        rule: "pytest.decorator→unsupported",
        decision: "unsupported",
        rationale: "test decorators beyond parametrize are outside the M6 subset",
        warnings: ["CTW-UNSUPPORTED-TEST-DECORATOR"],
        targetSummary: null,
      });
      return;
    }
    const args = kid(node, "args")!;
    const positional = [...kids(args, "posonlyargs"), ...kids(args, "args")];
    const params = positional.map((arg) => String(scalar(arg, "arg") ?? ""));
    // Fixture params: plain binding via fixture call, pre-declared so body
    // assignments rebind (Python semantics).
    const preBindings: string[] = [];
    this.emitter.pushScopeForTest(params);
    for (const param of params) {
      const fixtureCall = this.fixtureCallName(param);
      if (fixtureCall !== null) {
        if (!this.fixtures.has(param) && !this.isConftestFixture(param)) {
          this.unsupported.push({
            kind: "fixture",
            reason: `parameter '${param}' matches no known fixture`,
            line: lineOf(node),
          });
          continue;
        }
        if (this.fixtures.has(param)) this.emitFixture(param, this.fixtures.get(param)!, false);
        preBindings.push(`let ${param} = ${fixtureCall}();`);
        this.emitter.preDeclareBinding(param);
      } else if (parametrize !== undefined) {
        // A plain parameter of a parametrized test: pre-declared; the cases
        // supply values at run time.
        this.emitter.preDeclareBinding(param);
      } else {
        // Not a fixture, not parametrized: an unknown parameter (monkeypatch,
        // tmp_path, plugins...) — reported, never silently bound to undefined.
        this.unsupported.push({
          kind: "fixture",
          reason: `parameter '${param}' matches no known fixture (built-in/plugin fixtures like monkeypatch are outside the basic subset)`,
          line: lineOf(node),
        });
        this.ctx.record({
          span: pySpan(node),
          sourceKind: "pytest.fixture-param",
          rule: "pytest.fixture-param→unsupported",
          decision: "unsupported",
          rationale: `test parameter '${param}' is not a recognized fixture; builtin/plugin fixtures are outside the M6 subset`,
          warnings: ["CTW-UNSUPPORTED-FIXTURE"],
          targetSummary: null,
        });
      }
    }

    const bodyStatements = kids(node, "body")
      .map((statement) => this.renderTestStatement(statement, "  "))
      .filter((text) => text !== "");
    if (parametrize === undefined) {
      this.testNames.push(name);
      this.bodyLines.push(
        [`it(${JSON.stringify(name)}, () => {`, ...preBindings, ...bodyStatements, `});`].join(
          "\n",
        ),
      );
      this.ctx.record({
        span: pySpan(node),
        sourceKind: "pytest.test",
        rule: "pytest.test→vitest.it",
        decision: "deterministic",
        rationale: "test function correspondence (name preserved for differential matching)",
        targetSummary: `it(${JSON.stringify(name)})`,
      });
    } else {
      // Vitest each with object cases and $-interpolation: deterministic names
      // carrying the parameter values (differential matching uses the prefix).
      const caseNodes = parametrize.cases.map((caseNode) =>
        this.renderParamCase(caseNode, parametrize.names),
      );
      const caseList = caseNodes.join(", ");
      const nameTemplate = `${name} ${parametrize.names.map((param) => `$${param}`).join(" ")}`;
      this.testNames.push(name);
      this.bodyLines.push(
        [
          `it.each([${caseList}])(${JSON.stringify(nameTemplate).replace(/"(\$[a-zA-Z_]*) /, '"$1 ')}, ({ ${parametrize.names.join(", ")} }) => {`,
          ...preBindings,
          ...bodyStatements,
          `});`,
        ].join("\n"),
      );
      this.ctx.record({
        span: pySpan(node),
        sourceKind: "pytest.parametrize",
        rule: "pytest.parametrize→vitest.each",
        decision: "semantic",
        rationale:
          "parametrize maps to vitest it.each with object cases; test names carry the parameter values (differential matching uses the test-name prefix)",
        adaptation: "it.each object cases",
        targetSummary: `it.each(${String(parametrize.cases.length)} cases)`,
      });
    }
    this.emitter.popScopeForTest();
  }

  private renderParamCase(
    caseNode: import("@ctrans/core").AstNode,
    names: readonly string[],
  ): string {
    // A case is a tuple (or a single value for one param): lower each element.
    if (caseNode.kind === "Tuple" || caseNode.kind === "List") {
      const elements = kids(caseNode, "elts").map((element) => this.emitter.lowerExpr(element));
      if (names.length === 1) {
        return `{ ${names[0]}: [${elements.join(", ")}] }`;
      }
      const pairs = elements.map((element, index) => `${names[index]}: ${element}`);
      return `{ ${pairs.join(", ")} }`;
    }
    const value = this.emitter.lowerExpr(caseNode);
    return `{ ${names[0]}: ${value} }`;
  }

  private emitTestClass(node: import("@ctrans/core").AstNode): void {
    const className = String(scalar(node, "name") ?? "");
    const body = kids(node, "body");
    const hasInit = body.some(
      (statement) =>
        (statement.kind === "FunctionDef" || statement.kind === "AsyncFunctionDef") &&
        String(scalar(statement, "name") ?? "") === "__init__",
    );
    const bases = kids(node, "bases");
    if (hasInit || bases.length > 0) {
      this.unsupported.push({
        kind: "test-class",
        reason: `Test class ${className} has __init__ or base classes (outside the basic subset)`,
        line: lineOf(node),
      });
      this.ctx.record({
        span: pySpan(node),
        sourceKind: "pytest.test-class",
        rule: "pytest.test-class→unsupported",
        decision: "unsupported",
        rationale: "Test classes with __init__ or inheritance are outside the M6 subset",
        warnings: ["CTW-UNSUPPORTED-TEST-CLASS"],
        targetSummary: null,
      });
      return;
    }
    const methods = body.filter(
      (statement) => statement.kind === "FunctionDef" || statement.kind === "AsyncFunctionDef",
    );
    const testMethods = methods.filter((method) =>
      String(scalar(method, "name") ?? "").startsWith("test_"),
    );
    const helperMethods = methods.filter((method) => !testMethods.includes(method));
    if (helperMethods.length > 0) {
      this.unsupported.push({
        kind: "test-class",
        reason: `Test class ${className} has non-test methods (helper methods on Test classes are outside the basic subset)`,
        line: lineOf(node),
      });
    }
    this.bodyLines.push(`describe(${JSON.stringify(className)}, () => {`);
    for (const method of testMethods) {
      const methodName = String(scalar(method, "name") ?? "");
      const testName = `${className}.${methodName}`;
      this.testNames.push(testName);
      // Drop `self`; methods become plain functions inside describe.
      this.bodyLines.push(
        this.renderFunction(
          methodName,
          method,
          ["self"],
          `it(${JSON.stringify(methodName)}, () => {`,
          `});`,
        ),
      );
      this.ctx.record({
        span: pySpan(method),
        sourceKind: "pytest.test-method",
        rule: "pytest.test-method→vitest.it",
        decision: "deterministic",
        rationale: "Test-class method correspondence (self dropped; plain methods only)",
        targetSummary: `it(${JSON.stringify(testName)})`,
      });
    }
    this.bodyLines.push(`});`);
  }

  private emitPlainFunction(node: AstNode): void {
    const name = String(scalar(node, "name") ?? "");
    const args = kid(node, "args")!;
    const positional = [...kids(args, "posonlyargs"), ...kids(args, "args")];
    const params = positional.map((arg) => String(scalar(arg, "arg") ?? ""));
    this.bodyLines.push(this.renderFunction(name, node, params));
  }

  // Render a Python def into a TS function with the given name (the Emitter's
  // statement machinery runs; ledger provenance preserved).
  private renderFunction(
    functionName: string,
    defNode: import("@ctrans/core").AstNode,
    params: readonly string[],
    wrapOpen?: string,
    wrapClose?: string,
  ): string {
    const body = kids(defNode, "body");
    const lines: string[] = [];
    const header = `function ${functionName}(${params.join(", ")}) {`;
    this.emitter.pushScopeForTest(params);
    const bodyText = body
      .map((statement) => this.renderTestStatement(statement, "  "))
      .filter((text) => text !== "");
    this.emitter.popScopeForTest();
    lines.push(wrapOpen ?? header);
    lines.push(...bodyText);
    lines.push(wrapClose ?? "}");
    return lines.join("\n");
  }

  // ---- statements (test subset) -------------------------------------------------

  private renderTestStatement(node: import("@ctrans/core").AstNode, indent: string): string {
    switch (node.kind) {
      case "Assert":
        return this.renderAssert(node, indent);
      case "With":
        return this.renderWith(node, indent);
      case "FunctionDef":
      case "AsyncFunctionDef": {
        // Nested defs inside tests: rendered as inner functions.
        const name = String(scalar(node, "name") ?? "");
        const nested = this.renderFunction(name, node, []);
        return indent + nested.split("\n").join(`\n${indent}`);
      }
      default: {
        // Everything else goes through the production lowering (Assign/Expr/If/
        // While/For/Raise/AugAssign/... with full ledger provenance).
        const text = this.emitter.renderStatement(node);
        if (text.trim() === "") return "";
        return indent + text.split("\n").join(`\n${indent}`);
      }
    }
  }

  private renderAssert(node: import("@ctrans/core").AstNode, indent: string): string {
    const test = kid(node, "test")!;
    const msg = kid(node, "msg");
    const messageText = msg !== null ? `, ${this.emitter.lowerExpr(msg)}` : "";
    const mapped = this.mapAssertTest(test);
    this.ctx.record({
      span: pySpan(node),
      sourceKind: "pytest.assert",
      rule: `pytest.assert→vitest.expect.${mapped.kind}`,
      decision: "deterministic",
      rationale: mapped.rationale,
      targetSummary: mapped.text,
    });
    return `${indent}expect(${mapped.text})${messageText};`;
  }

  private mapAssertTest(test: import("@ctrans/core").AstNode): {
    kind: string;
    text: string;
    rationale: string;
  } {
    // assert lhs == rhs → expect(lhs).toEqual(rhs) (deep equality matches Python
    // == for sequences; primitives compare by value).
    if (test.kind === "Compare") {
      const ops = kids(test, "ops");
      const comparators = kids(test, "comparators");
      if (ops.length === 1) {
        const op = ops[0]!.kind;
        const lhs = this.emitter.lowerExpr(kid(test, "left")!);
        const rhs = this.emitter.lowerExpr(comparators[0]!);
        if (op === "Eq") {
          return {
            kind: "toEqual",
            text: `${lhs}).toEqual(${rhs}`,
            rationale:
              "== maps to deep equality (Python == semantics for sequences and primitives)",
          };
        }
        if (op === "NotEq") {
          return {
            kind: "not.toEqual",
            text: `${lhs}).not.toEqual(${rhs}`,
            rationale: "!= maps to negated deep equality",
          };
        }
        if (op === "Is") {
          return {
            kind: "toBe",
            text: `${lhs}).toBe(${rhs}`,
            rationale: "is maps to identity (toBe)",
          };
        }
        if (op === "IsNot") {
          return {
            kind: "not.toBe",
            text: `${lhs}).not.toBe(${rhs}`,
            rationale: "is not maps to negated identity",
          };
        }
        if (op === "In") {
          this.ctx.useHelper("contains");
          return {
            kind: "contains",
            text: `__ctrans_contains(${rhs}, ${lhs})).toBe(true`,
            rationale: "in maps to the Python-membership helper (== on members)",
          };
        }
        if (op === "NotIn") {
          this.ctx.useHelper("contains");
          return {
            kind: "not-contains",
            text: `__ctrans_contains(${rhs}, ${lhs})).toBe(false`,
            rationale: "not in maps to the negated Python-membership helper",
          };
        }
        // Ordering comparisons: keep the Python comparison helpers.
        const orderMap: Record<string, string> = { Lt: "lt", LtE: "lte", Gt: "gt", GtE: "gte" };
        const helper = orderMap[op];
        if (helper !== undefined) {
          this.ctx.useHelper(helper);
          return {
            kind: `order.${helper}`,
            text: `__ctrans_${helper}(${lhs}, ${rhs})).toBe(true`,
            rationale: "ordering comparison via the Python-comparison helper",
          };
        }
      }
    }
    if (test.kind === "Call") {
      // isinstance(x, T) → toBeInstanceOf.
      const func = kid(test, "func")!;
      if (func.kind === "Name" && scalar(func, "id") === "isinstance") {
        const args = kids(test, "args");
        if (args.length === 2 && args[1]!.kind === "Name") {
          const lhs = this.emitter.lowerExpr(args[0]!);
          const className = String(scalar(args[1]!, "id") ?? "");
          return {
            kind: "instanceof",
            text: `${lhs}).toBeInstanceOf(${className}`,
            rationale:
              "isinstance maps to toBeInstanceOf (user classes and the generated exception hierarchy)",
          };
        }
      }
    }
    if (test.kind === "UnaryOp" && kid(test, "op")!.kind === "Not") {
      const inner = this.mapAssertTest(kid(test, "operand") ?? test);
      // `assert not (x == y)` → expect(...).not... where the inner mapping is a
      // bare call; invert the boolean result.
      if (
        inner.kind === "contains" ||
        inner.kind === "not-contains" ||
        inner.kind.startsWith("order.")
      ) {
        const inverted =
          inner.kind === "contains"
            ? "toBe(false"
            : inner.kind === "not-contains"
              ? "toBe(true"
              : `toBe(${inner.kind.startsWith("order.") ? "" : ""})`;
        void inverted;
        return {
          kind: `not.${inner.kind}`,
          text: inner.text
            .replace(".toBe(true", ".toBe(false")
            .replace(".toBe(false", ".toBe(true"),
          rationale: inner.rationale,
        };
      }
      const operand = this.emitter.lowerExpr(kid(test, "operand") ?? test);
      this.ctx.useHelper("truthy");
      return {
        kind: "truthy.false",
        text: `__ctrans_truthy(${operand})).toBe(false`,
        rationale: "assert not maps to negated Python truthiness",
      };
    }
    // General truthiness.
    const text = this.emitter.lowerExpr(test);
    this.ctx.useHelper("truthy");
    return {
      kind: "truthy",
      text: `__ctrans_truthy(${text})).toBe(true`,
      rationale: "assert maps to Python truthiness (NaN/[]/{} divergence handled)",
    };
  }

  private renderWith(node: import("@ctrans/core").AstNode, indent: string): string {
    const items = kids(node, "items");
    // pytest.raises(E) as the sole context manager → toThrow.
    if (items.length === 1) {
      const item = items[0]!;
      const contextExpr = kid(item, "context_expr")!;
      if (contextExpr.kind === "Call") {
        const func = kid(contextExpr, "func")!;
        if (func.kind === "Attribute" && scalar(func, "attr") === "raises") {
          const receiver = kid(func, "value")!;
          if (receiver.kind === "Name" && scalar(receiver, "id") === "pytest") {
            return this.renderRaises(node, contextExpr, indent);
          }
        }
      }
    }
    this.unsupported.push({
      kind: "with",
      reason: "with blocks other than pytest.raises are outside the test subset",
      line: lineOf(node),
    });
    this.ctx.record({
      span: pySpan(node),
      sourceKind: "pytest.with",
      rule: "pytest.with→unsupported",
      decision: "unsupported",
      rationale: "with blocks other than pytest.raises are outside the test subset",
      warnings: ["CTW-UNSUPPORTED-WITH"],
      targetSummary: null,
    });
    return "";
  }

  private renderRaises(
    node: import("@ctrans/core").AstNode,
    contextExpr: import("@ctrans/core").AstNode,
    indent: string,
  ): string {
    const args = kids(contextExpr, "args");
    // The raised-class target: a Python exception name maps like the production
    // raise lowering (Exception -> PythonException) and joins the runtime's
    // exception requirements; anything else lowers as an expression.
    let throwTarget = "Error";
    const excNode = args[0];
    if (excNode !== undefined && excNode.kind === "Name") {
      const pyName = String(scalar(excNode, "id") ?? "");
      if (/^[A-Z]/.test(pyName)) {
        const jsName = pyName === "Exception" ? "PythonException" : pyName;
        this.ctx.useException(jsName);
        throwTarget = jsName;
      } else {
        throwTarget = this.emitter.lowerExpr(excNode);
      }
    } else if (excNode !== undefined) {
      throwTarget = this.emitter.lowerExpr(excNode);
    }
    // Optional match= kwarg → unsupported (message regex matching is M6+).
    const kwargs = kids(contextExpr, "keywords");
    if (kwargs.length > 0) {
      this.unsupported.push({
        kind: "raises",
        reason: "pytest.raises match=/other kwargs are outside the basic subset",
        line: lineOf(node),
      });
    }
    const optionalVars = kid(items0(node), "optional_vars");
    if (optionalVars !== null) {
      this.unsupported.push({
        kind: "raises",
        reason:
          "pytest.raises 'as excinfo' (exception info inspection) is outside the basic subset",
        line: lineOf(node),
      });
    }
    const bodyStatements = kids(node, "body")
      .map((statement) => this.renderTestStatement(statement, "  "))
      .filter((text) => text !== "");
    this.ctx.record({
      span: pySpan(node),
      sourceKind: "pytest.raises",
      rule: "pytest.raises→vitest.toThrow",
      decision: "semantic",
      rationale:
        "pytest.raises(E) maps to expect(fn).toThrow(E); the generated exception hierarchy preserves the class identity",
      adaptation: "toThrow",
      targetSummary: `toThrow(${throwTarget})`,
    });
    return [
      `${indent}expect(() => {`,
      ...bodyStatements.map((text) => `  ${text}`),
      `${indent}}).toThrow(${throwTarget});`,
    ].join("\n");
  }

  private parseParametrize(decorator: import("@ctrans/core").AstNode): ParametrizeSpec | null {
    if (decorator.kind !== "Call") return null;
    const func = kid(decorator, "func")!;
    if (!(func.kind === "Attribute" && scalar(func, "attr") === "parametrize")) return null;
    const receiver = kid(func, "value")!;
    if (!(receiver.kind === "Attribute" && scalar(receiver, "attr") === "mark")) return null;
    const markReceiver = kid(receiver, "value")!;
    if (!(markReceiver.kind === "Name" && scalar(markReceiver, "id") === "pytest")) return null;
    const args = kids(decorator, "args");
    if (args.length < 2) return null;
    const namesArg = args[0]!;
    let names: string[];
    if (namesArg.kind === "Constant" && typeof namesArg.fields["value"] === "string") {
      names = String(namesArg.fields["value"])
        .split(",")
        .map((name) => name.trim());
    } else if (namesArg.kind === "List") {
      names = kids(namesArg, "elts").map((element) =>
        String(scalar(element, "id") ?? scalar(element, "value") ?? ""),
      );
    } else {
      return null;
    }
    const casesArg = args[1]!;
    const cases =
      casesArg.kind === "List" || casesArg.kind === "Tuple" ? kids(casesArg, "elts") : [casesArg];
    return { names, cases };
  }
}

// ---- module-level helpers ------------------------------------------------------

function moduleBody(ast: AstNode): readonly AstNode[] {
  const body = ast.fields["body"];
  return Array.isArray(body) ? (body as readonly AstNode[]) : [];
}

function kids(node: AstNode, name: string): readonly AstNode[] {
  const value = node.fields[name];
  return Array.isArray(value) ? (value as readonly AstNode[]) : [];
}

function kid(node: AstNode, name: string): AstNode | null {
  const value = node.fields[name];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as AstNode)
    : null;
}

function scalar(node: AstNode, name: string): string | number | boolean | null {
  const value = node.fields[name];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

function pySpan(node: AstNode): { line: number | null; column: number | null } | null {
  const span = node.span;
  if (span === null || span === undefined) return null;
  return { line: (span as { start?: { line?: number } }).start?.line ?? null, column: null };
}

function lineOf(node: AstNode): number | null {
  return pySpan(node)?.line ?? null;
}

function items0(node: AstNode): AstNode {
  const items = kids(node, "items");
  return items[0] ?? node;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function relativeImportSpecifier(fromDir: string, toPath: string): string {
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

function isFixtureDef(node: AstNode): boolean {
  return kids(node, "decorator_list").some((decorator) => decoratorIs(decorator, ["fixture"]));
}

// True when the decorator Call carries args/kwargs (scope=, autouse=, params).
function decoratorCarriesArguments(decorator: AstNode): boolean {
  if (decorator.kind !== "Call") return false;
  return kids(decorator, "args").length > 0 || kids(decorator, "keywords").length > 0;
}

function decoratorIs(decorator: AstNode, names: readonly string[]): boolean {
  if (decorator.kind !== "Call" && decorator.kind !== "Attribute" && decorator.kind !== "Name") {
    return false;
  }
  const target = decorator.kind === "Call" ? kid(decorator, "func") : decorator;
  if (target === null) return false;
  if (target.kind !== "Attribute") return false;
  const receiver = kid(target, "value");
  return (
    receiver !== null &&
    receiver.kind === "Name" &&
    scalar(receiver, "id") === "pytest" &&
    names.includes(String(scalar(target, "attr") ?? ""))
  );
}

function describeDecorator(decorator: AstNode): string {
  const target = decorator.kind === "Call" ? kid(decorator, "func") : decorator;
  if (target !== null && target.kind === "Attribute") {
    const receiver = kid(target, "value");
    if (receiver !== null && receiver.kind === "Name") {
      return `pytest.${String(scalar(target, "attr") ?? "")}`;
    }
  }
  return "unknown decorator";
}

function decoratorArgumentReason(decorators: readonly AstNode[]): string {
  const decorator = decorators[0];
  if (decorator === undefined) return "fixture without a recognizable decorator";
  if (decorator.kind === "Call") {
    const args = kids(decorator, "args");
    const kwargs = kids(decorator, "keywords");
    if (kwargs.some((keyword) => scalar(keyword, "arg") === "scope")) {
      return "fixture scopes other than function are outside the basic subset";
    }
    if (kwargs.some((keyword) => scalar(keyword, "arg") === "autouse")) {
      return "autouse fixtures are outside the basic subset";
    }
    if (args.length > 0) {
      return "parameterized fixtures are outside the basic subset";
    }
  }
  return "fixture decorator is outside the basic subset";
}

function pythonExportedNames(unit: AnalyzedUnit): ReadonlySet<string> {
  // Tests export nothing; the Emitter needs an empty export set.
  void unit;
  return new Set();
}
