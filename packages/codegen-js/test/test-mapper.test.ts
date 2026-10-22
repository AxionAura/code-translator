// Pytest → Vitest mapper tests (roadmap M6 WS B): the supported subset (test
// functions, asserts, parametrize, basic fixtures, pytest.raises, Test classes)
// and the honest unsupported surface (monkeypatch, fixture scopes, excinfo).
// Assertions cover the emitted code, the ledger decision, and — where semantics
// demand it — executed behavior via the generated runtime.
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@axion-ct/core";
import { createPythonBridgeParser, type PythonBridgeParser } from "@axion-ct/parser-py";
import { createRegistryLookup } from "@axion-ct/registry";
import { PytestToVitestMapper, type TranslatedTestModule } from "../src/test-mapper.js";

async function translateTest(
  source: string,
  filename = "test_mod.py",
): Promise<TranslatedTestModule> {
  const parseResult = await py.parse(source, { filename });
  const unit = { filename, parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename: unit.filename, parseResult: unit.parseResult }]);
  const mapper = new PytestToVitestMapper(unit, {
    graph,
    conftestFixtures: new Map(),
    analyzed: new Map([[unit.filename, unit]]),
    registry: createRegistryLookup(),
  });
  return mapper.translateModule();
}

let py: PythonBridgeParser;

beforeAll(async () => {
  py = await createPythonBridgeParser();
});

describe("pytest→vitest: supported subset", () => {
  it("maps a test function with assert == to it + toEqual", async () => {
    const mod = await translateTest(
      "def test_add():\n    result = 1 + 2\n    assert result == 3\n",
    );
    expect(mod.targetPath).toBe("test_mod.test.ts");
    expect(mod.testNames).toEqual(["test_add"]);
    expect(mod.content).toContain('it("test_add", () => {');
    expect(mod.content).toContain("expect(result).toEqual(3);");
    expect(mod.content).toContain('import { describe, expect, it } from "vitest";');
    const entry = mod.ledger.find((item) => item.rule === "pytest.assert→vitest.expect.toEqual");
    expect(entry?.decision).toBe("deterministic");
  });

  it("maps assert patterns: !=, is, in, ordering, truthiness, isinstance", async () => {
    const mod = await translateTest(
      [
        "def test_patterns():",
        "    xs = [1, 2]",
        "    assert xs != [3]",
        "    assert xs is xs",
        "    assert 1 in xs",
        "    assert 5 not in xs",
        "    assert len(xs) > 1",
        "    assert isinstance(xs, list)",
        "    assert xs",
        "    assert not []",
        "",
      ].join("\n"),
    );
    const content = mod.content;
    expect(content).toContain("expect(xs).not.toEqual([3]);");
    expect(content).toContain("expect(xs).toBe(xs);");
    expect(content).toContain("expect(__ctrans_contains(xs, 1)).toBe(true);");
    expect(content).toContain("expect(__ctrans_contains(xs, 5)).toBe(false);");
    expect(content).toContain("expect(__ctrans_gt(__ctrans_len(xs), 1)).toBe(true);");
    expect(content).toContain("expect(xs).toBeInstanceOf(list);");
    expect(content).toContain("expect(__ctrans_truthy(xs)).toBe(true);");
    expect(content).toContain("expect(__ctrans_truthy([])).toBe(false);");
  });

  it("maps parametrize to it.each with object cases and $-names", async () => {
    const mod = await translateTest(
      [
        "import pytest",
        "",
        "@pytest.mark.parametrize('a, b, expected', [(1, 2, 3), (10, 20, 30)])",
        "def test_add(a, b, expected):",
        "    assert a + b == expected",
        "",
      ].join("\n"),
    );
    // Prettier-formatted output (D-012): the each table is multi-line; assert the
    // structural pieces rather than the raw layout.
    expect(mod.content).toContain("it.each([");
    expect(mod.content).toContain("{ a: 1, b: 2, expected: 3 },");
    expect(mod.content).toContain("{ a: 10, b: 20, expected: 30 },");
    expect(mod.content).toContain('"test_add $a $b $expected"');
    expect(mod.content).toContain("({ a, b, expected }) => {");
    const entry = mod.ledger.find((item) => item.rule === "pytest.parametrize→vitest.each");
    expect(entry?.decision).toBe("semantic");
    expect(mod.testNames).toEqual(["test_add"]);
  });

  it("maps basic function-scoped fixtures to fixture_ functions + let bindings", async () => {
    const mod = await translateTest(
      [
        "import pytest",
        "",
        "@pytest.fixture",
        "def sample():",
        "    return [1, 2]",
        "",
        "def test_uses(sample):",
        "    assert len(sample) == 2",
        "    sample.append(3)",
        "    assert len(sample) == 3",
        "",
      ].join("\n"),
    );
    expect(mod.content).toContain("function fixture_sample() {");
    expect(mod.content).toContain("let sample = fixture_sample();");
    // Reassignment after the binding rebinds (Python semantics), no redeclaration.
    expect(mod.content).toContain('__ctrans_callMethod(sample, "append", 3);');
    expect(mod.content.match(/let sample/g)?.length ?? 0).toBe(1);
  });

  it("maps pytest.raises(E) to expect(fn).toThrow(E)", async () => {
    const mod = await translateTest(
      [
        "import pytest",
        "",
        "def divide(a, b):",
        "    if b == 0:",
        "        raise ValueError('div by 0')",
        "    return a / b",
        "",
        "def test_raises():",
        "    with pytest.raises(ValueError):",
        "        divide(1, 0)",
        "",
      ].join("\n"),
    );
    expect(mod.content).toContain("expect(() => {");
    expect(mod.content).toContain("}).toThrow(ValueError);");
    expect(mod.content).toContain('from "./__ctrans_runtime.ts";');
    expect(mod.content).toContain("ValueError");
    const entry = mod.ledger.find((item) => item.rule === "pytest.raises→vitest.toThrow");
    expect(entry?.decision).toBe("semantic");
  });

  it("maps Test classes without __init__ to describe + it (self dropped)", async () => {
    const mod = await translateTest(
      [
        "class TestCalc:",
        "    def test_one(self):",
        "        assert 1 == 1",
        "",
        "    def test_two(self):",
        "        assert 2 == 2",
        "",
      ].join("\n"),
    );
    expect(mod.content).toContain('describe("TestCalc", () => {');
    expect(mod.content).toContain('it("test_one", () => {');
    expect(mod.testNames).toEqual(["TestCalc.test_one", "TestCalc.test_two"]);
  });

  it("imports source modules through the graph with rewritten specifiers", async () => {
    const parseResult = await py.parse(
      "from calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n",
      { filename: "tests/test_calc.py" },
    );
    const calcParse = await py.parse("def add(a, b):\n    return a + b\n", {
      filename: "tests/calc.py",
    });
    const unit = { filename: "tests/test_calc.py", parseResult, model: analyzeModule(parseResult) };
    const graph = buildModuleGraph([
      { filename: "tests/test_calc.py", parseResult },
      { filename: "tests/calc.py", parseResult: calcParse },
    ]);
    const mapper = new PytestToVitestMapper(unit, {
      graph,
      conftestFixtures: new Map(),
      analyzed: new Map([
        [unit.filename, unit],
        [
          "tests/calc.py",
          { filename: "tests/calc.py", parseResult: calcParse, model: analyzeModule(calcParse) },
        ],
      ]),
      registry: createRegistryLookup(),
    });
    const mod = await mapper.translateModule();
    expect(mod.content).toContain('import { add } from "./calc.ts";');
  });
});

describe("pytest→vitest: unsupported surface (loud, never silent)", () => {
  it("reports monkeypatch as unsupported", async () => {
    const mod = await translateTest(
      [
        "def test_patched(monkeypatch):",
        "    monkeypatch.setattr('os.getcwd', lambda: '/x')",
        "    assert True",
        "",
      ].join("\n"),
    );
    // monkeypatch is not a known fixture → honest per-param report.
    expect(
      mod.unsupported.some(
        (entry) => entry.kind === "fixture" && entry.reason.includes("monkeypatch"),
      ),
    ).toBe(true);
  });

  it("reports fixture scopes/autouse/params as unsupported", async () => {
    const mod = await translateTest(
      [
        "import pytest",
        "",
        "@pytest.fixture(scope='module')",
        "def wide():",
        "    return 1",
        "",
        "@pytest.fixture(autouse=True)",
        "def auto():",
        "    return 2",
        "",
      ].join("\n"),
    );
    expect(mod.unsupported.length).toBe(2);
    expect(mod.unsupported.every((entry) => entry.kind === "fixture")).toBe(true);
    expect(mod.ledger.some((item) => item.warnings.includes("CTW-UNSUPPORTED-FIXTURE"))).toBe(true);
  });

  it("reports raises-as-excinfo and raises-match as unsupported", async () => {
    const mod = await translateTest(
      [
        "import pytest",
        "",
        "def test_excinfo():",
        "    with pytest.raises(ValueError) as excinfo:",
        "        bad()",
        "    assert 'x' in str(excinfo.value)",
        "",
      ].join("\n"),
    );
    expect(
      mod.unsupported.some((entry) => entry.kind === "raises" && entry.reason.includes("excinfo")),
    ).toBe(true);
  });

  it("reports Test classes with __init__ or non-test methods as unsupported", async () => {
    const mod = await translateTest(
      [
        "class TestState:",
        "    def __init__(self):",
        "        self.x = 1",
        "",
        "    def test_x(self):",
        "        assert self.x == 1",
        "",
      ].join("\n"),
    );
    expect(mod.unsupported.some((entry) => entry.kind === "test-class")).toBe(true);
    // The class is NOT emitted (no fake it() that never runs).
    expect(mod.content).not.toContain('it("test_x"');
  });

  it("reports a module with no tests honestly", async () => {
    const mod = await translateTest("def helper():\n    return 1\n", "test_empty.py");
    expect(mod.unsupported.some((entry) => entry.kind === "module")).toBe(true);
    expect(mod.testNames).toEqual([]);
  });
});
